import { Queue, QueueOptions, QueueEvents, WorkerOptions } from 'bullmq';
import type { ToroTaskClient } from './index';
import { ManagedWorker } from './managed-worker';
import { ManagedFunction, ManagedFunctionOptions, FunctionHandler } from './managed-function';
import { Logger } from 'pino';

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
  public readonly logger: Logger;
  public worker?: ManagedWorker;
  private readonly functions: Record<string, ManagedFunction<unknown, unknown>> = {};

  constructor(client: ToroTaskClient, name: string, opts: QueueOptions | undefined, parentLogger: Logger) {
    this.client = client;
    this.name = name;
    this.logger = parentLogger.child({ queueName: this.name });

    this.logger.info(`Initializing ManagedQueue`);

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
      this.logger.warn({ functionName: name }, `Redefining function`);
    }
    const managedFunction = new ManagedFunction<T, R>(this, name, handler, options, this.logger);
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
      this.logger.warn(`Worker already started, returning existing instance.`);
      return this.worker;
    }

    this.logger.info(`Starting worker`);
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
