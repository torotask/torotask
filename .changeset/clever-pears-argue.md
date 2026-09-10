---
'torotask': minor
---

Reclaim step state and data-store blobs left behind by `removeOnComplete` / `removeOnFail`

BullMQ trims finished jobs from inside Lua and never emits a `removed` event, so cleanup wired
only to those events never ran for the dominant removal path. Step-state hashes and externalized
data blobs accumulated indefinitely.

Cleanup is now a periodic sweep rather than inline work on the completion path.

**Added**

- `maintenance.orphanCleanup` client option. Enabled by default, it registers a built-in
  `torotask.maintenance` task group containing an `orphanCleanup` task on an hourly cron trigger.
  BullMQ job schedulers are idempotent across processes, so the sweep runs once per cluster with
  no leader election. Accepts `false` to disable, or `{ enabled, cron, maxDeletions, maxDurationMs }`.
  The group is registered by `TaskServer.start()` rather than by the constructor, so read-only
  clients open no extra connections, and it is started regardless of any group filter so that
  sharding workers by group cannot leave the cluster with nobody sweeping.
- `ToroTask.cleanupOrphanedJobArtifacts(options?)` runs a sweep on demand regardless of that
  setting, returning `{ removed, scanned, skipped, truncated }`. Use it if you would rather drive
  cleanup from external ops tooling. Bounded by `maxDeletions` (default 10,000) and
  `maxDurationMs` (default 60,000); sweeps are idempotent, so a truncated run is resumed by the next one.
- Data stores now record the referring parent job and a creation timestamp for externalized values,
  via `ToroTaskDataStoreContext.referrerJobKey` and `ToroTaskDataStore.readJobMeta()`. BullMQ copies
  a child's return value into the parent's `processed` hash, which outlives the child, so a blob is
  only reclaimed once its referrer is gone too. Custom data stores that do not implement
  `readJobMeta` keep the previous behaviour.
- `minArtifactAgeMs` (default 3,600,000) retains orphaned data blobs until they are older than the
  window. BullMQ also writes the externalized return-value ref into the queue's `completed` event
  stream, so a lagging or resuming `QueueEvents` consumer can still hold a ref after both the job
  and its parent are gone. Set to `0` to reclaim as soon as a blob looks orphaned.

**Changed**

- `ToroTaskStepStateStoreOptions.orphanTtlSeconds` is now documented as a backstop. Step state is
  normally reclaimed when the job record is removed, either explicitly or by the sweep.

**Notes**

- Cleanup fails closed throughout: unreadable `EXISTS` replies, failed referrer lookups, and
  unconfirmed queue prefixes all defer deletion to a later sweep rather than guessing.

- The sweep confirms each queue's key prefix via its `meta` key before deleting anything, and
  skips queues it cannot confirm, so queues created with a custom `prefix` are left alone.
- Existing orphans are not removed until the first sweep runs. Call
  `cleanupOrphanedJobArtifacts()` to reclaim them immediately.
