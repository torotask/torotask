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

  /** Prefix for all keys in this store, e.g. `torotask:state:`. */
  keysPrefix(): string {
    return `${this.prefix}:${this.namespace}:`;
  }

  /** Prefix for per-job keys in a queue, excluding the job id (trailing `:`). */
  jobKeysPrefix(queueName: string): string {
    return `${this.keysPrefix()}${queueName}:`;
  }

  /** Removes all store data for a job. */
  abstract clearJob(queueName: string, jobId: string): Promise<void>;
}
