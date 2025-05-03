import type { Job, JobProgress } from 'bullmq';
import type { BaseTask } from '../base-task.js';
import type { Logger } from 'pino';
// Import the interface, which will be renamed to TaskRun
import type { TaskRunInterface } from '../types/task-run.js';

/**
 * Implementation class for a TaskRun. Use TaskRunImplementation.create() to get a proxied instance.
 * The proxied instance conforms to the TaskRun interface (previously TaskRunJob).
 *
 * @internal - Consumers should use the TaskRun interface type.
 */
export class TaskRunImplementation<T = unknown, R = unknown> {
  // Public properties specific to TaskRun
  public readonly task: BaseTask<T, R>; // Keep internal reference as BaseTask
  public readonly logger: Logger;

  // Store the original job privately
  private readonly _originalJob: Job<T, R>;

  /**
   * Private constructor. Use TaskRunImplementation.create() instead.
   * @param task The Task definition (BaseTask).
   * @param originalJob The original BullMQ Job instance.
   * @param logger The logger instance for this task run.
   */
  private constructor(task: BaseTask<T, R>, originalJob: Job<T, R>, logger: Logger) {
    this.task = task;
    this.logger = logger;
    this._originalJob = originalJob;
    // Bind custom methods defined on this class to ensure correct 'this' when called via proxy
    this.updateProgress = this.updateProgress.bind(this);
    // Add bindings for any other custom methods here
  }

  /**
   * Creates a proxied TaskRun instance conforming to the TaskRun interface.
   * @param task The Task definition (BaseTask).
   * @param originalJob The original BullMQ Job instance.
   * @param logger The logger instance for this task run.
   * @returns A Proxy that behaves like the Job but includes TaskRun context, typed as TaskRunInterface.
   */
  public static create<T = unknown, R = unknown>(
    task: BaseTask<T, R>,
    originalJob: Job<T, R>,
    logger: Logger
  ): TaskRunInterface<T, R> {
    // Return the interface type
    const taskRunInstance = new TaskRunImplementation(task, originalJob, logger);

    const handler: ProxyHandler<TaskRunImplementation<T, R>> = {
      // ... existing proxy handler logic (get, set, has, etc.) ...
      get(target, prop, receiver) {
        // Prioritize properties/methods defined directly on TaskRun instance
        // Need to check the instance prototype as well for methods
        if (prop in target || Object.prototype.hasOwnProperty.call(target.constructor.prototype, prop)) {
          return Reflect.get(target, prop, receiver);
        }

        // If not on TaskRun, delegate to the originalJob
        const jobValue = Reflect.get(target._originalJob, prop); // Get from original job

        if (typeof jobValue === 'function') {
          // It's a method on the original Job - return a wrapped version
          return (...args: any[]) => {
            target.logger.trace(
              { jobId: target._originalJob.id, method: String(prop), args },
              `Calling proxied job method "${String(prop)}"`
            );
            try {
              // Call original job method with original job as 'this' context
              const result = Reflect.apply(jobValue, target._originalJob, args);

              // Handle potential promises
              if (result instanceof Promise) {
                return result
                  .then((resolvedResult) => {
                    target.logger.trace(
                      { jobId: target._originalJob.id, method: String(prop), result: resolvedResult },
                      `Proxied job method "${String(prop)}" resolved`
                    );
                    return resolvedResult;
                  })
                  .catch((error) => {
                    target.logger.error(
                      {
                        jobId: target._originalJob.id,
                        method: String(prop),
                        err: error instanceof Error ? error : new Error(String(error)),
                      },
                      `Proxied job method "${String(prop)}" rejected`
                    );
                    throw error; // Re-throw
                  });
              }

              // Handle synchronous results
              target.logger.trace(
                { jobId: target._originalJob.id, method: String(prop), result },
                `Proxied job method "${String(prop)}" returned`
              );
              return result;
            } catch (error) {
              target.logger.error(
                {
                  jobId: target._originalJob.id,
                  method: String(prop),
                  err: error instanceof Error ? error : new Error(String(error)),
                },
                `Error calling proxied job method "${String(prop)}"`
              );
              throw error; // Re-throw
            }
          };
        } else if (jobValue !== undefined || prop in target._originalJob) {
          // It's a property on the original Job
          return jobValue;
        }

        // Property not found on TaskRun or originalJob
        return undefined;
      },
      set(target, prop, value, receiver): boolean {
        // If property exists on TaskRun instance (or its prototype), disallow setting
        if (prop in target || Object.prototype.hasOwnProperty.call(target.constructor.prototype, prop)) {
          // Allow setting internal _originalJob
          if (prop === '_originalJob') {
            return Reflect.set(target, prop, value, receiver);
          }
          target.logger.warn(
            `Attempted to set property "${String(prop)}" which exists directly on TaskRun instance or prototype. Set operation denied.`
          );
          return false; // Indicate failure: cannot set properties on TaskRun directly
        }

        // If not on TaskRun, attempt to set on originalJob
        target.logger.trace(
          { jobId: target._originalJob.id, property: String(prop), value },
          `Setting proxied job property "${String(prop)}"`
        );
        try {
          // Delegate setting to the original job
          return Reflect.set(target._originalJob, prop, value);
        } catch (error) {
          target.logger.error(
            { jobId: target._originalJob.id, property: String(prop), err: error },
            `Error setting proxied job property "${String(prop)}"`
          );
          return false; // Indicate failure
        }
      },
      has(target, prop): boolean {
        // Check if property exists on TaskRun (instance or prototype) or the original Job
        return (
          prop in target ||
          Object.prototype.hasOwnProperty.call(target.constructor.prototype, prop) ||
          prop in target._originalJob
        );
      },
      ownKeys(target): ArrayLike<string | symbol> {
        // Combine keys from TaskRun instance/prototype and the original Job, removing duplicates
        const taskRunInstanceKeys = Reflect.ownKeys(target);
        const taskRunProtoKeys = Reflect.ownKeys(target.constructor.prototype);
        const jobKeys = Reflect.ownKeys(target._originalJob);
        // Filter out constructor and private properties from prototype
        const filteredProtoKeys = taskRunProtoKeys.filter(
          (key) => key !== 'constructor' && !String(key).startsWith('_')
        );
        return Array.from(new Set([...taskRunInstanceKeys, ...filteredProtoKeys, ...jobKeys]));
      },
      getOwnPropertyDescriptor(target, prop): PropertyDescriptor | undefined {
        // Check TaskRun instance first
        if (Reflect.has(target, prop)) {
          return Reflect.getOwnPropertyDescriptor(target, prop);
        }
        // Check TaskRun prototype
        if (Object.prototype.hasOwnProperty.call(target.constructor.prototype, prop)) {
          return Reflect.getOwnPropertyDescriptor(target.constructor.prototype, prop);
        }
        // Check the original Job
        return Reflect.getOwnPropertyDescriptor(target._originalJob, prop);
      },
    };

    // Use double assertion to satisfy TypeScript
    return new Proxy(taskRunInstance, handler) as unknown as TaskRunInterface<T, R>;
  }

  // --- Example of a custom method specific to TaskRun ---
  /**
   * Custom implementation for updating job progress, adding TaskRun-specific logging.
   * This method exists directly on TaskRun and will be hit first by the proxy.
   * It then calls the underlying job's updateProgress via the proxy mechanism.
   *
   * @param value The progress value (number or object).
   */
  async updateProgress(value: JobProgress): Promise<void> {
    this.logger.info(
      { progress: value, jobId: this._originalJob.id },
      'TaskRun: Custom updateProgress invoked. Preparing to call original job method.'
    );

    try {
      // Call the original method directly on the internal job reference
      await this._originalJob.updateProgress(value);

      this.logger.info(
        { progress: value, jobId: this._originalJob.id },
        'TaskRun: Custom updateProgress successfully called original job method.'
      );
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error : new Error(String(error)), jobId: this._originalJob.id },
        'TaskRun: Custom updateProgress failed when calling original job method.'
      );
      throw error; // Re-throw
    }
  }
}
