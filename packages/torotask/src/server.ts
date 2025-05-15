import { WorkerOptions } from 'bullmq';
import type {
  TaskGroupDefinitionRegistry,
  TaskGroupRegistry,
  TaskServerOptions,
  WorkerFilterGroups,
} from './types/index.js';
import { DelayedError, WaitingChildrenError } from './step-errors.js';
import { ToroTask } from './client.js';
import { filterGroups } from './utils/filter-groups.js';
import { isControlError } from './utils/is-control-error.js';

const LOGGER_NAME = 'TaskServer';

/**
 * A server class responsible for managing the lifecycle of BullMQ workers
 * based on TaskGroup definitions from the client package.
 * Provides features like centralized worker start/stop and optional global error handling.
 *
 * @template TAllTaskGroupsDefs The type of all task group definitions provided to the server
 * @template TGroups The type of task groups derived from the task group definitions
 */
export class TaskServer<
  TAllTaskGroupsDefs extends TaskGroupDefinitionRegistry = TaskGroupDefinitionRegistry,
  TGroups extends TaskGroupRegistry<TAllTaskGroupsDefs> = TaskGroupRegistry<TAllTaskGroupsDefs>,
> extends ToroTask<TAllTaskGroupsDefs> {
  // Store bound handlers to remove them later
  private unhandledRejectionListener?: (...args: any[]) => void;
  private uncaughtExceptionListener?: (...args: any[]) => void;

  constructor(
    public readonly options: TaskServerOptions,
    taskGroupDefs?: TAllTaskGroupsDefs
  ) {
    // Refined Logger Initialization
    options.loggerName = options.loggerName ?? LOGGER_NAME;
    options.handleGlobalErrors = options.handleGlobalErrors ?? true;

    super(options, taskGroupDefs);
    this.logger.debug('TaskServer initialized');
  }

  /**
   * Starts server and workers based on the provided filter.
   *
   * @param filter Optional filter to target specific groups or tasks.
   * @param workerOptions Optional default WorkerOptions to pass down.
   */
  async start(filter?: WorkerFilterGroups<TGroups>, workerOptions?: WorkerOptions): Promise<void> {
    this.logger.info('Starting TaskServer workers...');

    // Attach global handlers if configured
    if (this.options.handleGlobalErrors) {
      this.attachGlobalErrorHandlers();
    }

    // TODO Add event dispatcher options somewhere, possibly create dedicated method on client
    await this.events.startWorker();

    const groupsToProcess = filterGroups(this, filter, 'starting workers');

    if (groupsToProcess.length === 0) {
      this.logger.info('No groups to start workers for based on the filter.');
      return;
    }

    const mergedOptions: WorkerOptions = {
      prefix: this.queuePrefix,
      connection: this.connectionOptions,
      ...workerOptions,
    };

    await Promise.allSettled(
      groupsToProcess.map(async (group) => {
        await group.startWorkers(undefined, mergedOptions);
      })
    );

    this.logger.info('Finished request to start workers');
  }

  /**
   * Stops server and workers based on the provided filter.
   *
   * @param filter Optional filter to target specific groups or tasks.
   * @returns A promise that resolves when all targeted workers have been requested to stop.
   */
  async stop(filter?: WorkerFilterGroups<TGroups>): Promise<void> {
    this.logger.info({ filter }, 'Stopping workers across task groups');
    const groupsToProcess = filterGroups(this, filter, 'stopping workers');

    if (groupsToProcess.length === 0) {
      this.logger.info('No groups to stop workers for based on the filter.');
      return;
    }

    await Promise.allSettled(
      groupsToProcess.map(async (group) => {
        await group.stopWorkers();
      })
    );

    this.logger.info('Finished request to stop workers');

    // Detach global handlers if we attached them
    this.detachGlobalErrorHandlers();
    await this.close();
    this.logger.info('TaskServer stopped.');
  }

  private attachGlobalErrorHandlers(): void {
    if (this.unhandledRejectionListener || this.uncaughtExceptionListener) {
      this.logger.warn('Global error handlers already attached, detaching first.');
      this.detachGlobalErrorHandlers();
    }
    this.logger.debug('Attaching global error handlers (unhandledRejection, uncaughtException)');

    // Bind `this` to ensure logger is accessible
    this.unhandledRejectionListener = this.handleUnhandledRejection.bind(this);
    this.uncaughtExceptionListener = this.handleUncaughtException.bind(this);

    process.on('unhandledRejection', this.unhandledRejectionListener);
    process.on('uncaughtException', this.uncaughtExceptionListener);
  }

  private detachGlobalErrorHandlers(): void {
    if (this.unhandledRejectionListener) {
      process.off('unhandledRejection', this.unhandledRejectionListener);
      this.unhandledRejectionListener = undefined;
      this.logger.info('Detached unhandledRejection listener.');
    }
    if (this.uncaughtExceptionListener) {
      process.off('uncaughtException', this.uncaughtExceptionListener);
      this.uncaughtExceptionListener = undefined;
      this.logger.info('Detached uncaughtException listener.');
    }
  }

  private handleUnhandledRejection(error: any, _promise: Promise<unknown>): void {
    // Check for BullMQ flow control errors (missing awaits)
    if (isControlError(error)) {
      this.logger.error(
        { error, errorName: error.name, errorMessage: error.message },
        `Likely missing await detected: ${error.name} was thrown but not caught. This is usually caused by not awaiting a promise that throws flow control errors.`
      );
    } else {
      this.logger.error({ error }, 'Unhandled Promise Rejection detected by TaskServer');
    }
  }

  private handleUncaughtException(error: Error, _origin: NodeJS.UncaughtExceptionOrigin): void {
    this.logger.error({ err: error }, 'Uncaught Exception detected by TaskServer');
    // Optional: Exit strategy (often recommended for uncaught exceptions)
    // process.exit(1);
  }
}
