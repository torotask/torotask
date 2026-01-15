---
"torotask": patch
---

Allow overriding the `parent` option in step executor methods

Previously, methods like `runTask`, `runGroupTask`, `runFlow`, etc. would always use the current job as the parent, ignoring any `parent` value passed through options. Now, if you explicitly pass a `parent` in the options, it will take precedence over the auto-set value.

```typescript
// Before: options.parent was always overwritten
await step.runTask('step-id', 'group', 'task', payload, { parent: customParent });
// ^ customParent was ignored, this.job was always used

// After: options.parent takes precedence
await step.runTask('step-id', 'group', 'task', payload, { parent: customParent });
// ^ customParent is now used as the parent
```
