---
"torotask": minor
---

### External step state and pluggable data store

**Step state moved out of `job.data`**: Step memoization and recovery state is now stored in per-step Redis hashes instead of the BullMQ job blob, eliminating quadratic write amplification on retries. State is cleared when jobs are removed, not on completion.

**Pluggable step state store**: Introduced `ToroTaskStepStateStore` with a configurable Redis backend (`RedisStepStateStore`) and client hooks to customize storage.

**Opt-in external data store**: Large payloads, return values, and step results can be externalized to Redis via `ToroTaskDataStore`, replacing inline values with compact `ToroTaskDataRef` markers so BullMQ job hashes and parent processed sets stay small. Supports `large` and `all` modes with optional compression.

**Queue metadata fix**: Read-only client and dashboard queue connections now use `skipMetasUpdate` so `streams.events.maxLen` configured at worker startup is not reset to defaults.
