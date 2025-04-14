// Basic placeholder - we'll implement the connection logic next.
// console.log('BullMQ Client Package'); // Removed initial log

import { ConnectionOptions, QueueOptions, WorkerOptions } from 'bullmq';
import { getConfigFromEnv } from './utils/get-config-from-env';
import { ManagedQueue } from './managed-queue';
import { ManagedWorker } from './managed-worker';

/**
 * Options for configuring the ToroTaskClient.
 * Extends ToroTask's ConnectionOptions (as Partial).
 */
export type ToroTaskClientOptions = Partial<ConnectionOptions>;

// --- ToroTaskClient ---

/**
 * A client class to manage ToroTask's connection settings,
 * reading from constructor options or environment variables using prefixes and merging,
 * and managing ManagedQueue and ManagedWorker instances.
 */
export class ToroTaskClient {
  public readonly connectionOptions: ConnectionOptions;
  // Adjust record type to remove T, R generics
  private readonly queues: Record<string, ManagedQueue> = {};
  private readonly workers: Record<string, ManagedWorker> = {};

  constructor(options?: ToroTaskClientOptions) {
    const toroTaskEnvConfig = getConfigFromEnv('TOROTASK_REDIS_');
    const redisEnvConfig = getConfigFromEnv('REDIS_');

    const mergedConfig: ToroTaskClientOptions = {
      ...redisEnvConfig,
      ...toroTaskEnvConfig,
      ...options,
    };

    // Assigning directly based on previous user edits
    this.connectionOptions = mergedConfig as ConnectionOptions;
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

    // Adjust instantiation
    const newManagedQueue = new ManagedQueue(this, name, opts);

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
   * Creates or retrieves a ManagedWorker instance for a specific queue.
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
      return this.workers[name] as unknown as ManagedWorker;
    }

    const newManagedWorker = new ManagedWorker(managedQueue, opts);

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
