---
"torotask": minor
---

Improved deduplication options in task definitions

- Made `id` optional in deduplication options - you can now set defaults like `ttl` without requiring an ID upfront
- Added `idFromPayload` callback for generating typed deduplication IDs from payload values at runtime
- If no ID is available (neither literal `id` nor callback result), deduplication is automatically skipped

```typescript
// Define task with deduplication using typed callback
export const myTask = defineTask({
  id: 'my-task',
  schema: createSchema(z => z.object({
    userId: z.string(),
    action: z.string(),
  })),
  options: {
    deduplication: {
      // Fully typed payload access
      idFromPayload: (payload) => `${payload.userId}:${payload.action}`,
      ttl: 5000,
    },
  },
  handler: async (options, context) => { ... },
});
```
