import { createSchema, defineTask } from 'torotask';
import { getTaskContext } from '../../helpers.js';

/**
 * Test task to verify that parent override works correctly in step executor methods.
 * When run from parentOverrideTestRunner in newGroup, this can be run with or without a parent
 * to verify the override takes precedence over the auto-set parent.
 */
export const parentOverrideTestChild = defineTask({
  id: 'parent-override-test-child',
  schema: createSchema(z => z.object({
    message: z.string(),
  })),
  handler: async (options, context) => {
    const { payload } = options;
    const { logger, job } = context;

    const parentId = job.parent?.id ?? 'none';
    logger.info({ parentId, message: payload.message }, 'parentOverrideTestChild executed');

    return {
      message: payload.message,
      parentId,
      hasParent: !!job.parent,
    };
  },
});

/**
 * Runner task that tests the parent override functionality.
 * It spawns child tasks with { parent: undefined } to verify
 * that the override takes precedence over the auto-set parent.
 */
export const parentOverrideTestRunner = defineTask({
  id: 'parent-override-test-runner',
  schema: createSchema(z => z.object({
    testName: z.string().default('parent-override-test'),
  })),
  handler: async (options, context): Promise<string> => {
    const { payload } = options;
    const { logger, step, job } = getTaskContext(context, 'exampleGroup');

    logger.info({ testName: payload.testName, jobId: job.id }, 'Starting parent override test');

    // Test 1: Run a task with default parent (should inherit this job as parent)
    const withDefaultParent = await step.runGroupTaskAndWait(
      'with-default-parent',
      'parentOverrideTestChild',
      { message: 'should have parent' },
    ) as { hasParent: boolean };

    // Test 2: Run a task with explicit parent: undefined (should be an orphan)
    const withOverriddenParent = await step.runGroupTaskAndWait(
      'with-overridden-parent',
      'parentOverrideTestChild',
      { message: 'should be orphan' },
      { parent: undefined },
    ) as { hasParent: boolean };

    const defaultParentCorrect = withDefaultParent.hasParent === true;
    const overrideCorrect = withOverriddenParent.hasParent === false;
    const allTestsPassed = defaultParentCorrect && overrideCorrect;

    logger.info({
      testName: payload.testName,
      runnerId: job.id,
      defaultParentCorrect,
      overrideCorrect,
      allTestsPassed,
    }, 'Parent override test completed');

    return allTestsPassed ? 'PASSED' : 'FAILED';
  },
});
