---
"torotask": minor
---

Add `defineTaskWithResult<T>()` helper function for explicit result types

When you need to specify an explicit result type for a task while still inferring
the payload type from the schema, use the new `defineTaskWithResult` function:

```ts
import { createSchema, defineTaskWithResult } from 'torotask';

export const myTask = defineTaskWithResult<MyResultType>()({
  schema: createSchema(z => z.object({ id: z.string() })),
  handler: async (opts, ctx) => {
    return { success: true }; // Must match MyResultType
  }
});
```

The curried syntax `<T>()({...})` is required to allow TypeScript to infer the
schema type while accepting an explicit result type.
