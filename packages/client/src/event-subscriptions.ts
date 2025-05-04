import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { EventSubscriptionInfo } from './types/index.js';

// Define Redis key prefixes
const EVENT_BY_EVENT_PREFIX = 'events:by-event';
const TASK_INDEX_PREFIX = 'events:task-index';

/**
 * Manages the persistence of event subscriptions in Redis.
 * Encapsulates all direct Redis interactions related to event subscriptions.
 */
export class EventSubscriptions {
  private readonly redis: Redis;
  private readonly logger: Logger;
  public readonly prefix: string;

  constructor(redisClient: Redis, prefix: string, logger: Logger) {
    this.redis = redisClient;
    // Store the prefix without the trailing colon, matching original BaseQueue behavior
    this.prefix = prefix;
    this.logger = logger.child({ class: 'EventSubscriptionRepository' });
  }

  /**
   * Generates the Redis key for storing subscriptions for a specific event.
   * Matches the original EventManager logic.
   * @param eventName - The name of the event.
   * @returns The Redis key string.
   */
  getEventKey(eventName: string): string {
    const prefix = this.prefix ? `${this.prefix}:` : '';
    return `${prefix}${EVENT_BY_EVENT_PREFIX}:${eventName}`;
  }

  /**
   * Gets the Redis key for the Set containing event names a task is subscribed to.
   * @param taskGroup Task group name.
   * @param taskName Task name.
   * @returns The Redis key string.
   */
  getTaskIndexKey(taskGroup: string, taskName: string): string {
    const prefix = this.prefix ? `${this.prefix}:` : '';
    return `${prefix}${TASK_INDEX_PREFIX}:${taskGroup}:${taskName}`;
  }

  /**
   * Generates a unique identifier string for a subscription to be used as a field key in Redis Hashes.
   * @param info The EventSubscriptionInfo object.
   * @returns A string identifier (e.g., "group:task:trigger:123" or "group:task:event:abc").
   */
  public getIdentifier(info: EventSubscriptionInfo): string {
    const { taskGroup, taskName, triggerId, eventId } = info;
    let suffix = '';
    if (triggerId !== undefined) {
      suffix = `:trigger:${triggerId}`;
    } else if (eventId !== undefined) {
      // Use eventId if triggerId is not present (for non-trigger subscriptions)
      suffix = `:event:${eventId}`;
    } else {
      // Fallback or error needed if neither is defined?
      this.logger.warn({ info }, 'Subscription info lacks both triggerId and eventId for identifier generation');
      // Using a generic suffix, but this might cause collisions if multiple non-id event subs exist per task
      suffix = ':event:unidentified';
    }
    // Consistent identifier format
    return `${taskGroup}:${taskName}${suffix}`;
  }

  /**
   * Registers a new event subscription in Redis.
   * Adds the subscription details to the event's hash and adds the event name to the task's index set.
   * Matches the original EventManager.registerTaskEvent logic.
   * @param eventName - The name of the event to subscribe to.
   * @param info - The subscription information.
   * @returns A promise resolving when the registration is complete.
   */
  async register(eventName: string, info: EventSubscriptionInfo): Promise<void> {
    const eventKey = this.getEventKey(eventName);
    const taskIndexKey = this.getTaskIndexKey(info.taskGroup, info.taskName);
    const subscriptionId = this.getIdentifier(info);
    const subscriptionData = JSON.stringify(info);

    this.logger.debug({ eventName, info, subscriptionId }, 'Registering subscription');

    try {
      const multi = this.redis.multi();
      multi.hset(eventKey, subscriptionId, subscriptionData);
      multi.sadd(taskIndexKey, eventName);
      const results = await multi.exec(); // Keep using MULTI as original did

      // Original logging for HSET result
      const hsetResult = results?.[0]?.[1];
      if (hsetResult === 1) {
        this.logger.debug(
          { eventName, fieldKey: subscriptionId, redisKey: eventKey },
          'Task subscription added to event Hash in Redis (new field)'
        );
      } else if (hsetResult === 0) {
        this.logger.debug(
          { eventName, fieldKey: subscriptionId, redisKey: eventKey },
          'Task subscription updated in event Hash in Redis (existing field)'
        );
      } else {
        this.logger.warn(
          { eventName, fieldKey: subscriptionId, redisKey: eventKey, hsetResult: results?.[0] },
          'Unexpected result from HSET within MULTI during registration'
        );
      }
      // Check SADD result (index 1 of results array)
      const saddResult = results?.[1]?.[1];
      if (saddResult === 1) {
        // Note: ioredis returns number for SADD
        this.logger.debug({ eventName, taskIndexKey }, 'Event name added to task index set');
      } else if (saddResult === 0) {
        this.logger.debug({ eventName, taskIndexKey }, 'Event name was already in task index set');
      } else {
        this.logger.warn(
          { eventName, taskIndexKey, saddResult: results?.[1] },
          'Unexpected result from SADD within MULTI during registration'
        );
      }

      // this.logger.info({ eventName, info, subscriptionId }, 'Subscription registered'); // Simpler log from previous version
    } catch (error) {
      this.logger.error({ err: error, eventName, info }, 'Error registering subscription');
      throw error;
    }
  }

  /**
   * Unregisters an event subscription from Redis.
   * Removes the subscription details from the event's hash and potentially removes the event
   * from the task's index set if no other subscriptions for that task remain for the event.
   * Matches the original EventManager.unregisterTaskEvent logic.
   * @param eventName - The name of the event to unsubscribe from.
   * @param info - The subscription information to remove.
   * @returns A promise resolving when the unregistration is complete.
   */
  async unregister(eventName: string, info: EventSubscriptionInfo): Promise<void> {
    const eventKey = this.getEventKey(eventName);
    const taskIndexKey = this.getTaskIndexKey(info.taskGroup, info.taskName);
    const subscriptionId = this.getIdentifier(info);
    const { taskGroup, taskName } = info; // Destructure for clarity

    this.logger.debug({ eventName, info, subscriptionId }, 'Unregistering subscription');

    try {
      // Revert to original logic: HDEL first
      const hashDelResult = await this.redis.hdel(eventKey, subscriptionId);

      if (hashDelResult > 0) {
        this.logger.info(
          // Match original log level and message
          { eventName, fieldKey: subscriptionId, redisKey: eventKey },
          'Task subscription removed from event Hash in Redis'
        );

        // Then check remaining with HVALS
        const remainingValues = await this.redis.hvals(eventKey);
        const taskHasOtherSubscriptionsForEvent = remainingValues.some((jsonString) => {
          try {
            const otherInfo = JSON.parse(jsonString) as EventSubscriptionInfo;
            return otherInfo.taskGroup === taskGroup && otherInfo.taskName === taskName;
          } catch (parseError) {
            this.logger.warn(
              // Match original log
              { err: parseError, eventKey, jsonString },
              'Failed to parse remaining member during unregisterTaskEvent check'
            );
            return false;
          }
        });

        // Conditionally SREM
        if (!taskHasOtherSubscriptionsForEvent) {
          this.logger.info(
            // Match original log
            { eventName, taskIndexKey },
            'Last subscription for this task to this event removed. Removing event from task index.'
          );
          const sremResult = await this.redis.srem(taskIndexKey, eventName);
          if (sremResult === 0) {
            this.logger.warn(
              // Match original log
              { eventName, taskIndexKey },
              'Attempted to remove event from task index, but it was not found.'
            );
          }
        } else {
          this.logger.debug(
            // Match original log
            { eventName, taskIndexKey },
            'Other subscriptions for this task still exist for this event. Task index unchanged.'
          );
        }
      } else {
        // Match original log
        this.logger.warn(
          { eventName, fieldKey: subscriptionId, redisKey: eventKey },
          'Task subscription field not found in event Hash during unregistration'
        );
      }
    } catch (error) {
      // Match original log message structure
      this.logger.error(
        { err: error, eventName, taskGroup: info.taskGroup, taskName: info.taskName, fieldKey: subscriptionId },
        'Failed to unregister event task subscription from Redis Hash' // Original message didn't include "from Redis Hash" but context is clear
      );
      throw error;
    }
  }

  /**
   * Retrieves all subscriptions associated with a specific task by querying its index
   * and then fetching the details from the relevant event keys.
   * Matches the original logic from EventManager.process for fetching current state.
   * @param taskGroup - The group of the task.
   * @param taskName - The name of the task.
   * @returns A promise resolving to an array of subscription information objects.
   */
  async getForTask(taskGroup: string, taskName: string): Promise<EventSubscriptionInfo[]> {
    const eventNames = await this.getTaskEventIndex(taskGroup, taskName);
    if (eventNames.length === 0) {
      return [];
    }

    const allSubscriptions: EventSubscriptionInfo[] = [];

    // Revert to sequential HVALS calls, matching original EventManager.process logic
    for (const eventName of eventNames) {
      const eventKey = this.getEventKey(eventName);
      try {
        const subscriptionJsonStrings = await this.redis.hvals(eventKey);
        this.logger.trace(
          // Use trace for potentially verbose logging
          { eventName, count: subscriptionJsonStrings.length, key: eventKey },
          `Fetched subscription JSONs from Hash for task ${taskGroup}:${taskName}.`
        );
        subscriptionJsonStrings.forEach((jsonString) => {
          try {
            const info = JSON.parse(jsonString) as EventSubscriptionInfo;
            // Filter for the specific task
            if (info.taskGroup === taskGroup && info.taskName === taskName) {
              allSubscriptions.push(info);
            }
          } catch (parseError) {
            this.logger.warn(
              { err: parseError, eventName, key: eventKey, jsonString },
              `Failed to parse subscription JSON from Hash while getting subscriptions for task ${taskGroup}:${taskName}.`
            );
          }
        });
      } catch (fetchError) {
        this.logger.error(
          { err: fetchError, eventName, key: eventKey },
          `Failed to fetch subscriptions from Hash for event ${eventName} while getting subscriptions for task ${taskGroup}:${taskName}.`
        );
        // Propagate error to signal failure in getting complete current state
        throw fetchError;
      }
    }
    return allSubscriptions;
  }

  /**
   * Retrieves all subscriptions registered for a specific event.
   * @param eventName - The name of the event.
   * @returns A promise resolving to an array of subscription information objects.
   */
  async getForEvent(eventName: string): Promise<EventSubscriptionInfo[]> {
    const eventKey = this.getEventKey(eventName);
    try {
      const subscriptions = await this.redis.hvals(eventKey);
      return subscriptions.map((sub) => JSON.parse(sub));
    } catch (error) {
      this.logger.error({ err: error, eventName }, 'Error getting subscriptions for event');
      throw error;
    }
  }

  /**
   * Retrieves the set of event names a specific task is subscribed to.
   * @param taskGroup - The group of the task.
   * @param taskName - The name of the task.
   * @returns A promise resolving to an array of event names.
   */
  async getTaskEventIndex(taskGroup: string, taskName: string): Promise<string[]> {
    const taskIndexKey = this.getTaskIndexKey(taskGroup, taskName);
    try {
      return await this.redis.smembers(taskIndexKey);
    } catch (error) {
      this.logger.error({ err: error, taskGroup, taskName }, 'Error getting task event index');
      throw error;
    }
  }
}
