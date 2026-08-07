/**
 * Shared base for ToroTask external Redis-backed stores (step state, job data blobs, etc.).
 * Subclasses use a distinct {@link namespace} per concern but share key-building conventions.
 */
export abstract class ToroTaskStoreBase {
  constructor(
    protected readonly prefix: string,
    protected readonly namespace: string,
  ) {}

  /** e.g. `torotask:state:exampleGroup.task:job-1` */
  protected buildNamespacedKey(suffix: string): string {
    return `${this.prefix}:${this.namespace}:${suffix}`;
  }

  /** Removes all store data for a job. */
  abstract clearJob(queueName: string, jobId: string): Promise<void>;
}
