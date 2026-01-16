---
"torotask": patch
---

Expose BullMQ errors and add failUnrecoverable helper

- Re-export BullMQ error classes: `UnrecoverableError`, `DelayedError`, `RateLimitError`, `WaitingChildrenError`, `WaitingError`
- Add `job.failUnrecoverable(message)` helper method that logs the error and throws

```typescript
import { UnrecoverableError, DelayedError, RateLimitError } from 'torotask';

// Use the helper method (logs message and throws UnrecoverableError)
await job.failUnrecoverable('Invalid payload - missing required field');

// Or throw directly for more control
throw new UnrecoverableError('Custom failure message');
```
