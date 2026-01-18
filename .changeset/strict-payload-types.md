---
"torotask": minor
---

### Improved Type Safety for Task Payloads

**Strict payload types for `runFlows` methods**: Removed generic type parameters from `runFlow`, `runFlowStateless`, `runFlows`, and `runFlowsStateless` to enforce strict excess property checking. TypeScript will now error when extra undeclared keys are passed in payloads.

**Fixed context type inference**: Resolved issues with `getTaskContext` returning incorrect inferred types.

**New `waitForResult` and `getResult` helpers**: Added helper methods to `TaskJob` for retrieving typed results from child tasks.

**Improved error recovery for `runTaskAndWait`**: Child job can now be properly recovered if retried.

**Step error state no longer persisted**: Steps no longer store error state, making retries cleaner and more predictable.

**Fixed job queue instantiation**: Resolved issue with loading jobs from cache when queue wasn't properly instantiated.
