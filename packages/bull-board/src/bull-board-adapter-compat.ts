import type { Queue } from 'bullmq';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';

export interface QueueRateLimit {
  max: number;
  duration: number;
}

type RateLimitCapableQueue = Queue & {
  getRateLimitTtl?: () => Promise<number>;
  getGlobalRateLimit?: () => Promise<QueueRateLimit | null>;
  setGlobalRateLimit?: (max: number, duration: number) => Promise<void>;
  removeGlobalRateLimit?: () => Promise<void>;
  removeRateLimitKey?: () => Promise<void>;
};

/** Resolved once at module load from the host app's @bull-board/api copy. */
export const bullMqAdapterPrototype = BullMQAdapter.prototype as BullMQAdapter & {
  getActiveRateLimitTtl?: () => Promise<number>;
  getConfiguredRateLimit?: () => Promise<QueueRateLimit | null>;
  setConfiguredRateLimit?: (limit: QueueRateLimit) => Promise<void>;
  removeConfiguredRateLimit?: () => Promise<void>;
  releaseActiveRateLimit?: () => Promise<void>;
};

export const bullBoardAdapterCapabilities = {
  activeRateLimitTtl: typeof bullMqAdapterPrototype.getActiveRateLimitTtl === 'function',
  configuredRateLimit: typeof bullMqAdapterPrototype.getConfiguredRateLimit === 'function',
  setConfiguredRateLimit: typeof bullMqAdapterPrototype.setConfiguredRateLimit === 'function',
  removeConfiguredRateLimit: typeof bullMqAdapterPrototype.removeConfiguredRateLimit === 'function',
  releaseActiveRateLimit: typeof bullMqAdapterPrototype.releaseActiveRateLimit === 'function',
  supportsGlobalRateLimitGetter: 'supportsGlobalRateLimit' in BullMQAdapter.prototype,
};

export function queueSupportsGlobalRateLimit(queue: Queue): boolean {
  const rateLimitQueue = queue as RateLimitCapableQueue;
  return typeof rateLimitQueue.setGlobalRateLimit === 'function';
}

export async function readActiveRateLimitTtl(queue: Queue): Promise<number> {
  const rateLimitQueue = queue as RateLimitCapableQueue;
  if (typeof rateLimitQueue.getRateLimitTtl !== 'function') {
    return 0;
  }

  try {
    const ttl = await rateLimitQueue.getRateLimitTtl();
    return ttl > 0 ? ttl : 0;
  }
  catch {
    return 0;
  }
}

export async function readConfiguredRateLimit(queue: Queue): Promise<QueueRateLimit | null> {
  const rateLimitQueue = queue as RateLimitCapableQueue;
  if (typeof rateLimitQueue.getGlobalRateLimit !== 'function') {
    return null;
  }

  try {
    return await rateLimitQueue.getGlobalRateLimit();
  }
  catch {
    return null;
  }
}

export async function writeConfiguredRateLimit(queue: Queue, limit: QueueRateLimit): Promise<void> {
  const rateLimitQueue = queue as RateLimitCapableQueue;
  if (typeof rateLimitQueue.setGlobalRateLimit !== 'function') {
    return;
  }

  await rateLimitQueue.setGlobalRateLimit(limit.max, limit.duration);
}

export async function clearConfiguredRateLimit(queue: Queue): Promise<void> {
  const rateLimitQueue = queue as RateLimitCapableQueue;
  if (typeof rateLimitQueue.removeGlobalRateLimit !== 'function') {
    return;
  }

  await rateLimitQueue.removeGlobalRateLimit();
}

export async function releaseQueueActiveRateLimit(queue: Queue): Promise<void> {
  const rateLimitQueue = queue as RateLimitCapableQueue;
  if (typeof rateLimitQueue.removeRateLimitKey !== 'function') {
    return;
  }

  await rateLimitQueue.removeRateLimitKey();
}

/**
 * Calls a Bull Board adapter method from the host's BullMQAdapter when present,
 * otherwise runs the ToroTask fallback for the installed @bull-board/api version.
 */
export async function callAdapterMethod<T, TArgs extends unknown[]>(
  adapter: BullMQAdapter,
  method: keyof typeof bullMqAdapterPrototype,
  fallback: (...args: TArgs) => Promise<T> | T,
  ...args: TArgs
): Promise<T> {
  const impl = bullMqAdapterPrototype[method];
  if (typeof impl !== 'function') {
    return await fallback(...args);
  }

  try {
    return await (impl as (this: BullMQAdapter, ...args: TArgs) => Promise<T>).call(adapter, ...args);
  }
  catch {
    return await fallback(...args);
  }
}
