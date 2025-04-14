import { Queue, QueueOptions, QueueEvents, WorkerOptions } from 'bullmq';
import type { ToroTaskClient } from './index';
import { ManagedWorker } from './managed-worker';
import { ManagedFunction, ManagedFunctionOptions, FunctionHandler } from './managed-function';

/**
 * Wraps a BullMQ Queue instance to provide convenience methods.
 * Manages the underlying BullMQ Queue instance creation and can start a worker.
 * Holds a registry of defined functions (job types) for this queue.
 */
export class ManagedQueue {
  public readonly queue: Queue;
  public readonly queueEvents: QueueEvents;
  public readonly name: string;
  public readonly client: ToroTaskClient;
  public worker?: ManagedWorker;
  private readonly functions: Record<string, ManagedFunction<unknown, unknown>> = {};

  constructor(client: ToroTaskClient, name: string, opts?: QueueOptions) {
    this.client = client;
    this.name = name;

    const queueOptions: QueueOptions = {
      connection: this.client.connectionOptions,
      ...opts,
    };

    this.queue = new Queue(this.name, queueOptions);
    this.queueEvents = new QueueEvents(this.name, {
      connection: this.client.connectionOptions,
    });
  }

  /**
   * Defines a function (job type) associated with this queue.
   *
   * @template T Data type
   * @template R Return type
   * @param name Function name (job name)
   * @param handler The function handler
   * @param options Default job options
   * @returns The created ManagedFunction instance.
   */
  defineFunction<T = unknown, R = unknown>(
    name: string,
    handler: FunctionHandler<T, R>,
    options?: ManagedFunctionOptions
  ): ManagedFunction<T, R> {
    if (this.functions[name]) {
      console.warn(`Redefining function "${name}" for queue "${this.name}".`);
    }
    const managedFunction = new ManagedFunction<T, R>(this, name, handler, options);
    this.functions[name] = managedFunction as ManagedFunction<unknown, unknown>;
    return managedFunction;
  }

  /**
   * Retrieves a defined function by its name.
   * @param name The name of the function.
   * @returns The ManagedFunction instance or undefined if not found.
   */
  getFunction(name: string): ManagedFunction<unknown, unknown> | undefined {
    return this.functions[name];
  }

  /**
   * Starts or retrieves the worker associated with this queue.
   * The worker will process jobs based on defined functions.
   *
   * @param opts Optional Worker specific options.
   * @returns The ManagedWorker instance.
   */
  startWorker(opts?: WorkerOptions): ManagedWorker {
    if (this.worker) {
      console.warn(`Worker for queue "${this.name}" already started.`);
      return this.worker;
    }

    const managedWorker = this.client.createWorker(this.name, opts, this);

    this.worker = managedWorker;
    return managedWorker;
  }

  /**
   * Get the underlying BullMQ Queue instance.
   */
  get bullmqInstance(): Queue {
    return this.queue;
  }
}
