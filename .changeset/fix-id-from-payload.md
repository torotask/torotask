---
"torotask": patch
---

Fix `idFromPayload` deduplication callback not being invoked when running tasks. The `TaskQueue.add()` and `TaskQueue.addBulk()` methods now correctly call `convertJobOptions()` with the payload to resolve the callback before passing options to BullMQ.
