import type { JobNode } from 'bullmq';
import type { TaskJobOptions, TaskJobState } from './job.js';
import type { TaskGroupDefinitionRegistry, TaskKeysForGroup, TaskDefForGroup } from './task-group.js';
import type { TaskPayloadFromDef } from './task.js';

export type TaskFlowRunBaseOptions = Omit<TaskJobOptions, 'repeat' | 'parent'>;

export type TaskFlowRunOptions = TaskFlowRunBaseOptions & Pick<TaskJobOptions, 'parent'>;
export type TaskFlowRunChildOptions = TaskFlowRunBaseOptions;

// Helper interface for a single, specific configuration of a task run.
interface SpecificFlowRunConfig<
  TAllTaskGroupsDefs extends TaskGroupDefinitionRegistry,
  GName extends keyof TAllTaskGroupsDefs,
  TName extends TaskKeysForGroup<TAllTaskGroupsDefs, GName>,
  TOptions = TaskFlowRunOptions,
  // Payload inferred from the task definition using our helper types
  TDef extends TaskDefForGroup<TAllTaskGroupsDefs, GName, TName> = TaskDefForGroup<TAllTaskGroupsDefs, GName, TName>,
  Payload extends TaskPayloadFromDef<TDef> = TaskPayloadFromDef<TDef>,
> {
  taskGroup: GName;
  taskName: TName;
  name?: string;
  payload?: Payload;
  state?: TaskJobState;
  options?: TOptions;
  children?: TaskFlowRun<TAllTaskGroupsDefs, TaskFlowRunChildOptions>[];
}

export type TaskFlowRun<
  TAllTaskGroupsDefs extends TaskGroupDefinitionRegistry = TaskGroupDefinitionRegistry,
  TOptions extends TaskFlowRunBaseOptions = TaskFlowRunOptions,
> = {
  // Iterate over each group name (GKey) from the task group definition registry
  [GKey in keyof TAllTaskGroupsDefs]: {
    // For each task name (TKey) in the current group's tasks
    [TKey in TaskKeysForGroup<TAllTaskGroupsDefs, GKey>]: SpecificFlowRunConfig<
      TAllTaskGroupsDefs,
      GKey,
      TKey,
      TOptions
    >;
    // Create a union of all specific task configurations for the current group GKey
  }[TaskKeysForGroup<TAllTaskGroupsDefs, GKey>];
  // Create a union of all group configurations
}[keyof TAllTaskGroupsDefs];

export type TaskFlowGroupRun = TaskFlowRun<any> & {
  taskGroup?: string;
};

export type TaskFlowRunNode = JobNode;
