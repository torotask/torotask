---
"torotask": patch
---

Allow overriding the `parent` option in step executor methods

Previously, methods like `runTask`, `runGroupTask`, `runFlow`, etc. would always use the current job as the parent, ignoring any `parent` value passed through options. Now, if you explicitly pass a `parent` in the options, it will take precedence over the auto-set value.

Additionally, the `parent` option now accepts two formats:

```typescript
// TaskJob object (existing behavior)
await step.runTask('step-id', 'group', 'task', payload, { parent: taskJob });

// BullMQ ParentOptions format (new)
await step.runTask('step-id', 'group', 'task', payload, { 
  parent: { id: 'job-123', queue: 'prefix:queueName' } 
});

// No parent (orphan job)
await step.runTask('step-id', 'group', 'task', payload, { parent: undefined });
```

