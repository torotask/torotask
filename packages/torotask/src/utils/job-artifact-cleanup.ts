import type { Logger } from 'pino';
import type { ToroTask } from '../client.js';

const EXISTS_PIPELINE_CHUNK = 100;
const SCAN_COUNT = 200;

interface OrphanCleanupState {
  timer?: ReturnType<typeof setTimeout>;
  firstScheduledAt: number;
  inFlight?: Promise<void>;
}

/** Per-client so multiple ToroTask instances (tests, multi-tenant) do not clobber each other. */
const orphanCleanupState = new WeakMap<ToroTask, OrphanCleanupState>();

function getCleanupState(taskClient: ToroTask): OrphanCleanupState {
  let state = orphanCleanupState.get(taskClient);
  if (!state) {
    state = { firstScheduledAt: 0 };
    orphanCleanupState.set(taskClient, state);
  }
  return state;
}

export function jobHashKey(taskClient: ToroTask, queueName: string, jobId: string): string {
  return `${taskClient.queuePrefix}:${queueName}:${jobId}`;
}

/** Escapes Redis SCAN MATCH glob metacharacters. */
export function escapeRedisGlob(value: string): string {
  return value.replace(/[\\*?[\]]/g, '\\$&');
}

function parseQueueJobId(prefix: string, key: string): { queueName: string; jobId: string } | undefined {
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

function collectJobEntries(
  keys: string[],
  prefix: string,
  queueName?: string,
): Array<{ queueName: string; jobId: string }> {
  const entries: Array<{ queueName: string; jobId: string }> = [];
  for (const key of keys) {
    if (queueName) {
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

interface RedisScanClient {
  exists: (key: string) => Promise<number>;
  hget?: (key: string, field: string) => Promise<string | null>;
  pipeline?: () => {
    exists: (key: string) => unknown;
    hget?: (key: string, field: string) => unknown;
    exec: () => Promise<Array<[Error | null, unknown]> | null>;
  };
  scanStream: (opts: { match: string; count: number }) => {
    on: (event: string, listener: (...args: any[]) => void) => void;
  };
}

async function scanKeys(redis: RedisScanClient, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  const stream = redis.scanStream({ match: pattern, count: SCAN_COUNT });

  return new Promise((resolve, reject) => {
    stream.on('data', (batch: string[]) => {
      keys.push(...batch);
    });
    stream.on('end', () => resolve(keys));
    stream.on('error', (err: Error) => reject(err));
  });
}

async function missingJobHashKeys(
  redis: RedisScanClient,
  jobKeys: string[],
): Promise<Set<string>> {
  const missing = new Set<string>();

  for (let i = 0; i < jobKeys.length; i += EXISTS_PIPELINE_CHUNK) {
    const chunk = jobKeys.slice(i, i + EXISTS_PIPELINE_CHUNK);
    if (typeof redis.pipeline === 'function') {
      const pipeline = redis.pipeline()!;
      for (const key of chunk) {
        pipeline.exists(key);
      }
      const results = await pipeline.exec();
      results?.forEach((result, index) => {
        const count = Array.isArray(result) ? result[1] : 0;
        if (!count) {
          missing.add(chunk[index]!);
        }
      });
    }
    else {
      for (const key of chunk) {
        if (!(await redis.exists(key))) {
          missing.add(key);
        }
      }
    }
  }

  return missing;
}

/**
 * State of a BullMQ job hash right after we finished it.
 *
 * - `missing`  – trimmed by removeOnComplete/removeOnFail; all artifacts are safe to drop.
 * - `finished` – retained with a `finishedOn` timestamp; execution scratch is safe to drop.
 * - `restarted` – the hash exists but has no `finishedOn`, meaning a *different* run reused
 *   this job id (deterministic ids via `idFromPayload`). Its artifacts must be left alone.
 */
export type JobRecordState = 'missing' | 'finished' | 'restarted';

/**
 * Reads job existence and `finishedOn` in a single round trip so cleanup cannot
 * delete artifacts belonging to a re-added job that reused the same id.
 */
export async function readJobRecordState(
  taskClient: ToroTask,
  queueName: string,
  jobId: string,
): Promise<JobRecordState> {
  const redis = taskClient.redis as unknown as RedisScanClient;
  const key = jobHashKey(taskClient, queueName, jobId);

  if (typeof redis.pipeline === 'function' && typeof redis.hget === 'function') {
    const pipeline = redis.pipeline()!;
    pipeline.exists(key);
    pipeline.hget!(key, 'finishedOn');
    const results = await pipeline.exec();
    const exists = Array.isArray(results?.[0]) ? results![0]![1] : 0;
    const finishedOn = Array.isArray(results?.[1]) ? results![1]![1] : null;
    if (!exists) {
      return 'missing';
    }
    return finishedOn ? 'finished' : 'restarted';
  }

  if (!(await redis.exists(key))) {
    return 'missing';
  }
  const finishedOn = redis.hget ? await redis.hget(key, 'finishedOn') : 'unknown';
  return finishedOn ? 'finished' : 'restarted';
}

/**
 * Clears external step state and data-store blobs for a job.
 */
export async function clearJobArtifacts(
  taskClient: ToroTask,
  queueName: string,
  jobId: string,
): Promise<void> {
  await taskClient.getStepStateStore().clear(queueName, jobId);
  await taskClient.getDataStore()?.clearJob(queueName, jobId);
}

/**
 * Removes step-state hashes and data-store blobs whose BullMQ job record no longer exists.
 *
 * This covers jobs silently dropped by `removeOnComplete` / `removeOnFail`, which do not emit
 * Queue `removed` events. When `queueName` is omitted, every queue is scanned.
 */
export async function cleanupOrphanedJobArtifacts(
  taskClient: ToroTask,
  queueName?: string,
): Promise<number> {
  const redis = taskClient.redis as unknown as RedisScanClient;
  const stepStore = taskClient.getStepStateStore();
  const dataStore = taskClient.getDataStore();
  let removed = 0;

  const stepPrefix = queueName
    ? stepStore.jobKeysPrefix(queueName)
    : stepStore.keysPrefix();
  const stepJobs = collectJobEntries(
    await scanKeys(redis, `${escapeRedisGlob(stepPrefix)}*`),
    stepPrefix,
    queueName,
  );

  const missingStepJobs = await missingJobHashKeys(
    redis,
    stepJobs.map(entry => jobHashKey(taskClient, entry.queueName, entry.jobId)),
  );

  for (const entry of stepJobs) {
    if (missingStepJobs.has(jobHashKey(taskClient, entry.queueName, entry.jobId))) {
      await stepStore.clear(entry.queueName, entry.jobId);
      removed++;
    }
  }

  if (dataStore) {
    const indexPrefix = queueName
      ? dataStore.jobIndexKeysPrefix(queueName)
      : dataStore.indexKeysPrefix();
    const indexJobs = collectJobEntries(
      await scanKeys(redis, `${escapeRedisGlob(indexPrefix)}*`),
      indexPrefix,
      queueName,
    );

    const missingIndexJobs = await missingJobHashKeys(
      redis,
      indexJobs.map(entry => jobHashKey(taskClient, entry.queueName, entry.jobId)),
    );

    for (const entry of indexJobs) {
      if (missingIndexJobs.has(jobHashKey(taskClient, entry.queueName, entry.jobId))) {
        await dataStore.clearJob(entry.queueName, entry.jobId);
        removed++;
      }
    }
  }

  return removed;
}

/**
 * Debounced orphan sweep so completion bursts do not SCAN the keyspace per job.
 * A busy client still sweeps at least once per configured interval, because the
 * max-wait deadline caps how far the trailing edge can be pushed out.
 *
 * No-op when `orphanCleanup.enabled` is false; use
 * {@link ToroTask.cleanupOrphanedJobArtifacts} from a cron/ops job instead.
 */
export function scheduleOrphanedArtifactCleanup(
  taskClient: ToroTask,
  logger?: Logger,
): void {
  const { enabled, intervalMs } = taskClient.getOrphanCleanupOptions();
  if (!enabled) {
    return;
  }

  const state = getCleanupState(taskClient);
  const now = Date.now();
  if (!state.firstScheduledAt) {
    state.firstScheduledAt = now;
  }

  const dueIn = Math.max(0, state.firstScheduledAt + intervalMs - now);
  const delay = Math.min(intervalMs, dueIn);

  if (state.timer) {
    clearTimeout(state.timer);
  }

  state.timer = setTimeout(() => {
    state.timer = undefined;
    state.firstScheduledAt = 0;

    const run = (): void => {
      state.inFlight = cleanupOrphanedJobArtifacts(taskClient)
        .then(() => undefined)
        .catch((err) => {
          logger?.warn({ err }, 'Failed to clean up orphaned job artifacts');
        })
        .finally(() => {
          state.inFlight = undefined;
        });
    };

    // Never overlap sweeps; a slow SCAN must not stack up behind itself.
    if (state.inFlight) {
      void state.inFlight.then(run, run);
      return;
    }
    run();
  }, delay);

  state.timer.unref?.();
}

/** Cancels any pending sweep, e.g. during {@link ToroTask.close}. */
export function cancelOrphanedArtifactCleanup(taskClient: ToroTask): void {
  const state = orphanCleanupState.get(taskClient);
  if (!state) {
    return;
  }
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }
  state.firstScheduledAt = 0;
}

interface RemovedEventArgs { jobId?: string }

/**
 * Wires cleanup for explicit job removal (`queue.remove`, `queue.clean`) and
 * Redis stream `removed` events (deduplication, etc.).
 *
 * Note: BullMQ does **not** emit `removed` when `removeOnComplete` / `removeOnFail`
 * trims finished jobs. That path is handled by completion-time cleanup plus
 * {@link cleanupOrphanedJobArtifacts}.
 */
export function setupJobArtifactCleanupListeners(
  taskClient: ToroTask,
  queueName: string,
  logger: Logger,
  sources: {
    queue?: { on: ((event: 'removed', listener: (jobOrId: string | { id?: string }) => void) => void) & ((event: 'cleaned', listener: (jobIds: string[]) => void) => void) };
    queueEvents?: { on: (event: 'removed', listener: (args: RemovedEventArgs) => void) => void };
  },
): void {
  const clearForJobId = (jobId: string) => {
    clearJobArtifacts(taskClient, queueName, jobId).catch((err) => {
      logger.warn({ err, jobId }, 'Failed to clear job artifacts after removal');
    });
  };

  if (sources.queue) {
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

  if (sources.queueEvents) {
    sources.queueEvents.on('removed', (args: RemovedEventArgs) => {
      if (args.jobId) {
        clearForJobId(args.jobId);
      }
    });
  }
}
