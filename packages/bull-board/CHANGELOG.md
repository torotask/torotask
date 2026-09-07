# @torotask/bull-board

## 1.0.1

### Patch Changes

- ### Bull Board 9.x compatibility and flow visualization ([#39](https://github.com/torotask/torotask/pull/39)) ([`b53ad1c`](https://github.com/torotask/torotask/commit/b53ad1cc3eabe13e33a22841c1ebd424af3f4bdd))

- Add version-compat shims for Bull Board 8.x/9.x adapter APIs (rate limits, queue listing) so the adapter works when the host app upgrades Bull Board without duplicate `@bull-board/api` resolution issues
- Patch `FlowProducer` child-key parsing so Bull Board flow trees work with ToroTask's multi-segment queue prefix (`torotask:tasks`)
- Bump peer dependency to `@bull-board/api` `>=8.6.0 <10`

## 1.0.0

### Minor Changes

- ### Bull Board adapter for ToroTask ([#37](https://github.com/torotask/torotask/pull/37)) ([`51a5038`](https://github.com/torotask/torotask/commit/51a503829d9927576ec5f16c3e2b60aa53d1e856))

**New `@torotask/bull-board` package**: Adds `ToroTaskBullMQAdapter`, a Bull Board adapter that hydrates external step state and data refs for display in the job UI.

**External data ref resolution**: Resolves `ToroTaskDataRef` values from the ToroTask data store when enriching jobs. Job lists keep compact ref labels; opening a job detail view loads the full values.

**Lazy hydration and truncation**: Keeps data refs compact in job list responses while resolving them on the detail view. Custom formatters are chained after ref formatting. Optional truncation for large inline values with per-request `showFullData` support.

### Patch Changes

### Updated Dependencies:

- torotask@0.17.0
