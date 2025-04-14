import { ConnectionOptions, QueueOptions, WorkerOptions } from 'bullmq';
import { getConfigFromEnv } from './utils/get-config-from-env';
import { ManagedQueue } from './managed-queue';
import { ManagedWorker } from './managed-worker';
import pino, { Logger } from 'pino';

const LOGGER_NAME = 'BullMQ';

/**
 * Options for configuring the ToroTaskClient.
 * Extends BullMQ's ConnectionOptions (as Partial).
 */
export type ToroTaskClientOptions = Partial<ConnectionOptions> & {
  /**
   * A Pino logger instance or configuration options for creating one.
   * If not provided, a default logger will be created.
   */
  logger?: Logger;
  loggerName?: string;
};

// --- ToroTaskClient ---

/**
 * A client class to manage ToroTask's connection settings,
 * reading from constructor options or environment variables using prefixes and merging,
 * and managing ManagedQueue and ManagedWorker instances.
 */
export class ToroTaskClient {
  public readonly connectionOptions: ConnectionOptions;
  public readonly logger: Logger;
  // Adjust record type to remove T, R generics
  private readonly queues: Record<string, ManagedQueue> = {};
  private readonly workers: Record<string, ManagedWorker> = {};

  constructor(options?: ToroTaskClientOptions) {
    const toroTaskEnvConfig = getConfigFromEnv('TOROTASK_REDIS_');
    const redisEnvConfig = getConfigFromEnv('REDIS_');

    // Separate logger options from connection options
    const { logger, loggerName, ...connectionOpts } = options || {};

    const mergedConfig: Partial<ConnectionOptions> = {
      ...redisEnvConfig,
      ...toroTaskEnvConfig,
      ...connectionOpts,
    };

    // Assigning directly based on previous user edits
    this.connectionOptions = mergedConfig as ConnectionOptions;

    // Initialize logger
    this.logger = (logger ?? pino()).child({ name: loggerName ?? LOGGER_NAME });
    this.logger.info('ToroTaskClient initialized');
  }

  /**
   * Gets the resolved connection options suitable for BullMQ.
   * @returns The connection options object.
   */
  public getConnectionOptions(): ConnectionOptions {
    return this.connectionOptions;
  }

  /**
   * Creates or retrieves a ManagedQueue instance.
   * The ManagedQueue itself handles the creation of the underlying BullMQ Queue.
   * If a queue with the same name already exists, the existing managed instance is returned.
   *
   * @param name The name of the queue.
   * @param opts Optional Queue specific options. These are passed to the underlying Queue constructor.
   * @returns The created or retrieved ManagedQueue instance.
   */
  public createQueue<N extends string = string>(name: N, opts?: QueueOptions): ManagedQueue {
    if (this.queues[name]) {
      // Adjust cast
      return this.queues[name] as ManagedQueue;
    }

    // Adjust instantiation, pass the client's logger
    const newManagedQueue = new ManagedQueue(this, name, opts, this.logger);

    // Store the new managed queue instance
    // Adjust cast
    this.queues[name] = newManagedQueue as unknown as ManagedQueue;
    return newManagedQueue;
  }

  /**
   * Retrieves an existing ManagedQueue instance by name.
   *
   * @param name The name of the queue to retrieve.
   * @returns The ManagedQueue instance if found, otherwise undefined.
   */
  public getQueue(name: string): ManagedQueue | undefined {
    // Adjust cast
    return this.queues[name] as ManagedQueue | undefined;
  }

  /**
   * Cpwreates or retrieves a ManagedWorker instance for a specific queue.
   * The ManagedWorker uses an internal processor based on functions defined
   * on the associated ManagedQueue.
   * If a worker for the same queue name already exists, the existing instance is returned.
   *
   * @param name The name of the queue the worker should process (used as lookup key).
   * @param opts Optional Worker specific options.
   * @param managedQueue The ManagedQueue instance this worker belongs to.
   * @returns The created or retrieved ManagedWorker instance.
   */
  public createWorker(name: string, opts: WorkerOptions | undefined, managedQueue: ManagedQueue): ManagedWorker {
    if (this.workers[name]) {
      this.logger.warn({ queueName: name }, 'Attempted to create worker for queue where one already exists.');
      return this.workers[name] as unknown as ManagedWorker;
    }

    // Pass the queue's logger (which is a child of the client logger)
    const newManagedWorker = new ManagedWorker(managedQueue, opts, managedQueue.logger);

    // Store the new managed worker instance
    this.workers[name] = newManagedWorker as unknown as ManagedWorker;
    return newManagedWorker;
  }

  /**
   * Retrieves an existing ManagedWorker instance by name.
   *
   * @param name The name of the worker to retrieve.
   * @returns The ManagedWorker instance if found, otherwise undefined.
   */
  public getWorker(name: string): ManagedWorker | undefined {
    const worker = this.workers[name];
    if (!worker) {
      return undefined;
    }
    // Cast to unknown first for safer type assertion
    return worker as unknown as ManagedWorker | undefined;
  }
}
