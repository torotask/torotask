import { JobProgress, QueueBase } from 'bullmq';
import { ToroTask } from './client.js';
import { TaskJob } from './job.js';
import { TaskQueueEvents } from './queue-events.js';
import { TaskQueue } from './queue.js';
import type {
  TaskWorkerQueueListener,
  TaskWorkerQueueOptions,
  TaskWorkerOptions,
  WorkerEventHandlers,
} from './types/index.js';
import { TaskWorker } from './worker.js';

export class TaskWorkerQueue<PayloadType = any, ResultType = any, NameType extends string = string> extends TaskQueue<
  PayloadType,
  ResultType,
  NameType
> {
  public readonly queueEvents: TaskQueueEvents;
  protected worker?: TaskWorker<PayloadType, ResultType, NameType> | undefined;
  // Store listeners to remove them later
  private workerEventHandlers: Partial<WorkerEventHandlers<PayloadType, ResultType, NameType>> = {};

  constructor(
    taskClient: ToroTask,
    name: string,
    public options?: Partial<TaskWorkerQueueOptions<PayloadType, ResultType, NameType>>
  ) {
    const { processor, ...queueOptions } = options ?? {};
    super(taskClient, name, queueOptions);

    this.queueEvents = new TaskQueueEvents(taskClient, this.name);
  }

  /**
   * Method to process a job.
   * Subclasses must implement this method to define the job handling logic.
   *
   * @param job The BullMQ job object.
   * @returns A promise that resolves with the result of the job.
   */
  process(_job: TaskJob<PayloadType, ResultType, NameType>, _token?: string): Promise<ResultType> {
    // This method should be implemented by subclasses
    throw new Error('process method not implemented');
  }

  getWorkerOptions(): Partial<TaskWorkerOptions> {
    return {};
  }

  /**
   * Starts a dedicated BullMQ Worker for this queue, if one is not already running.
   * Forwards worker events to this BaseQueue instance, prefixing them with 'worker:'.
   */
  async startWorker(options?: TaskWorkerOptions): Promise<TaskWorker<PayloadType, ResultType, NameType>> {
    if (this.worker) {
      this.logger.warn('Worker already started for this queue. Returning existing instance.');
      return this.worker;
    }
    // Clear any stale listeners if somehow start is called without stop
    this.removeAllWorkerListeners();

    const mergedOptions = {
      ...this.getWorkerOptions(),
      ...(options ?? {}),
    };

    this.logger.info({ workerOptions: mergedOptions }, 'Starting worker');

    const newWorker = new TaskWorker<PayloadType, ResultType, NameType>(
      this.taskClient,
      this.name,
      this.options?.processor ?? this.process.bind(this),
      mergedOptions
    );

    // --- Event Forwarding (with prefixing) ---
    // Define handlers that emit events from `this` (the BaseQueue instance)
    this.workerEventHandlers = {
      active: (job: TaskJob<PayloadType, ResultType, NameType>, prev: string) => {
        this.logger.debug({ jobId: job.id, prev }, 'Worker event: active');
        // Emit with 'worker:' prefix
        this.emit('worker:active', job, prev);
      },
      completed: (job: TaskJob<PayloadType, ResultType, NameType>, result: any, prev: string) => {
        this.logger.debug({ jobId: job.id, result }, 'Worker event: completed');
        this.emit('worker:completed', job, result, prev);
      },
      drained: () => {
        this.logger.debug('Worker event: drained');
        this.emit('worker:drained');
      },
      error: (error: Error) => {
        // This is for errors *within the worker itself*, not job failures
        this.logger.error({ err: error }, 'Worker event: error');
        this.emit('worker:error', error);
      },
      failed: (job: TaskJob<PayloadType, ResultType, NameType> | undefined, error: Error, prev: string) => {
        // Job might be undefined if failure happens before job is retrieved
        this.logger.warn({ jobId: job?.id, err: error, prev }, 'Worker event: failed');
        this.emit('worker:failed', job, error, prev);
      },
      paused: () => {
        this.logger.debug('Worker event: paused');
        this.emit('worker:paused');
      },
      progress: (job: TaskJob<PayloadType, ResultType, NameType>, progress: JobProgress) => {
        // Progress can be number | object
        this.logger.debug({ jobId: job.id, progress }, 'Worker event: progress');
        this.emit('worker:progress', job, progress);
      },
      ready: () => {
        this.logger.debug('Worker event: ready');
        this.emit('worker:ready');
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resumed: () => {
        this.logger.debug('Worker event: resumed');
        this.emit('worker:resumed');
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stalled: (jobId: string, prev: string) => {
        this.logger.warn({ jobId, prev }, 'Worker event: stalled');
        this.emit('worker:stalled', jobId, prev);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      closed: () => {
        this.logger.debug('Worker event: closed');
        this.emit('worker:closed');
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      closing: (msg: string) => {
        this.logger.debug({ msg }, 'Worker event: closing');
        this.emit('worker:closing', msg);
      },
    };

    for (const eventName of Object.keys(this.workerEventHandlers) as Array<keyof typeof this.workerEventHandlers>) {
      const handler = this.workerEventHandlers[eventName];
      if (handler) {
        // Explicitly type the handler function
        newWorker.on(eventName, handler as (...args: unknown[]) => void);
      }
    }
    // --- End Event Forwarding ---

    this.worker = newWorker;
    this.logger.info('Worker started successfully and event forwarding enabled');
    return this.worker;
  }

  /** Helper to remove all attached worker listeners */
  private removeAllWorkerListeners(): void {
    if (this.worker && Object.keys(this.workerEventHandlers).length > 0) {
      this.logger.debug('Removing worker event listeners');
      // Detach listeners using Object.keys
      for (const eventName of Object.keys(this.workerEventHandlers) as Array<keyof typeof this.workerEventHandlers>) {
        const handler = this.workerEventHandlers[eventName];
        if (handler) {
          // Explicitly type the handler function
          this.worker.off(eventName, handler as (...args: unknown[]) => void);
        }
      }
      this.workerEventHandlers = {}; // Clear stored handlers
    }
  }

  /**
   * Stops the worker instance associated with this queue, if it is running.
   * Removes event listeners before closing.
   */
  async stopWorker(): Promise<void> {
    if (this.worker) {
      this.logger.info('Stopping worker and removing listeners...');
      // Remove listeners before closing
      this.removeAllWorkerListeners();
      try {
        await this.worker.close();
        this.logger.info('Worker stopped successfully.');
      } catch (error) {
        this.logger.error({ err: error instanceof Error ? error : new Error(String(error)) }, 'Error stopping worker');
      } finally {
        this.worker = undefined;
      }
    }
  }

  /**
   * Closes the underlying BullMQ Worker (if started), Queue, and QueueEvents instances,
   * and removes the instance from the static registry.
   * Should be called during application shutdown.
   */
  async close(): Promise<void> {
    this.logger.debug('Closing Queue resources (worker, queue, events)');
    const closePromises: Promise<void>[] = [];

    // Stop the worker first using the new method
    // Use await here to ensure worker stops before queue closes if order matters
    await this.stopWorker();

    // Proceed with closing queue and events
    this.logger.debug('Closing queue events...');
    closePromises.push(this.queueEvents.close());
    this.logger.debug('Closing queue...');
    closePromises.push(super.close()); // Close the queue
    try {
      await Promise.all(closePromises);
      this.logger.debug('WorkerQueue resources closed successfully');
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        'Error closing WorkerQueue resources'
      );
      // Note: Instance was already removed from registry
    }
  }

  // --- Update Event Emitter Signatures ---

  // Override emit, on, off, once to use the new combined listener interface
  emit<U extends keyof TaskWorkerQueueListener>(event: U, ...args: Parameters<TaskWorkerQueueListener[U]>): boolean {
    return QueueBase.prototype.emit.call(this, event, ...args);
  }

  off<U extends keyof TaskWorkerQueueListener>(eventName: U, listener: TaskWorkerQueueListener[U]): this {
    QueueBase.prototype.off.call(this, eventName, listener);
    return this;
  }

  on<U extends keyof TaskWorkerQueueListener>(event: U, listener: TaskWorkerQueueListener[U]): this {
    QueueBase.prototype.on.call(this, event, listener);
    return this;
  }

  once<U extends keyof TaskWorkerQueueListener>(event: U, listener: TaskWorkerQueueListener[U]): this {
    QueueBase.prototype.once.call(this, event, listener);
    return this;
  }
}
