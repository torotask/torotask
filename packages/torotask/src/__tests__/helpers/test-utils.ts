/**
 * Test utility functions
 */

/**
 * Waits for a condition to be met with timeout
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number = 5000,
  intervalMs: number = 100
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

/**
 * Creates a delay promise
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mock function type for testing
 */
export type MockFunction<T extends (...args: any[]) => any> = jest.MockedFunction<T>;

/**
 * Creates a jest mock function with proper typing
 */
export function createMockFunction<T extends (...args: any[]) => any>(): MockFunction<T> {
  return jest.fn() as unknown as MockFunction<T>;
}
