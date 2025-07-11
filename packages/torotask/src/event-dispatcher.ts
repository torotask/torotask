import type { WorkerOptions } from 'bullmq'; // Added missing imports
import type { Logger } from 'pino';
import type { ToroTask } from './client.js'; // Assuming client path
import { EventManager } from './event-manager.js';
import type { TaskJob } from './job.js';
import type { Task } from './task.js'; // Assuming task path
import type { EventSubscriptionInfo, SyncJobReturn, TaskJobOptions } from './types/index.js';
import { TaskWorkerQueue } from './worker-queue.js';

// Define a default queue name for events, easily configurable if needed
const DEFAULT_EVENT_QUEUE_NAME = 'events.dispatch';
const SET_ACTIVE_DEBOUNCE_MS = 500; // Debounce time in milliseconds

type PayloadType = any;
type ReturnType = any;

/**
 * Manages the registration and dispatching of events to subscribed Tasks.
 * It uses its own BullMQ queue to process published events.
 * Maintains a local cache (`activeEvents`) of events presumed to have subscribers.
 */
export class EventDispatcher extends TaskWorkerQueue<PayloadType, ReturnType> {
  public manager: EventManager;
  public activeEvents: Set<string> = new Set(); // Use Set for efficient lookups
  public subscribedToActiveEvents = false; // Track if we are subscribed to active events
  public disableSubscription = false; // Flag to disable subscription to active events
  private setActiveEventsDebounced: () => void;
  private setActiveEventsTimeout: NodeJS.Timeout | null = null;

  constructor(taskClient: ToroTask, parentLogger: Logger, name: string = DEFAULT_EVENT_QUEUE_NAME) {
    const logger = parentLogger.child({ service: 'EventDispatcher', queue: name });
    super(taskClient, name, { logger });
    this.manager = new EventManager(taskClient, parentLogger);

    // Simple debounce implementation
    this.setActiveEventsDebounced = () => {
      if (this.setActiveEventsTimeout) {
        clearTimeout(this.setActiveEventsTimeout);
      }
      this.setActiveEventsTimeout = setTimeout(() => {
        this.setActiveEvents().catch((err) => {
          this.logger.error({ err }, 'Error during debounced setActiveEvents execution');
        });
      }, SET_ACTIVE_DEBOUNCE_MS);
    };
  }

  async subscribeToActiveEvents() {
    if (this.subscribedToActiveEvents) {
      return;
    }

    await this.setActiveEvents();

    this.manager.queueEvents.on('completed', ({ jobId, returnvalue }) => {
      this.logger.debug({ jobId, returnvalue }, 'EventManager sync job completed');
      // Type guard to ensure returnvalue is actually SyncJobReturn
      const isSyncResult =
        returnvalue !== null &&
        typeof returnvalue === 'object' &&
        typeof (returnvalue as SyncJobReturn).registered === 'number' &&
        typeof (returnvalue as SyncJobReturn).unregistered === 'number';

      if (isSyncResult) {
        const syncResult = returnvalue as SyncJobReturn;
        if (syncResult.registered > 0 || syncResult.unregistered > 0) {
          this.logger.info(
            { syncResult },
            'Detected registration changes, triggering debounced active events refresh.'
          );
          this.setActiveEventsDebounced(); // Trigger refresh
        }
      }
    });

    this.subscribedToActiveEvents = true;
  }

  /**
   * Starts the event manager before the event dispatcher
   */
  async startWorker(options?: WorkerOptions) {
    await this.manager.startWorker();
    if (!this.disableSubscription) {
      await this.subscribeToActiveEvents();
    }
    // Now start the actual worker for this dispatcher's queue
    return super.startWorker(options);
  }

  /**
   * Fetches the list of event keys from Redis and updates the local activeEvents cache.
   * Note: This scans keys, but doesn't verify HLEN > 0 for each. It assumes
   * the existence of the key implies active subscribers for performance.
   */
  async setActiveEvents(): Promise<void> {
    this.logger.debug('Refreshing local activeEvents cache from Redis...');
    const redis = await this.getRedisClient();
    const newActiveEvents = new Set<string>();

    // Construct the pattern based on the manager's prefix and key structure
    const prefix = this.manager.prefix ? `${this.manager.prefix}:` : '';
    const pattern = `${prefix}events:by-event:*`;
    const keyPrefixToRemove = `${prefix}events:by-event:`; // Used to extract event name

    let cursor = '0';
    try {
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        keys.forEach((key) => {
          if (key.startsWith(keyPrefixToRemove)) {
            const eventName = key.substring(keyPrefixToRemove.length);
            newActiveEvents.add(eventName);
          }
        });
        cursor = nextCursor;
      } while (cursor !== '0');

      this.activeEvents = newActiveEvents;
      this.logger.debug({ count: this.activeEvents.size }, 'Local activeEvents cache refreshed.');
    } catch (error) {
      this.logger.error({ err: error, pattern }, 'Failed to scan event keys from Redis for activeEvents cache.');
      // Decide: Keep stale cache or clear it? Keeping stale might be safer.
      throw error; // Re-throw to indicate failure
    }
  }

  /**
   * Removes all event registrations associated with a specific task.
   * Useful when a task is updated or removed.
   * @param task The Task instance whose registrations should be cleared.
   */
  async clearTaskEvents(task: Task<any, any>): Promise<void> {
    this.logger.warn({ taskId: task.id }, 'clearTaskEvents needs to be updated to handle JSON data in Redis sets.');
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
   * Sends an event by adding a job to the event queue.
   * The job name will be the event name.
   * @param eventName The name of the event to send.
   * @param data The data payload for the event.
   * @param options Optional BullMQ job options.
   */
  async send<E = unknown>(
    eventName: string,
    data: E,
    options?: TaskJobOptions
  ): Promise<TaskJob<PayloadType, any> | undefined> {
    if (!eventName || typeof eventName !== 'string' || eventName.trim() === '') {
      this.logger.error({ eventName }, 'Invalid event name provided for publishing.');
      throw new Error('Event name cannot be empty.');
    }
    const jobName = eventName.trim(); // Use event name as job name

    if (this.disableSubscription) {
      await this.setActiveEvents(); // Ensure we have the latest active events
    } else {
      await this.subscribeToActiveEvents(); // Ensure we are subscribed to active events
    }

    // --- Check local cache for active subscribers before adding job ---
    if (!this.activeEvents.has(jobName)) {
      this.logger.debug({ eventName: jobName }, 'Skipping event publish: No active subscribers found in local cache.');
      return undefined; // Indicate that the job was not added
    }
    // --- End Check ---

    this.logger.debug(
      { eventName: jobName, hasData: data !== undefined },
      'Publishing event (subscribers likely exist in cache)'
    );
    // Use the queue inherited from BaseQueue to add the job
    return this.add(jobName, data, options);
  }

  /**
   * Processes jobs from the event queue.
   * Looks up event subscription JSON in Redis Hash using the EventManager
   * and triggers associated tasks by adding jobs to their respective queues.
   * This is intended to be used as the processor function for the BullMQ Worker.
   * @param job The job received from the event queue.
   */
  public async process(job: TaskJob): Promise<void> {
    const eventName = job.name;
    const eventPayload = job.payload;
    const jobLogger = this.logger.child({ jobId: job.id, eventName });

    jobLogger.debug(
      { hasPayload: eventPayload !== undefined },
      'Processing event job, querying Redis Hash for subscribers via EventManager...'
    );

    try {
      // This method handles using HVALS and parsing the JSON strings.
      const subscriptions: EventSubscriptionInfo[] = await this.manager.subscriptions.getForEvent(eventName);

      if (!subscriptions || subscriptions.length === 0) {
        jobLogger.debug('No registered task subscriptions found for this event in Redis Hash.');
        // No subscribers, so the job is successfully processed (did nothing).
        return;
      }

      jobLogger.debug(
        { count: subscriptions.length },
        'Found subscriptions, dispatching jobs to target task queues...'
      );

      // --- Dispatch to each subscribed task's queue ---
      const dispatchPromises: Promise<any>[] = []; // Store promises for logging/waiting

      for (const subInfo of subscriptions) {
        // Ensure we have the necessary info to target the task queue
        if (!subInfo.taskGroup || !subInfo.taskId) {
          jobLogger.warn(
            { subscriptionInfo: subInfo },
            'Skipping dispatch: Subscription info missing taskGroup or taskId.'
          );
          continue;
        }

        // Construct the target task's queue name.
        // Assumes your client or BaseQueue structure provides a way to get other queues.
        // You might need to adapt this part based on your actual implementation for accessing other task queues.
        let taskInstance;
        try {
          taskInstance = this.taskClient.getTask(subInfo.taskGroup, subInfo.taskId) as Task<any, any> | undefined;
        } catch (taskError) {
          jobLogger.error(
            { err: taskError, taskGroup: subInfo.taskGroup, taskId: subInfo.taskId },
            'Failed to get target task instance.'
          );
          continue; // Skip this subscription if queue cannot be obtained
        }
        const mergedPayload = {
          ...eventPayload,
          ...subInfo.payload,
        };
        if (taskInstance) {
          dispatchPromises.push(taskInstance.run(mergedPayload));
        } else {
          jobLogger.error(
            { taskGroup: subInfo.taskGroup, taskId: subInfo.taskId },
            'Could not get target task instance for dispatch (was null/undefined).'
          );
        }
      } // end for loop

      // Wait for all dispatches to attempt completion
      const results = await Promise.allSettled(dispatchPromises);
      const successfulDispatches = results.filter((r) => r.status === 'fulfilled').length;
      const failedDispatches = results.length - successfulDispatches;

      jobLogger.debug(
        { successful: successfulDispatches, failed: failedDispatches, total: results.length },
        'Finished dispatching event to subscribed tasks.'
      );

      // If any dispatch failed, throw an error to mark the main event job as failed
      if (failedDispatches > 0) {
        // Collect reasons for logging or more specific error message
        const errors = results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason);
        jobLogger.error({ errors, failedCount: failedDispatches }, 'One or more dispatches to tasks failed.');
        throw new Error(`Failed to dispatch event to ${failedDispatches} task(s).`);
      }
    } catch (error) {
      jobLogger.error(
        { err: error },
        'Failed to process event job due to an error retrieving subscriptions or dispatching.'
      );
      // Re-throw the error so BullMQ knows the job failed and can handle retries etc.
      throw error;
    }
  }
}
