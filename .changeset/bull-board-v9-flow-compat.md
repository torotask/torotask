---
"@torotask/bull-board": patch
---

### Bull Board 9.x compatibility and flow visualization

- Add version-compat shims for Bull Board 8.x/9.x adapter APIs (rate limits, queue listing) so the adapter works when the host app upgrades Bull Board without duplicate `@bull-board/api` resolution issues
- Patch `FlowProducer` child-key parsing so Bull Board flow trees work with ToroTask's multi-segment queue prefix (`torotask:tasks`)
- Bump peer dependency to `@bull-board/api` `>=8.6.0 <10`
