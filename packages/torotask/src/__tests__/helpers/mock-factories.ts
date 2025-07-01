/**
 * Simple mock factories for testing
 * These will be expanded as needed for specific test cases
 */

/**
 * Creates mock payload for testing
 */
export function createMockPayload(overrides: any = {}): any {
  return {
    id: 'test-id',
    data: { message: 'test' },
    ...overrides,
  };
}

/**
 * Creates mock Redis configuration for testing
 */
export function createMockRedisConfig(overrides: any = {}): any {
  return {
    host: 'localhost',
    port: 6379,
    maxRetriesPerRequest: 3,
    ...overrides,
  };
}

/**
 * Creates a mock task handler function
 */
export function createMockTaskHandler<T = any, R = any>(
  result: R = { success: true } as R
): (payload: T) => Promise<R> {
  return async (_payload: T): Promise<R> => {
    // Simple mock implementation
    return result;
  };
}

/**
 * Creates a mock job for testing
 */
export function createMockJob(overrides: any = {}): any {
  return {
    id: 'test-job-id',
    state: {
      stepState: {},
    },
    updateState: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
