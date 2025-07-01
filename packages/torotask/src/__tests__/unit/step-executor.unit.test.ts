/**
 * Unit tests for StepExecutor
 * These tests focus on testing the logic without Redis integration
 */

import { StepExecutor } from '../../step-executor.js';
import { createMockPayload, createMockTaskHandler, createMockJob } from '../helpers/mock-factories.js';
import { delay, waitFor } from '../helpers/test-utils.js';

// Mock dependencies for unit testing
jest.mock('ioredis');
jest.mock('bullmq');

describe('StepExecutor - Unit Tests', () => {
  let stepExecutor: StepExecutor<any, any, any, any>;
  let mockJob: any;
  let mockParentTask: any;

  beforeEach(() => {
    // Create minimal mocks for testing
    mockJob = createMockJob({
      payload: createMockPayload(),
      moveToDelayed: jest.fn(),
      token: 'test-token',
    });

    mockParentTask = {
      group: {
        client: {
          taskGroups: {},
        },
        tasks: {},
      },
    };

    // Create StepExecutor instance
    stepExecutor = new StepExecutor(mockJob, mockParentTask);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('do() method', () => {
    it('should execute a simple step handler', async () => {
      const mockHandler = jest.fn().mockResolvedValue('test-result');

      const result = await stepExecutor.do('test-step', mockHandler);

      expect(result).toBe('test-result');
      expect(mockHandler).toHaveBeenCalledTimes(1);
    });

    it('should handle errors in step handler', async () => {
      const mockHandler = jest.fn().mockRejectedValue(new Error('Test error'));

      await expect(stepExecutor.do('test-step', mockHandler)).rejects.toThrow('Test error');
      expect(mockHandler).toHaveBeenCalledTimes(1);
    });

    it('should handle async operations', async () => {
      const mockHandler = jest.fn().mockImplementation(async () => {
        await delay(100);
        return 'delayed-result';
      });

      const result = await stepExecutor.do('test-step', mockHandler);

      expect(result).toBe('delayed-result');
      expect(mockHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('sleep() method', () => {
    it('should handle sleep duration as number', async () => {
      // Mock the internal sleep logic
      const sleepDuration = 1000;

      // For unit tests, we'll mock the sleep behavior
      jest.spyOn(stepExecutor as any, '_executeStep').mockResolvedValue(undefined);

      await stepExecutor.sleep('test-sleep', sleepDuration);

      expect((stepExecutor as any)._executeStep).toHaveBeenCalledWith(
        'test-sleep',
        'sleep',
        expect.any(Function),
        expect.any(Function)
      );
    });

    it('should handle sleep duration as string', async () => {
      jest.spyOn(stepExecutor as any, '_executeStep').mockResolvedValue(undefined);

      await stepExecutor.sleep('test-sleep', '5s');

      expect((stepExecutor as any)._executeStep).toHaveBeenCalledWith(
        'test-sleep',
        'sleep',
        expect.any(Function),
        expect.any(Function)
      );
    });
  });

  describe('runTask() method', () => {
    it('should throw error when task group is not found', async () => {
      await expect(stepExecutor.runTask('test-step', 'nonExistentGroup', 'testTask', {})).rejects.toThrow(
        "Task group 'nonExistentGroup' not found."
      );
    });

    it('should throw error when task is not found in group', async () => {
      // Setup mock task group without the requested task
      mockParentTask.group.client.taskGroups['testGroup'] = {
        tasks: {},
      };

      await expect(stepExecutor.runTask('test-step', 'testGroup', 'nonExistentTask', {})).rejects.toThrow(
        "Task 'nonExistentTask' not found in group 'testGroup'."
      );
    });
  });

  describe('error handling', () => {
    it('should propagate errors from step execution', async () => {
      const errorMessage = 'Step execution failed';
      const mockHandler = jest.fn().mockRejectedValue(new Error(errorMessage));

      await expect(stepExecutor.do('failing-step', mockHandler)).rejects.toThrow(errorMessage);
    });
  });

  describe('step state management', () => {
    it('should maintain step state across executions', async () => {
      const mockHandler1 = jest.fn().mockResolvedValue('result1');
      const mockHandler2 = jest.fn().mockResolvedValue('result2');

      const result1 = await stepExecutor.do('step1', mockHandler1);
      const result2 = await stepExecutor.do('step2', mockHandler2);

      expect(result1).toBe('result1');
      expect(result2).toBe('result2');
      expect(mockHandler1).toHaveBeenCalledTimes(1);
      expect(mockHandler2).toHaveBeenCalledTimes(1);
    });
  });
});
