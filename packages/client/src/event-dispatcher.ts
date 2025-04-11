import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { Queue, Worker } from 'bullmq'; // Import Worker
import { BaseQueue } from './base-queue.js';
import type { ToroTaskClient } from './client.js'; // Assuming client path
import type { Task } from './task.js'; // Assuming task path
import type { JobsOptions, Job, WorkerOptions } from 'bullmq'; // Added missing imports

// Define a default queue name for events, easily configurable if needed
const DEFAULT_EVENT_QUEUE_NAME = 'events';

/**
 * Manages the registration and dispatching of events to subscribed Tasks.
 * It uses its own BullMQ queue to process published events.
 */
export class EventDispatcher extends BaseQueue {
  // In-memory registry for now. Could be moved to Redis later.
  // Map<eventName, Set<Task Instance>>
  private eventRegistry: Map<string, Set<Task<any, any>>> = new Map();

  constructor(client: ToroTaskClient, parentLogger: Logger, eventQueueName: string = DEFAULT_EVENT_QUEUE_NAME) {
    if (!client) {
      throw new Error('ToroTaskClient instance is required for EventDispatcher.');
    }
    const dispatcherLogger = parentLogger.child({ service: 'EventDispatcher', queue: eventQueueName });
    super(client, eventQueueName, dispatcherLogger);
  }

  /**
   * Registers a task to be triggered when a specific event occurs.
   * @param eventName The name of the event to subscribe to.
   * @param task The Task instance that should handle the event.
   */
  async registerTaskEvent(eventName: string, task: Task<any, any>): Promise<void> {
    this.logger.debug({ eventName, taskName: task.name }, 'Registering task for event');
    if (!this.eventRegistry.has(eventName)) {
      this.eventRegistry.set(eventName, new Set());
    }
    const listeners = this.eventRegistry.get(eventName);
    if (!listeners?.has(task)) {
      listeners?.add(task);
      this.logger.info({ eventName, taskName: task.name, listenerCount: listeners?.size }, 'Task registered for event');
    } else {
      this.logger.warn({ eventName, taskName: task.name }, 'Task already registered for this event.');
    }
    // TODO: Persist registration if using Redis for registry
  }

  /**
   * Unregisters a task from a specific event.
   * @param eventName The name of the event.
   * @param task The Task instance to unregister.
   */
  async unregisterTaskEvent(eventName: string, task: Task<any, any>): Promise<void> {
    this.logger.debug({ eventName, taskName: task.name }, 'Unregistering task from event');
    const tasks = this.eventRegistry.get(eventName);
    if (tasks) {
      const deleted = tasks.delete(task);
      if (deleted) {
        if (tasks.size === 0) {
          this.eventRegistry.delete(eventName);
          this.logger.info({ eventName, taskName: task.name }, 'Task unregistered, event removed (no listeners left)');
        } else {
          this.logger.info(
            { eventName, taskName: task.name, listenerCount: tasks.size },
            'Task unregistered from event'
          );
        }
      } else {
        this.logger.warn(
          { eventName, taskName: task.name },
          'Attempted to unregister task from event, but task was not registered for it.'
        );
      }
      // TODO: Update persisted registration if using Redis
    } else {
      this.logger.warn(
        { eventName, taskName: task.name },
        'Attempted to unregister task from event, but event not found in registry'
      );
    }
  }

  /**
   * Removes all event registrations associated with a specific task.
   * Useful when a task is updated or removed.
   * @param task The Task instance whose registrations should be cleared.
   */
  async clearTaskEvents(task: Task<any, any>): Promise<void> {
    this.logger.debug({ taskName: task.name }, 'Clearing all event registrations for task');
    let clearedCount = 0;
    // Iterate over a copy of keys to allow modification during iteration
    const eventNames = Array.from(this.eventRegistry.keys());
    for (const eventName of eventNames) {
      const tasks = this.eventRegistry.get(eventName);
      // Check if tasks set still exists (it might have been deleted if another task cleared it)
      if (tasks && tasks.has(task)) {
        tasks.delete(task);
        clearedCount++;
        if (tasks.size === 0) {
          this.eventRegistry.delete(eventName);
          this.logger.info(
            { eventName, taskName: task.name },
            'Cleared task registration, event removed (no listeners left)'
          );
        }
      }
    }
    this.logger.info({ taskName: task.name, clearedCount }, 'Finished clearing event registrations for task');
    // TODO: Update persisted registrations if using Redis
  }

  /**
   * Removes all task registrations for a specific event name.
   * @param eventName The name of the event to clear.
   */
  async clearEvent(eventName: string): Promise<void> {
    this.logger.debug({ eventName }, 'Clearing all task registrations for event');
    const listenerCount = this.eventRegistry.get(eventName)?.size ?? 0;
    if (this.eventRegistry.delete(eventName)) {
      this.logger.info({ eventName, listenerCount }, 'Event cleared from registry');
    } else {
      this.logger.warn({ eventName }, 'Attempted to clear event, but event not found in registry');
    }
    // TODO: Update persisted registrations if using Redis
  }

  /**
   * Publishes an event by adding a job to the event queue.
   * The job name will be the event name.
   * @param eventName The name of the event to publish.
   * @param data The data payload for the event.
   * @param options Optional BullMQ job options.
   */
  async publishEvent<E = unknown>(eventName: string, data: E, options?: JobsOptions): Promise<Job<E, any>> {
    if (!eventName || typeof eventName !== 'string' || eventName.trim() === '') {
      this.logger.error({ eventName }, 'Invalid event name provided for publishing.');
      throw new Error('Event name cannot be empty.');
    }
    const jobName = eventName.trim(); // Use event name as job name
    this.logger.info({ eventName: jobName, hasData: data !== undefined }, 'Publishing event');
    // Use the queue inherited from BaseQueue to add the job
    return this.queue.add(jobName, data, options);
  }

  /**
   * Processes jobs from the event queue.
   * Looks up the event name (job name) in the registry and triggers associated tasks.
   * This is intended to be used as the processor function for the BullMQ Worker.
   * @param job The job received from the event queue.
   */
  public async process(job: Job): Promise<void> {
    const eventName = job.name;
    const eventData = job.data;
    const jobLogger = this.logger.child({ jobId: job.id, eventName });

    jobLogger.info({ hasData: eventData !== undefined }, 'Processing event job');

    const subscribedTasks = this.eventRegistry.get(eventName);

    if (!subscribedTasks || subscribedTasks.size === 0) {
      jobLogger.warn('No tasks registered for this event. Job will be completed without action.');
      // Depending on requirements, could move to failed status instead
      // Consider adding `token` to process signature if needed: await job.moveToFailed({ message: `...` }, job.token);
      return;
    }

    jobLogger.info(`Found ${subscribedTasks.size} subscribed tasks. Triggering runs...`);

    const triggerPromises: Promise<any>[] = [];
    subscribedTasks.forEach((task) => {
      jobLogger.debug({ taskName: task.name }, 'Triggering task.run()');
      // Trigger the task's main handler with the event data.
      triggerPromises.push(
        task
          .run(eventData) // Pass event data directly
          .then((createdJob) => {
            jobLogger.info({ taskName: task.name, createdJobId: createdJob.id }, 'Task run initiated successfully.');
          })
          .catch((err) => {
            jobLogger.error({ err, taskName: task.name }, 'Failed to initiate task run for event');
            // Log the error and continue. Do not fail the event job here.
          })
      );
    });

    // Wait for all task.run() promises to settle.
    const results = await Promise.allSettled(triggerPromises);

    const successfulTriggers = results.filter((r) => r.status === 'fulfilled').length;
    const failedTriggers = results.length - successfulTriggers;
    jobLogger.info({ successfulTriggers, failedTriggers }, 'Finished triggering tasks for event job.');

    if (failedTriggers > 0) {
      jobLogger.warn(`${failedTriggers} task trigger(s) failed during event processing (errors logged individually).`);
      // Event job still completes successfully, as failures are handled at the task level.
    }
  }
}
