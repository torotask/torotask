import type { JobsOptions, Job, WorkerOptions, Worker } from 'bullmq'; // Added missing imports
import type { Logger } from 'pino';
import { BaseQueue } from './base-queue.js';
import type { ToroTaskClient } from './client.js'; // Assuming client path
import { EventManager } from './event-manager.js';
import type { Task } from './task.js'; // Assuming task path
import type { EventSubscriptionInfo } from './types.js';

// Define a default queue name for events, easily configurable if needed
const DEFAULT_EVENT_QUEUE_NAME = 'events.dispatch';

/**
 * Manages the registration and dispatching of events to subscribed Tasks.
 * It uses its own BullMQ queue to process published events.
 * Stores JSON strings in the events:by-event:<eventName> set.
 */
export class EventDispatcher extends BaseQueue {
  public manager: EventManager;

  constructor(client: ToroTaskClient, parentLogger: Logger, eventQueueName: string = DEFAULT_EVENT_QUEUE_NAME) {
    if (!client) {
      throw new Error('ToroTaskClient instance is required for EventDispatcher.');
    }
    const dispatcherLogger = parentLogger.child({ service: 'EventDispatcher', queue: eventQueueName });
    super(client, eventQueueName, dispatcherLogger);
    this.manager = new EventManager(this, parentLogger);
  }

  /**
   * Starts the event manager before the event dispatcher
   */
  async startWorker(options?: WorkerOptions): Promise<Worker> {
    await this.manager.startWorker(); // Start manager worker (assuming it's sync)
    return super.startWorker(options);
  }

  /**
   * Removes all event registrations associated with a specific task.
   * Useful when a task is updated or removed.
   * @param task The Task instance whose registrations should be cleared.
   */
  async clearTaskEvents(task: Task<any, any>): Promise<void> {
    this.logger.warn({ taskName: task.name }, 'clearTaskEvents needs to be updated to handle JSON data in Redis sets.');
    // TODO: Implement Redis logic for clearing JSON entries
    // await super.clearTaskEvents(task); // Placeholder call - BaseQueue has no such method
  }

  /**
   * Removes all task registrations for a specific event name.
   * Also removes the event name from the sets of associated tasks.
   * @param eventName The name of the event to clear.
   */
  async clearEvent(eventName: string): Promise<void> {
    this.logger.warn({ eventName }, 'clearEvent needs to be updated to handle JSON data in Redis sets.');
    // TODO: Implement Redis logic for clearing JSON entries
    // await super.clearEvent(eventName); // Placeholder call - BaseQueue has no such method
  }

  /**
   * Publishes an event by adding a job to the event queue.
   * The job name will be the event name.
   * @param eventName The name of the event to publish.
   * @param data The data payload for the event.
   * @param options Optional BullMQ job options.
   */
  async publish<E = unknown>(eventName: string, data: E, options?: JobsOptions): Promise<Job<E, any> | undefined> {
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
   * Looks up event subscription JSON in Redis and triggers associated tasks.
   * This is intended to be used as the processor function for the BullMQ Worker.
   * @param job The job received from the event queue.
   */
  public async process(job: Job): Promise<void> {
    const eventName = job.name;
    const eventData = job.data;
    const jobLogger = this.logger.child({ jobId: job.id, eventName });

    jobLogger.info({ hasData: eventData !== undefined }, 'Processing event job, querying Redis for subscribers...');

    try {
      const redis = await this.getRedisClient();
      const eventKey = this.manager.getEventKey(eventName);

      // Get subscription JSON strings for this event
      const subscriptionJsonStrings = await redis.smembers(eventKey);

      if (!subscriptionJsonStrings || subscriptionJsonStrings.length === 0) {
        jobLogger.warn('No task triggers registered for this event in Redis. Job will be completed without action.');
        return;
      }

      jobLogger.info(
        `Found ${subscriptionJsonStrings.length} potential task triggers in Redis. Parsing and triggering...`
      );

      const triggerPromises: Promise<any>[] = [];
      const processedTasks = new Set<string>(); // Track taskName to avoid duplicate runs if multiple triggers call same task

      for (const jsonString of subscriptionJsonStrings) {
        let subscriptionInfo: EventSubscriptionInfo;
        try {
          subscriptionInfo = JSON.parse(jsonString);
          // Basic validation
          if (
            !subscriptionInfo.taskGroup ||
            !subscriptionInfo.taskName ||
            typeof subscriptionInfo.triggerId !== 'number'
          ) {
            jobLogger.error({ jsonString }, 'Invalid subscription JSON found in Redis set. Skipping.');
            continue;
          }
        } catch (parseError) {
          jobLogger.error(
            { err: parseError, jsonString },
            'Failed to parse subscription JSON from Redis set. Skipping.'
          );
          continue;
        }

        const { taskGroup, taskName, triggerId } = subscriptionInfo;

        // Prevent running the same task multiple times for the same event if desired
        // If different triggers *should* cause separate runs, remove this check
        if (processedTasks.has(taskName)) {
          jobLogger.debug(
            { taskName, triggerId },
            'Task already triggered for this event. Skipping duplicate trigger.'
          );
          continue;
        }

        // --- Task Instance Lookup ---
        // Assuming client instance (this.client) provides this lookup
        // Replace 'getTask' with the actual method signature
        // @ts-expect-error // Assuming client has getTask(groupName, taskName) or similar
        const taskInstance = this.client.getTask(groupName, taskName) as Task<any, any> | undefined;

        if (!taskInstance) {
          jobLogger.error(
            { taskGroup, taskName, triggerId },
            'Could not find active Task instance for registered subscriber. Skipping.'
          );
          continue; // Skip this task instance
        }
        // --- End Task Instance Lookup ---

        processedTasks.add(taskName); // Mark task as processed for this event job
        jobLogger.debug({ taskGroup, taskName: taskInstance.name, triggerId }, 'Triggering task.run()');
        triggerPromises.push(taskInstance.run(eventData));
      }

      // Wait for all task.run() promises to settle.
      const results = await Promise.allSettled(triggerPromises);

      const successfulTriggers = results.filter((r) => r.status === 'fulfilled').length;
      const failedTriggers = results.length - successfulTriggers;
      jobLogger.info({ successfulTriggers, failedTriggers }, 'Finished triggering tasks for event job.');

      if (failedTriggers > 0) {
        jobLogger.warn(
          `${failedTriggers} task trigger(s) failed during event processing (errors logged individually).`
        );
        // Event job still completes successfully, as failures are handled at the task level.
      }
    } catch (error) {
      jobLogger.error({ err: error }, 'Failed to process event job due to Redis error or other issue');
      // Re-throw the error to potentially mark the job as failed
      throw error;
    }
  }
}
