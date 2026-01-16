import type { FlowChildJob, FlowJob, FlowJobBase, Job } from 'bullmq';
import type { ToroTask } from './client.js';
import type { TaskFlowRun, TaskFlowRunNode, TaskJobOptions, TaskQueueOptions } from './types/index.js';
import { FlowProducer } from 'bullmq';
import { TaskJob } from './job.js';
import { convertJobOptions } from './utils/convert-job-options.js';

export class TaskWorkflow extends FlowProducer {
  constructor(
    public readonly taskClient: ToroTask,
    options?: Partial<TaskQueueOptions>,
  ) {
    options = options || {};
    options.prefix = options.prefix || taskClient.queuePrefix;
    options.connection = options.connection = taskClient.connectionOptions;

    super(options as TaskQueueOptions);
  }

  /**
   * Override the Job class to use TaskJob
   * @returns The extended Job class.
   */
  protected get Job(): typeof Job {
    return TaskJob as any;
  }

  _convertToFlow<TResult extends FlowJobBase<any> = FlowJob, TRun extends TaskFlowRun = TaskFlowRun>(
    run: TRun,
    options?: Partial<TaskJobOptions>,
    removeParentOption?: boolean,
  ): TResult {
    const task = this.taskClient.getTask(run.taskGroup, run.taskName as string);
    if (!task) {
      throw new Error(`Task ${run.taskGroup}.${run.taskName as string} not found`);
    }
    const queueName = task.queueName;
    let mergedOptions = {
      ...task.jobsOptions,
      ...options,
      ...run.options,
    };

    if (removeParentOption && mergedOptions.parent) {
      delete mergedOptions.parent;
    }
    else {
      mergedOptions = convertJobOptions(mergedOptions, run.payload);
    }

    return {
      name: (run.name as string) ?? run.taskName,
      queueName,
      data: {
        payload: run.payload,
        state: run.state,
      },
      opts: mergedOptions,
      children: run.children?.map(child => this._convertToFlow<FlowChildJob>(child, options, true)) || undefined,
    } as TResult;
  }

  /**
   * Run a flow with the given options
   * @param run
   * @param options
   * @returns (Promise<TaskFlowRunNode>)
   */
  async runFlow(run: TaskFlowRun, options?: Partial<TaskJobOptions>): Promise<TaskFlowRunNode> {
    const flow = this._convertToFlow(run, options);
    return await this.add(flow);
  }

  /**
   *   Run multiple flows with the given options
   *   @param runs
   *   @param options
   *   @returns (Promise<TaskFlowRunNode[]>)
   */
  async runFlows(runs: TaskFlowRun[], options?: Partial<TaskJobOptions>): Promise<TaskFlowRunNode[]> {
    const flows: FlowJob[] = runs.map((run) => {
      return this._convertToFlow(run, options);
    });

    return await this.addBulk(flows);
  }
}
