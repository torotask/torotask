import { ToroTaskClient, TaskGroup, WorkerFilter, ConnectionOptions, TaskHandler, TaskOptions } from '@torotask/client';
import { pino, type Logger, type DestinationStream, type LoggerOptions } from 'pino';
import { WorkerOptions, Job } from 'bullmq';
import { glob } from 'glob';
import path from 'path';
import fs from 'fs';

const LOGGER_NAME = 'TaskServer';

/** Options for configuring the TaskServer */
export interface TaskServerOptions {
  /**
   * ToroTaskClient instance to use.
   * If not provided, connection options must be supplied to create one.
   */
  client?: ToroTaskClient;
  /**
   * Options to create a ToroTaskClient if an instance is not provided.
   * Ignored if `client` is provided.
   */
  clientOptions?: ConstructorParameters<typeof ToroTaskClient>[0];
  /**
   * Pino logger instance or options.
   * If neither is provided, a default logger will be created.
   */
  logger?: Logger | DestinationStream | pino.LoggerOptions;
  /** Logger name to use if creating a logger */
  loggerName?: string;
  /**
   * Whether the server should attach listeners to
   * process.on('unhandledRejection') and process.on('uncaughtException').
   * Defaults to true.
   */
  handleGlobalErrors?: boolean;
}

/** Type definition for the expected export from a task file */
export interface TaskModule<T = unknown, R = unknown> {
  handler: TaskHandler<T, R>;
  options?: TaskOptions;
}

/**
 * A server class responsible for managing the lifecycle of BullMQ workers
 * based on TaskGroup definitions from the client package.
 * Provides features like centralized worker start/stop and optional global error handling.
 */
export class TaskServer {
  public readonly client: ToroTaskClient;
  public readonly logger: Logger;
  private readonly options: Required<Pick<TaskServerOptions, 'handleGlobalErrors'>>;
  private readonly managedGroups: Set<TaskGroup> = new Set();
  private readonly ownClient: boolean = false; // Did we create the client?

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

    // Initialize Client
    if (options.client) {
      this.client = options.client;
      this.ownClient = false;
      this.logger.info('Using provided ToroTaskClient instance.');
    } else {
      const clientOptions = options.clientOptions ?? {};
      this.client = new ToroTaskClient({
        ...clientOptions,
        logger: clientOptions.logger ?? this.logger.child({ component: 'ToroTaskClient' }),
      });
      this.ownClient = true;
      this.logger.info('Created new ToroTaskClient instance.');
    }

    // Store other options with defaults
    this.options = {
      handleGlobalErrors: options.handleGlobalErrors ?? true,
    };

    this.logger.info('TaskServer initialized');
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
          'TaskGroup added was created with a different ToroTaskClient instance. This may cause issues.'
        );
      }
      this.logger.debug({ groupName: group.name }, 'Adding TaskGroup');
      this.managedGroups.add(group);
    });
    return this;
  }

  /**
   * Scans a directory for task definition files and loads them.
   * Assumes a structure like `baseDir/groupName/taskName.task.{js,ts}`.
   * Expects task files to have a default export: `{ handler: TaskHandler, options?: TaskOptions }`.
   *
   * @param baseDir The absolute path to the base directory containing task groups.
   * @param pattern Glob pattern relative to baseDir (defaults to `**\/*.task.{js,ts}`).
   */
  async loadTasksFromDirectory(baseDir: string, pattern?: string): Promise<void> {
    const effectivePattern = pattern ?? '**/*.task.{js,ts}';

    this.logger.info({ baseDir, pattern: effectivePattern }, 'Loading tasks from directory...');

    if (!path.isAbsolute(baseDir)) {
      this.logger.warn(
        { baseDir },
        'Provided baseDir is not absolute. Resolving relative to CWD. This might be unreliable.'
      );
      baseDir = path.resolve(baseDir);
    }

    try {
      if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) {
        throw new Error(`Base directory does not exist or is not a directory: ${baseDir}`);
      }
    } catch (error) {
      this.logger.error({ baseDir, err: error }, 'Failed to access base task directory.');
      throw error; // Re-throw for clarity
    }

    const searchPattern = path.join(baseDir, effectivePattern).replace(/\\/g, '/');
    const taskFiles = await glob(searchPattern, { absolute: true });

    this.logger.info({ count: taskFiles.length }, 'Found potential task files');

    let loadedCount = 0;
    let errorCount = 0;

    for (const filePath of taskFiles) {
      // Use require instead of dynamic import for broader compatibility
      // const fileUrl = path.fileURLToPath(filePath); // No longer needed for require
      try {
        const relativePath = path.relative(baseDir, filePath);
        const groupName = path.dirname(relativePath);
        const fileName = path.basename(relativePath);
        const taskNameMatch = fileName.match(/^(.+?)\.task\.(js|ts)$/);

        if (!groupName || groupName === '.' || !taskNameMatch?.[1]) {
          this.logger.warn({ filePath, relativePath }, 'Could not determine group/task name from file path. Skipping.');
          continue;
        }
        const taskName = taskNameMatch[1];

        this.logger.debug({ groupName, taskName, filePath }, 'Loading task definition...');

        // Use require to load the task module
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const taskModule = require(filePath) as { default?: TaskModule };

        // Validate the export (require often puts default under .default)
        if (!taskModule || typeof taskModule.default?.handler !== 'function') {
          // Handle cases where module might not use default export
          if (typeof (taskModule as unknown as TaskModule).handler === 'function') {
            // Handle commonjs export: module.exports = { handler: ... }
            const directExport = taskModule as unknown as TaskModule;
            const group = this.client.createTaskGroup(groupName);
            this.managedGroups.add(group);
            group.defineTask(taskName, directExport.handler, directExport.options);
          } else {
            throw new Error(
              `Invalid or missing export in task file. Expected { handler: function, options?: object } via default or module.exports.`
            );
          }
        } else {
          // Handle ES Module default export: export default { handler: ... }
          const defaultExport = taskModule.default;
          const group = this.client.createTaskGroup(groupName);
          this.managedGroups.add(group);
          group.defineTask(taskName, defaultExport.handler, defaultExport.options);
        }

        this.logger.info({ groupName, taskName }, 'Successfully loaded and defined task.');
        loadedCount++;
      } catch (error) {
        this.logger.error({ filePath, err: error }, 'Failed to load or define task from file.');
        errorCount++;
      }
    }

    this.logger.info(
      { loaded: loadedCount, errors: errorCount, totalFound: taskFiles.length },
      'Finished loading tasks from directory.'
    );
    if (errorCount > 0) {
      // Optionally throw an aggregate error or indicate failure
    }
  }

  /**
   * Starts the workers for all managed TaskGroups (or filtered ones) and
   * attaches global error handlers if configured.
   *
   * @param filter Optional filter to target specific groups or tasks.
   * @param workerOptions Optional default BullMQ WorkerOptions to pass down.
   */
  start(filter?: WorkerFilter, workerOptions?: WorkerOptions): void {
    this.logger.info('Starting TaskServer...');

    // Attach global handlers if configured
    if (this.options.handleGlobalErrors) {
      this.attachGlobalErrorHandlers();
    }

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

    this.client.startWorkers(effectiveFilter, workerOptions);
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
      this.logger.info('Closing internally created ToroTaskClient.');
      await this.client.close();
    }
    this.logger.info('TaskServer stopped.');
  }

  private attachGlobalErrorHandlers(): void {
    if (this.unhandledRejectionListener || this.uncaughtExceptionListener) {
      this.logger.warn('Global error handlers already attached, detaching first.');
      this.detachGlobalErrorHandlers();
    }
    this.logger.info('Attaching global error handlers (unhandledRejection, uncaughtException)');

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
