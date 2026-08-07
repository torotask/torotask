import type { JobStatus, QueueAdapterOptions } from '@bull-board/api/typings/app';
import type { Job, Queue } from 'bullmq';
import type { StepResult, TaskJobData, TaskJobState, ToroTask } from 'torotask';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';

/**
 * Bull Board adapter that merges external step state into job.data for display.
 * ToroTask stores step state outside BullMQ job.data; this restores visibility in the UI.
 */
export class ToroTaskBullMQAdapter extends BullMQAdapter {
  private readonly queueName: string;

  constructor(
    private readonly taskClient: ToroTask,
    queue: Queue,
    options?: Partial<QueueAdapterOptions>,
  ) {
    super(queue, options);
    this.queueName = queue.name;
  }

  override async getJob(id: string): Promise<Job | undefined> {
    const job = await super.getJob(id);
    if (!job) {
      return job;
    }
    return this.enrichJobWithStepState(job);
  }

  override async getJobs(
    jobStatuses: JobStatus[],
    start?: number,
    end?: number,
  ): Promise<Job[]> {
    const jobs = await super.getJobs(jobStatuses, start, end);
    return Promise.all(jobs.map(job => this.enrichJobWithStepState(job)));
  }

  private async enrichJobWithStepState(job: Job): Promise<Job> {
    if (!job?.data || !job.id) {
      return job;
    }

    const data = job.data as TaskJobData;
    const dataStore = this.taskClient.getDataStore?.();
    if (dataStore) {
      if (data.payload !== undefined) {
        data.payload = await dataStore.resolveDeep(data.payload);
      }
      if (job.returnvalue !== undefined) {
        job.returnvalue = await dataStore.resolveDeep(job.returnvalue);
      }
    }

    const stepState = await this.taskClient.getStepStateStore().loadSteps(
      this.queueName,
      job.id,
    );

    if (dataStore) {
      for (const [stepId, result] of Object.entries(stepState) as Array<[string, StepResult]>) {
        if (result.data !== undefined) {
          result.data = await dataStore.resolveDeep(result.data);
        }
        stepState[stepId] = result;
      }
    }

    if (Object.keys(stepState).length === 0 && !dataStore) {
      return job;
    }

    job.data = {
      ...data,
      state: {
        ...(data.state ?? {}),
        stepState,
      } as TaskJobState,
    };

    return job;
  }
}
