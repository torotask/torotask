import type { Logger } from 'pino';
import type { ToroTask } from '../client.js';
import type { ToroTaskDataStore } from '../data-store/base-data-store.js';
import type { ToroTaskDataJobMeta } from '../types/data-store.js';

const EXISTS_PIPELINE_CHUNK = 100;
const SCAN_COUNT = 200;

/** Default cap on artifacts removed per sweep, so one run cannot monopolise Redis. */
export const DEFAULT_SWEEP_MAX_DELETIONS = 10_000;
/** Default wall-clock cap for a sweep. */
export const DEFAULT_SWEEP_MAX_DURATION_MS = 60_000;
/**
 * Default minimum age before an orphaned data blob may be deleted.
 *
 * BullMQ writes a job's externalized return-value ref into the queue's `completed`
 * event stream as well as into any parent's `processed` hash. A `QueueEvents` consumer
 * that is lagging, restarting, or resuming from an old stream id can still be holding
 * a ref after both the job and its parent are gone, so blobs are retained for a window
 * rather than deleted the moment they look unreferenced.
 */
export const DEFAULT_SWEEP_MIN_ARTIFACT_AGE_MS = 3_600_000;

/**
 * Whether a job hash exists.
 *
 * `unknown` is returned whenever Redis did not give us a definitive answer (command
 * error, dropped connection, malformed pipeline reply). Cleanup treats `unknown`
 * exactly like `present`: it never deletes on a guess.
 */
export type Presence = 'present' | 'absent' | 'unknown';

interface PipelineLike {
  exists: (key: string) => unknown;
  exec: () => Promise<Array<[Error | null, unknown]> | null>;
}

interface ScanStreamLike extends AsyncIterable<string[]> {
  destroy?: () => void;
}

/** Minimal Redis surface used by cleanup, so tests can supply a fake. */
export interface RedisCleanupClient {
  pipeline: () => PipelineLike;
  scanStream: (opts: { match: string; count: number }) => ScanStreamLike;
}

export interface JobRef {
  queueName: string;
  jobId: string;
}

/** BullMQ job hash key. */
export function jobHashKey(queuePrefix: string, queueName: string, jobId: string): string {
  return `${queuePrefix}:${queueName}:${jobId}`;
}

/** Escapes Redis SCAN MATCH glob metacharacters. */
export function escapeRedisGlob(value: string): string {
  return value.replace(/[\\*?[\]]/g, '\\$&');
}

function parseQueueJobId(prefix: string, key: string): JobRef | undefined {
  if (!key.startsWith(prefix)) {
    return undefined;
  }
  const rest = key.slice(prefix.length);
  const separator = rest.indexOf(':');
  if (separator <= 0 || separator === rest.length - 1) {
    return undefined;
  }
  return {
    queueName: rest.slice(0, separator),
    jobId: rest.slice(separator + 1),
  };
}

export function collectJobEntries(keys: string[], prefix: string, queueName?: string): JobRef[] {
  const entries: JobRef[] = [];
  for (const key of keys) {
    if (queueName) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      const jobId = key.slice(prefix.length);
      if (jobId) {
        entries.push({ queueName, jobId });
      }
      continue;
    }
    const parsed = parseQueueJobId(prefix, key);
    if (parsed) {
      entries.push(parsed);
    }
  }
  return entries;
}

/**
 * Batched `EXISTS`, failing closed.
 *
 * ioredis pipeline replies are `[error, value]` tuples; the error slot must be
 * inspected, otherwise a transient command failure reads as "key absent" and cleanup
 * happily deletes live artifacts. Any reply we cannot positively interpret maps to
 * `unknown`, which is never safe to delete on.
 */
export async function jobPresence(
  redis: RedisCleanupClient,
  jobKeys: string[],
): Promise<Map<string, Presence>> {
  const presence = new Map<string, Presence>();
  const unique = [...new Set(jobKeys)];

  for (let i = 0; i < unique.length; i += EXISTS_PIPELINE_CHUNK) {
    const chunk = unique.slice(i, i + EXISTS_PIPELINE_CHUNK);

    let results: Array<[Error | null, unknown]> | null = null;
    try {
      const pipeline = redis.pipeline();
      for (const key of chunk) {
        pipeline.exists(key);
      }
      results = await pipeline.exec();
    }
    catch {
      results = null;
    }

    chunk.forEach((key, index) => {
      const entry = results?.[index];
      // Fail closed on anything we cannot read as a definite integer reply: a null
      // pipeline, a short reply array, a per-command error, or a non-numeric value.
      if (!Array.isArray(entry) || entry[0]) {
        presence.set(key, 'unknown');
        return;
      }
      // `EXISTS <one key>` is specified to reply with the integer 0 or 1. Coercing
      // anything else would quietly turn null, '', false or a negative into `absent`
      // and authorise a delete, so accept only the two replies the command can make.
      const count = entry[1];
      if (count !== 0 && count !== 1) {
        presence.set(key, 'unknown');
        return;
      }
      presence.set(key, count === 1 ? 'present' : 'absent');
    });
  }

  return presence;
}

/** Why a job's data blobs may not be dropped yet. */
type BlobDecision = { allow: true } | { allow: false; reason: string; detail: Record<string, unknown> };

/**
 * Decides whether a job's data blobs can be deleted.
 *
 * Single source of truth for that question. Both the periodic sweep and the explicit
 * removal paths route through here: when the two had their own copies of the rule they
 * drifted, and the divergence was a data-loss bug each time.
 *
 * `meta` and `referrerPresence` may be supplied by a caller that has already batched
 * those reads; otherwise they are fetched. A throw propagates, and every caller treats
 * that as "defer", so an unreadable answer never authorises a delete.
 */
async function dataBlobDecision(args: {
  redis: RedisCleanupClient;
  dataStore: ToroTaskDataStore;
  queueName: string;
  jobId: string;
  minArtifactAgeMs: number;
  meta?: ToroTaskDataJobMeta;
  referrerPresence?: Map<string, Presence>;
}): Promise<BlobDecision> {
  const { redis, dataStore, queueName, jobId, minArtifactAgeMs } = args;
  let meta = args.meta ?? (await dataStore.readJobMeta(queueName, jobId));

  // Written before metadata tracking existed. Stamp it now so it ages out on a later
  // run rather than being deleted immediately on the first sweep after an upgrade,
  // when its `completed` event may still be unread.
  if (meta.createdAt === undefined && minArtifactAgeMs > 0) {
    await dataStore.markJobMetaSeen(queueName, jobId);
    meta = await dataStore.readJobMeta(queueName, jobId);
    if (meta.createdAt !== undefined) {
      return { allow: false, reason: 'metadata predates tracking; stamped for a later sweep', detail: {} };
    }
  }

  // BullMQ also puts the externalized ref in the queue's `completed` event, so a lagging
  // or resumed QueueEvents consumer can still hold one after the job and its parent are
  // gone. Hold the blob until the event is old enough to be considered unconsumable.
  if (meta.createdAt !== undefined && Date.now() - meta.createdAt < minArtifactAgeMs) {
    return { allow: false, reason: 'within retention window', detail: { createdAt: meta.createdAt } };
  }

  // A parent's `processed` hash outlives the child that wrote into it.
  if (meta.referrerJobKey) {
    const presence
      = args.referrerPresence?.get(meta.referrerJobKey)
        ?? (await jobPresence(redis, [meta.referrerJobKey])).get(meta.referrerJobKey);
    if (presence !== 'absent') {
      return { allow: false, reason: 'referrer job still holds a ref', detail: { referrer: meta.referrerJobKey, presence } };
    }
  }

  return { allow: true };
}

/**
 * Clears external step state and, when permitted, data-store blobs for a job.
 *
 * Both stores are cleared independently via `allSettled` so a failure in one does
 * not silently skip the other, and so a single bad key cannot abort a sweep.
 *
 * @returns the number of stores actually cleared.
 */
export async function clearJobArtifacts(
  taskClient: ToroTask,
  queueName: string,
  jobId: string,
  options?: { logger?: Logger; respectReferrer?: boolean; minArtifactAgeMs?: number },
): Promise<number> {
  const logger = options?.logger;
  const dataStore = taskClient.getDataStore();

  const tasks: Array<Promise<boolean>> = [
    taskClient
      .getStepStateStore()
      .clearJob(queueName, jobId)
      .then(() => true),
  ];

  if (dataStore) {
    tasks.push(
      (async () => {
        if (options?.respectReferrer) {
          const decision = await dataBlobDecision({
            redis: taskClient.redis as unknown as RedisCleanupClient,
            dataStore,
            queueName,
            jobId,
            // An explicit removal makes the job vanish, but it does not reach into the
            // `completed` stream to retract the ref, so the same window applies here.
            // The index survives, so the periodic sweep reclaims these once they age out.
            minArtifactAgeMs: options.minArtifactAgeMs ?? taskClient.getOrphanCleanupOptions().minArtifactAgeMs,
          });
          if (!decision.allow) {
            logger?.debug({ queueName, jobId, ...decision.detail }, `Deferring data-store cleanup: ${decision.reason}`);
            return false;
          }
        }
        await dataStore.clearJob(queueName, jobId);
        return true;
      })(),
    );
  }

  const results = await Promise.allSettled(tasks);
  let cleared = 0;
  for (const result of results) {
    if (result.status === 'rejected') {
      logger?.warn({ err: result.reason, queueName, jobId }, 'Failed to clear job artifacts');
      continue;
    }
    if (result.value) {
      cleared++;
    }
  }
  return cleared;
}

export interface OrphanSweepOptions {
  /** Limit the sweep to one queue. Omit to sweep every queue. */
  queueName?: string;
  /** Stop after removing this many artifacts. @default 10000 */
  maxDeletions?: number;
  /** Stop after this many milliseconds. @default 60000 */
  maxDurationMs?: number;
  /**
   * Retain data blobs younger than this, even when they look orphaned.
   * @default 3600000
   */
  minArtifactAgeMs?: number;
  logger?: Logger;
}

export interface OrphanSweepResult {
  /** Artifacts deleted (step-state hashes plus data-store job index groups). */
  removed: number;
  /** Candidate keys inspected. */
  scanned: number;
  /**
   * Candidates deliberately left alone: job still present, presence unknown,
   * a live referrer still holds a ref, or the queue's key prefix could not be confirmed.
   */
  skipped: number;
  /** True when a budget limit stopped the sweep before the keyspace was exhausted. */
  truncated: boolean;
}

class SweepBudget {
  removed = 0;
  scanned = 0;
  skipped = 0;
  truncated = false;
  private readonly deadline: number;

  constructor(
    private readonly maxDeletions: number,
    maxDurationMs: number,
  ) {
    this.deadline = Date.now() + maxDurationMs;
  }

  get exhausted(): boolean {
    if (this.removed >= this.maxDeletions || Date.now() >= this.deadline) {
      this.truncated = true;
      return true;
    }
    return false;
  }
}

async function forEachScanBatch(
  redis: RedisCleanupClient,
  pattern: string,
  budget: SweepBudget,
  handler: (keys: string[]) => Promise<void>,
): Promise<void> {
  const stream = redis.scanStream({ match: pattern, count: SCAN_COUNT });
  for await (const batch of stream) {
    if (batch.length > 0) {
      await handler(batch);
    }
    if (budget.exhausted) {
      stream.destroy?.();
      break;
    }
  }
}

/**
 * Confirms which key prefix a queue's job hashes live under.
 *
 * `TaskQueue`/`TaskWorker` honour a caller-supplied `prefix`, so the client's
 * `queuePrefix` is an assumption, not a fact. Probing the queue's `meta` key turns it
 * into a fact. When the meta key is absent we cannot tell "queue lives elsewhere"
 * from "queue was obliterated", so we decline to sweep it rather than risk deleting
 * artifacts belonging to live jobs under a different prefix.
 */
async function resolveQueuePrefix(
  taskClient: ToroTask,
  redis: RedisCleanupClient,
  queueName: string,
  cache: Map<string, string | undefined>,
): Promise<string | undefined> {
  if (cache.has(queueName)) {
    return cache.get(queueName);
  }
  const prefix = taskClient.queuePrefix;
  const metaKey = `${prefix}:${queueName}:meta`;
  const presence = (await jobPresence(redis, [metaKey])).get(metaKey);
  const resolved = presence === 'present' ? prefix : undefined;
  cache.set(queueName, resolved);
  return resolved;
}

interface SweepContext {
  taskClient: ToroTask;
  redis: RedisCleanupClient;
  minArtifactAgeMs: number;
  queueName?: string;
  prefixCache: Map<string, string | undefined>;
  logger?: Logger;
}

/**
 * Resolves each entry's job hash key and its presence, dropping entries whose queue
 * prefix cannot be confirmed.
 */
async function classifyBatch(
  ctx: SweepContext,
  entries: JobRef[],
  budget: SweepBudget,
): Promise<JobRef[]> {
  const withKeys: Array<JobRef & { jobKey: string }> = [];

  for (const entry of entries) {
    budget.scanned++;
    const prefix = await resolveQueuePrefix(ctx.taskClient, ctx.redis, entry.queueName, ctx.prefixCache);
    if (!prefix) {
      budget.skipped++;
      ctx.logger?.debug(
        { queueName: entry.queueName },
        'Skipping orphan cleanup: queue prefix could not be confirmed',
      );
      continue;
    }
    withKeys.push({ ...entry, jobKey: jobHashKey(prefix, entry.queueName, entry.jobId) });
  }

  if (withKeys.length === 0) {
    return [];
  }

  const presence = await jobPresence(ctx.redis, withKeys.map(entry => entry.jobKey));
  const absent: JobRef[] = [];
  for (const entry of withKeys) {
    if (presence.get(entry.jobKey) === 'absent') {
      absent.push({ queueName: entry.queueName, jobId: entry.jobId });
    }
    else {
      budget.skipped++;
    }
  }
  return absent;
}

/**
 * Step state is pure execution scratch, written only by a job that is already
 * running. It can never predate its job hash, so "job gone" always means
 * "state is garbage".
 */
async function sweepStepState(ctx: SweepContext, budget: SweepBudget): Promise<void> {
  const stepStore = ctx.taskClient.getStepStateStore();
  const prefix = ctx.queueName ? stepStore.jobKeysPrefix(ctx.queueName) : stepStore.keysPrefix();

  await forEachScanBatch(ctx.redis, `${escapeRedisGlob(prefix)}*`, budget, async (keys) => {
    const entries = collectJobEntries(keys, prefix, ctx.queueName);
    const absent = await classifyBatch(ctx, entries, budget);

    for (const entry of absent) {
      try {
        await stepStore.clearJob(entry.queueName, entry.jobId);
        budget.removed++;
      }
      catch (err) {
        budget.skipped++;
        ctx.logger?.warn({ err, ...entry }, 'Failed to clear orphaned step state');
      }
      if (budget.exhausted) {
        return;
      }
    }
  });
}

/**
 * Data blobs may outlive their own job: BullMQ copies a child's return value into
 * `<parentKey>:processed`, so a surviving parent still holds the ref. Deletion
 * therefore requires the job *and* any recorded referrer to be gone. Deferred blobs
 * are reclaimed by a later sweep once the parent is trimmed.
 */
async function sweepDataBlobs(ctx: SweepContext, budget: SweepBudget): Promise<void> {
  const dataStore = ctx.taskClient.getDataStore();
  if (!dataStore) {
    return;
  }
  const prefix = ctx.queueName ? dataStore.jobIndexKeysPrefix(ctx.queueName) : dataStore.indexKeysPrefix();

  await forEachScanBatch(ctx.redis, `${escapeRedisGlob(prefix)}*`, budget, async (keys) => {
    const entries = collectJobEntries(keys, prefix, ctx.queueName);
    const absent = await classifyBatch(ctx, entries, budget);
    if (absent.length === 0) {
      return;
    }

    // A failed metadata read must not read as "no referrer": that would authorise
    // deleting a blob whose parent is still holding the ref. Unreadable => defer.
    const metas = await Promise.all(
      absent.map(async (entry): Promise<{ ok: true; meta: ToroTaskDataJobMeta } | { ok: false; err: unknown }> => {
        try {
          return { ok: true, meta: await dataStore.readJobMeta(entry.queueName, entry.jobId) };
        }
        catch (err) {
          return { ok: false, err };
        }
      }),
    );
    const referrerPresence = await jobPresence(
      ctx.redis,
      metas.flatMap(result => (result.ok && result.meta.referrerJobKey ? [result.meta.referrerJobKey] : [])),
    );

    for (const [index, entry] of absent.entries()) {
      const result = metas[index]!;
      if (!result.ok) {
        budget.skipped++;
        ctx.logger?.warn({ err: result.err, ...entry }, 'Deferring orphaned data blob: metadata lookup failed');
        continue;
      }

      let decision: BlobDecision;
      try {
        decision = await dataBlobDecision({
          redis: ctx.redis,
          dataStore,
          queueName: entry.queueName,
          jobId: entry.jobId,
          minArtifactAgeMs: ctx.minArtifactAgeMs,
          meta: result.meta,
          referrerPresence,
        });
      }
      catch (err) {
        budget.skipped++;
        ctx.logger?.warn({ err, ...entry }, 'Deferring orphaned data blob: retention check failed');
        continue;
      }

      if (!decision.allow) {
        budget.skipped++;
        ctx.logger?.debug({ ...entry, ...decision.detail }, `Deferring orphaned data blob: ${decision.reason}`);
        continue;
      }

      try {
        await dataStore.clearJob(entry.queueName, entry.jobId);
        budget.removed++;
      }
      catch (err) {
        budget.skipped++;
        ctx.logger?.warn({ err, ...entry }, 'Failed to clear orphaned data blobs');
      }
      if (budget.exhausted) {
        return;
      }
    }
  });
}

/**
 * Removes step-state hashes and data-store blobs whose BullMQ job record no longer exists.
 *
 * This is the only mechanism that covers jobs dropped by `removeOnComplete` /
 * `removeOnFail`: BullMQ trims those inside Lua and never emits a `removed` event, so
 * listener-based cleanup never sees them.
 *
 * Intended to run periodically and cluster-wide (see the built-in orphan-cleanup
 * maintenance task) rather than on every job completion. It is idempotent and budgeted,
 * so anything skipped is simply retried on the next run.
 */
export async function cleanupOrphanedJobArtifacts(
  taskClient: ToroTask,
  options?: OrphanSweepOptions,
): Promise<OrphanSweepResult> {
  const budget = new SweepBudget(
    options?.maxDeletions ?? DEFAULT_SWEEP_MAX_DELETIONS,
    options?.maxDurationMs ?? DEFAULT_SWEEP_MAX_DURATION_MS,
  );

  const ctx: SweepContext = {
    taskClient,
    redis: taskClient.redis as unknown as RedisCleanupClient,
    minArtifactAgeMs: options?.minArtifactAgeMs ?? DEFAULT_SWEEP_MIN_ARTIFACT_AGE_MS,
    queueName: options?.queueName,
    prefixCache: new Map(),
    logger: options?.logger,
  };

  await sweepStepState(ctx, budget);
  if (!budget.exhausted) {
    await sweepDataBlobs(ctx, budget);
  }

  return {
    removed: budget.removed,
    scanned: budget.scanned,
    skipped: budget.skipped,
    truncated: budget.truncated,
  };
}

/**
 * Wires cleanup for *explicit* job removal (`queue.remove`, `queue.clean`), which does
 * emit local Queue events.
 *
 * Deliberately not wired to `QueueEvents`: that is a Redis-stream consumer with real
 * delivery latency, and acting on a delayed `removed` message means deleting artifacts
 * long after the fact with no way to confirm they still belong to the removed job.
 * Anything missed here is picked up by {@link cleanupOrphanedJobArtifacts}.
 */
export function setupJobArtifactCleanupListeners(
  taskClient: ToroTask,
  queueName: string,
  logger: Logger,
  sources: {
    queue?: {
      on: ((event: 'removed', listener: (jobOrId: string | { id?: string }) => void) => void)
        & ((event: 'cleaned', listener: (jobIds: string[]) => void) => void);
    };
  },
): void {
  const clearForJobId = (jobId: string): void => {
    // respectReferrer: an explicitly removed child may still be referenced by a
    // surviving parent's `processed` hash.
    clearJobArtifacts(taskClient, queueName, jobId, { logger, respectReferrer: true }).catch((err) => {
      logger.warn({ err, jobId }, 'Failed to clear job artifacts after removal');
    });
  };

  if (!sources.queue) {
    return;
  }

  sources.queue.on('removed', (jobOrId: string | { id?: string }) => {
    const jobId = typeof jobOrId === 'string' ? jobOrId : jobOrId.id;
    if (jobId) {
      clearForJobId(jobId);
    }
  });

  sources.queue.on('cleaned', (jobIds: string[]) => {
    for (const jobId of jobIds) {
      clearForJobId(jobId);
    }
  });
}
