import { Job, MinimalQueue } from 'bullmq';
import type { BatchJobOptions } from './types/index.js';

export class BatchJob<DataType = any, ReturnType = any, NameType extends string = string> extends Job<
  DataType,
  ReturnType,
  NameType
> {
  private batches: Job<DataType, ReturnType, NameType>[];

  constructor(
    queue: MinimalQueue,
    name: NameType,
    data: DataType,
    public opts: BatchJobOptions,
    id?: string
  ) {
    super(queue, name, data, opts, id);
    this.batches = [];
  }

  /**
   * Adds a batch of jobs to the current job.
   * @param batch The batch of jobs to add.
   */
  setBatches(batch: Job<DataType, ReturnType, NameType>[]) {
    this.batches = batch;
  }

  /**
   * Adds a job to the batch of jobs associated with this job.
   * @param job The job to add to the batch.
   */
  addBatch(job: Job<DataType, ReturnType, NameType>) {
    this.batches.push(job);
  }

  /**
   * Adds multiple jobs to the batch of jobs associated with this job.
   * @param jobs The jobs to add to the batch.
   */
  addBatches(jobs: Job<DataType, ReturnType, NameType>[]) {
    this.batches.push(...jobs);
  }

  /**
   * Returns the batch of jobs associated with this job.
   * @returns The batch of jobs.
   */
  getBatches(): Job<DataType, ReturnType, NameType>[] {
    return this.batches;
  }
}
