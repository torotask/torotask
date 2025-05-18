import type { JobNode } from 'bullmq';
import type { TaskJobData, TaskJobOptions, TaskJobState } from './job.js';
import type { Task } from '../task.js';
import type { TaskGroupDefinitionRegistry, TaskGroupRegistry } from './task-group.js';

export type TaskFlowRunOptions = Omit<TaskJobOptions, 'repeat'>;

export type TaskFlow<PayloadType = any, DataType extends TaskJobData<PayloadType> = TaskJobData<PayloadType>> = {
  name?: string;
  payload?: PayloadType;
  data?: DataType;
  state?: TaskJobState;
  options?: TaskFlowRunOptions;
};

// Helper interface for a single, specific configuration of a task run.
interface SpecificFlowRunConfig<
  TAllTaskGroupsDefs extends TaskGroupDefinitionRegistry, // Original raw schema
  // ProcessedSchema is TaskGroupRegistry<TAllTaskGroupsDefs>
  // We access it directly via TaskGroupRegistry<TAllTaskGroupsDefs> where needed.
  GName extends keyof TaskGroupRegistry<TAllTaskGroupsDefs>, // A specific group name
  TName extends keyof TaskGroupRegistry<TAllTaskGroupsDefs>[GName]['tasks'], // A specific task name
  TOptions = TaskFlowRunOptions,
  // Payload inferred using your logic from the "processed" task definition
  Payload = TaskGroupRegistry<TAllTaskGroupsDefs>[GName]['tasks'][TName] extends Task<any, any, any, infer P>
    ? P
    : unknown,
> {
  taskGroup: GName;
  taskName: TName;
  name?: string;
  payload?: Payload;
  state?: TaskJobState;
  options?: TOptions;
  children?: TaskFlowRunChild<TAllTaskGroupsDefs>[];
}

export type TaskFlowRun<
  TAllTaskGroupsDefs extends TaskGroupDefinitionRegistry = TaskGroupDefinitionRegistry,
  TOptions = TaskFlowRunOptions,
> = {
  // Iterate over each group name (GKey) from the *processed* schema structure
  [GKey in keyof TaskGroupRegistry<TAllTaskGroupsDefs>]: {
    // For each task name (TKey) in the current group's tasks (from processed schema)
    [TKey in keyof TaskGroupRegistry<TAllTaskGroupsDefs>[GKey]['tasks']]: SpecificFlowRunConfig<
      TAllTaskGroupsDefs,
      GKey,
      TKey,
      TOptions
    >;
    // Create a union of all specific task configurations for the current group GKey
  }[keyof TaskGroupRegistry<TAllTaskGroupsDefs>[GKey]['tasks']];
  // Create a union of all group configurations
}[keyof TaskGroupRegistry<TAllTaskGroupsDefs>];

export type TaskFlowRunChild<TAllTaskGroupsDefs extends TaskGroupDefinitionRegistry = TaskGroupDefinitionRegistry> =
  TaskFlowRun<TAllTaskGroupsDefs, Omit<TaskFlowRunOptions, 'parent'>>;

export type TaskFlowGroupRun = TaskFlowRun<any> & {
  taskGroup?: string;
};

export type TaskFlowRunNode = JobNode;
