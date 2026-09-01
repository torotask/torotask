---
"@torotask/bull-board": minor
---

### Bull Board adapter for ToroTask

**New `@torotask/bull-board` package**: Adds `ToroTaskBullMQAdapter`, a Bull Board adapter that hydrates external step state and data refs for display in the job UI.

**External data ref resolution**: Resolves `ToroTaskDataRef` values from the ToroTask data store when enriching jobs. Job lists keep compact ref labels; opening a job detail view loads the full values.

**Lazy hydration and truncation**: Keeps data refs compact in job list responses while resolving them on the detail view. Custom formatters are chained after ref formatting. Optional truncation for large inline values with per-request `showFullData` support.
