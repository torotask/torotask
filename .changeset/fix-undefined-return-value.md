---
'torotask': patch
---

Fix job completion crashing when the data store is enabled and the processor returns `undefined`

`JSON.stringify(undefined)` is `undefined`, and `Buffer.byteLength` then threw `ERR_INVALID_ARG_TYPE`. Completing a job with no return value is now a no-op for externalization.
