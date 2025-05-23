import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { WorkerOptions } from 'bullmq';
import { glob } from 'glob';
import { type DestinationStream, type Logger, type LoggerOptions, pino } from 'pino';
import type { TaskDefinition, TaskGroupRegistry, TaskServerOptions, TaskTrigger } from './types/index.js';
import { ToroTask, WorkerFilter } from './client.js';
import { TaskGroup } from './task-group.js';
import { EventDispatcher } from './event-dispatcher.js';

const LOGGER_NAME = 'TaskServer';

/**
 * A server class responsible for managing the lifecycle of BullMQ workers
 * based on TaskGroup definitions from the client package.
 * Provides features like centralized worker start/stop and optional global error handling.
 */
export class TaskServer {
  public readonly client: ToroTask;
  public readonly logger: Logger;
  private readonly rootDir?: string;
  private readonly options: Required<Pick<TaskServerOptions, 'handleGlobalErrors'>>;
  private readonly managedGroups: Set<TaskGroup> = new Set();
  private readonly ownClient: boolean = false; // Did we create the client?
  public readonly events: EventDispatcher;
  public taskGroups: TaskGroupRegistry = {};

  // Store bound handlers to remove them later
  private unhandledRejectionListener?: (...args: any[]) => void;
  private uncaughtExceptionListener?: (...args: any[]) => void;

  constructor(options: TaskServerOptions) {
    // Refined Logger Initialization
    const loggerOptions = options.logger;
    const loggerName = options.loggerName ?? LOGGER_NAME;

    if (
      typeof loggerOptions === 'object' &&
      loggerOptions !== null &&
      typeof (loggerOptions as Logger).info === 'function'
    ) {
      // It looks like a Logger instance
      this.logger = (loggerOptions as Logger).child({ name: loggerName });
    } else if (
      typeof loggerOptions === 'object' &&
      loggerOptions !== null &&
      typeof (loggerOptions as DestinationStream).write === 'function'
    ) {
      // It looks like a DestinationStream
      this.logger = pino(loggerOptions as DestinationStream).child({ name: loggerName });
    } else {
      // Assume it's LoggerOptions or undefined
      this.logger = pino(loggerOptions as LoggerOptions | undefined).child({ name: loggerName });
    }

    // Store rootDir if provided
    this.rootDir = options.rootDir;
    if (this.rootDir) {
      this.logger.debug({ rootDir: this.rootDir }, 'TaskServer root directory set.');
    } else {
      this.logger.warn(
        'TaskServer `rootDir` not provided. Relative paths in `loadTasksFromDirectory` will be rejected.'
      );
    }

    // Initialize Client
    if (options.client) {
      this.client = options.client;
      this.ownClient = false;
      this.logger.debug('Using provided ToroTask instance.');
    } else if (options.clientOptions) {
      this.client = new ToroTask({
        ...options.clientOptions,
        logger: options.clientOptions.logger ?? this.logger.child({ component: 'ToroTask' }),
      });
      this.ownClient = true;
      this.logger.debug('Created new ToroTask instance.');
    } else {
      throw new Error('TaskServer requires either a `client` instance or `clientOptions`.');
    }

    // Create / fetch eventDispatcher
    this.events = this.client.events;

    // Store other options with defaults
    this.options = {
      handleGlobalErrors: options.handleGlobalErrors ?? true,
    };

    this.logger.debug('TaskServer initialized');
  }

  /**
   * Adds TaskGroups to be managed by this server.
   */
  addGroups(...groups: TaskGroup[]): this {
    groups.forEach((group) => {
      if (!group || !(group instanceof TaskGroup)) {
        this.logger.warn({ group }, 'Skipping invalid item passed to addGroups');
        return;
      }
      if (group.client !== this.client) {
        this.logger.warn(
          { groupName: group.name },
          'TaskGroup added was created with a different ToroTask instance. This may cause issues.'
        );
      }
      this.logger.debug({ groupName: group.name }, 'Adding TaskGroup');
      this.managedGroups.add(group);
    });
    return this;
  }

  /**
   * Scans a directory for task definition files and loads them.
   * Assumes a structure like `baseDir/groupName/taskId.task.{js,ts}`.
   * Expects task files to have a default export: `{ handler: TaskHandler, options?: TaskOptions }`.
   *
   * @param baseDir The base directory containing task groups. Can be absolute or relative to `rootDir` (if provided during server construction).
   * @param pattern Glob pattern relative to baseDir (defaults to `**\/*.task.{js,ts}`).
   */
  async loadTasksFromDirectory(baseDir: string, pattern?: string): Promise<void> {
    const effectivePattern = pattern ?? '**/*.task.{js,ts}';
    let absoluteBaseDir: string;

    // Resolve baseDir
    if (path.isAbsolute(baseDir)) {
      absoluteBaseDir = baseDir;
    } else {
      if (!this.rootDir) {
        throw new Error(
          `Cannot load tasks from relative path "${baseDir}" because TaskServer was not configured with a 'rootDir'. Provide an absolute path or set 'rootDir' in TaskServerOptions.`
        );
      }
      absoluteBaseDir = path.resolve(this.rootDir, baseDir);
      this.logger.debug(
        { relativePath: baseDir, resolvedPath: absoluteBaseDir },
        'Resolved relative baseDir using rootDir'
      );
    }

    this.logger.debug({ baseDir: absoluteBaseDir, pattern: effectivePattern }, 'Loading tasks from directory...');

    try {
      if (!fs.existsSync(absoluteBaseDir) || !fs.statSync(absoluteBaseDir).isDirectory()) {
        throw new Error(`Base directory does not exist or is not a directory: ${absoluteBaseDir}`);
      }
    } catch (error) {
      this.logger.error({ baseDir: absoluteBaseDir, err: error }, 'Failed to access base task directory.');
      throw error; // Re-throw for clarity
    }

    const searchPattern = path.join(absoluteBaseDir, effectivePattern).replace(/\\/g, '/');
    const taskFiles = await glob(searchPattern, { absolute: true });

    this.logger.debug({ count: taskFiles.length }, 'Found potential task files');

    let loadedCount = 0;
    let errorCount = 0;

    for (const filePath of taskFiles) {
      try {
        const relativePath = path.relative(absoluteBaseDir, filePath);
        const groupName = path.dirname(relativePath);
        const fileName = path.basename(relativePath);
        const taskIdMatch = fileName.match(/^(.+?)\.task\.(js|ts)$/);
        let derivedTaskId: string = '';
        if (taskIdMatch?.[1]) {
          derivedTaskId = taskIdMatch[1];
        } else {
          continue;
        }

        this.logger.debug({ groupName, derivedTaskId, filePath }, 'Loading task definition...');

        const fileUrl = pathToFileURL(filePath).href;
        const taskModule = (await import(fileUrl)) as {
          default?: TaskDefinition & { trigger?: TaskTrigger; triggers?: TaskTrigger[] };
        };

        let finalTaskId: string = derivedTaskId;
        let moduleToUse: TaskDefinition & { trigger?: TaskTrigger; triggers?: TaskTrigger[] };

        if (taskModule.default?.handler && typeof taskModule.default.handler === 'function') {
          moduleToUse = taskModule.default;
        } else if (typeof (taskModule as any).handler === 'function') {
          moduleToUse = taskModule as any;
          this.logger.warn(
            { filePath },
            'Task file uses direct export instead of default export. Consider using default export { handler, options?, trigger/triggers? }.'
          );
        } else {
          throw new Error(
            `Invalid or missing export. Expected { handler: function, options?:..., trigger/triggers?:... } via default or module.exports.`
          );
        }

        const group = this.client.createTaskGroup(groupName);
        this.managedGroups.add(group);

        const explicitId = moduleToUse.id;
        if (explicitId) {
          finalTaskId = explicitId;
          this.logger.debug({ derivedTaskId, explicitName: finalTaskId }, 'Using explicit task name from options.');
        }

        const options = moduleToUse.options || {};
        group.createTask({
          id: finalTaskId,
          options: options,
          triggers: moduleToUse.triggers ?? moduleToUse.trigger,
          handler: moduleToUse.handler,
          schema: moduleToUse.schema,
        });

        this.logger.debug({ groupName, taskId: finalTaskId }, 'Successfully loaded and defined task.');
        loadedCount++;
      } catch (error) {
        this.logger.error({ filePath, err: error }, 'Failed to load or define task from file.');
        errorCount++;
      }
    }

    this.logger.debug(
      { loaded: loadedCount, errors: errorCount, totalFound: taskFiles.length },
      'Finished loading tasks from directory.'
    );
    if (errorCount > 0) {
      // Optionally throw an aggregate error or indicate failure
    }
    this.logger.warn(
      "The 'loadTasksFromDirectory' method is deprecated. Consider switching to 'registerTasksFromDefinitionObject'."
    );
  }

  /**
   * Retrieves an existing Task instance by group and name.
   */
  getTask<PayloadType = any, ResultType = any>(groupName: string, name: string) {
    return this.client.getTask<PayloadType, ResultType>(groupName, name);
  }

  /**
   * Gets a task in the specified group with the provided data.
   *
   * @param taskKey The key of the task to run in format group.task.
   * @param data The data to pass to the task.
   * @returns A promise that resolves to the Job instance.
   */
  getTaskByKey<PayloadType = any, ResultType = any>(taskKey: `${string}.${string}`) {
    return this.client.getTaskByKey<PayloadType, ResultType>(taskKey);
  }

  /**
   * Runs a task in the specified group with the provided data.
   *
   * @param groupName The name of the task group.
   * @param taskId The name of the task to run.
   * @param data The data to pass to the task.
   * @returns A promise that resolves to the Job instance.
   */

  async runTask<PayloadType = any, ResultType = any>(groupName: string, taskId: string, payload: PayloadType) {
    return this.client.runTask<PayloadType, ResultType>(groupName, taskId, payload);
  }

  /**
   * Runs a task in the specified group with the provided data.
   *
   * @param taskKey The key of the task to run in format group.task.
   * @param data The data to pass to the task.
   * @returns A promise that resolves to the Job instance.
   */
  async runTaskByKey<PayloadType = any, ResultType = any>(key: `${string}.${string}`, payload: PayloadType) {
    return this.client.runTaskByKey<PayloadType, ResultType>(key, payload);
  }

  /**
   * Starts the workers for all managed TaskGroups (or filtered ones) and
   * attaches global error handlers if configured.
   *
   * @param filter Optional filter to target specific groups or tasks.
   * @param workerOptions Optional default BullMQ WorkerOptions to pass down.
   */
  async start(filter?: WorkerFilter, workerOptions?: WorkerOptions): Promise<void> {
    this.logger.info('Starting TaskServer...');

    // Attach global handlers if configured
    if (this.options.handleGlobalErrors) {
      this.attachGlobalErrorHandlers();
    }

    // TODO Add event dispatcher options somewhere, possibly create dedicated method on client
    await this.events.startWorker();

    // Start workers using the client's method, targeting managed groups
    const groupNames = Array.from(this.managedGroups).map((g) => g.name);
    const effectiveFilter: WorkerFilter = {
      ...(filter ?? {}),
      groups: filter?.groups ? filter.groups.filter((g) => groupNames.includes(g)) : groupNames,
    };

    if (effectiveFilter.groups?.length === 0 && filter?.groups) {
      this.logger.warn('No managed groups matched the provided group filter for starting workers.');
      return;
    }
    if (effectiveFilter.groups?.length === 0 && this.managedGroups.size > 0) {
      this.logger.warn('No groups are currently managed by the server to start workers for.');
      return;
    }

    await this.client.startWorkers(effectiveFilter, workerOptions);
    this.logger.info('TaskServer started, workers initialized.');
  }

  /**
   * Stops the workers for all managed TaskGroups (or filtered ones) and
   * removes global error handlers if they were attached by this server.
   *
   * @param filter Optional filter to target specific groups or tasks.
   * @returns A promise that resolves when workers have been requested to stop.
   */
  async stop(filter?: WorkerFilter): Promise<void> {
    this.logger.info('Stopping TaskServer...');

    // Stop workers using the client's method, targeting managed groups
    const groupNames = Array.from(this.managedGroups).map((g) => g.name);
    const effectiveFilter: WorkerFilter = {
      ...(filter ?? {}),
      groups: filter?.groups ? filter.groups.filter((g) => groupNames.includes(g)) : groupNames,
    };

    if (effectiveFilter.groups?.length === 0 && filter?.groups) {
      this.logger.warn('No managed groups matched the provided group filter for stopping workers.');
      // Proceed to detach handlers and potentially close client
    } else if (effectiveFilter.groups?.length === 0 && this.managedGroups.size > 0) {
      this.logger.warn('No groups are currently managed by the server to stop workers for.');
      // Proceed to detach handlers and potentially close client
    } else {
      await this.client.stopWorkers(effectiveFilter);
      this.logger.info('Request to stop workers completed.');
    }

    // Detach global handlers if we attached them
    this.detachGlobalErrorHandlers();

    // Optionally close the client if we created it
    if (this.ownClient) {
      this.logger.debug('Closing internally created ToroTask.');
      this.logger.debug('Closing internally created ToroTask.');
      await this.client.close();
    }
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

  private handleUnhandledRejection(reason: unknown, promise: Promise<unknown>): void {
    this.logger.fatal({ reason, promise }, 'Unhandled Promise Rejection detected by TaskServer');
    // Optional: Exit strategy or further action
    // process.exit(1);
  }

  private handleUncaughtException(error: Error, origin: NodeJS.UncaughtExceptionOrigin): void {
    this.logger.fatal({ err: error, origin }, 'Uncaught Exception detected by TaskServer');
    // Optional: Exit strategy (often recommended for uncaught exceptions)
    // process.exit(1);
  }
}
