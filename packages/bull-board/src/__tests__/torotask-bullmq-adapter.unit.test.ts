import type { Queue } from 'bullmq';
import type { ToroTask } from 'torotask';
import { createToroTaskDataRef, TOROTASK_DATA_REF } from 'torotask';
import { ToroTaskBullMQAdapter } from '../torotask-bullmq-adapter.js';

function createRef(byteLength = 32_000) {
  return createToroTaskDataRef('ai.embedding:1:returnValue', true, byteLength);
}

function createJob(overrides: Partial<{
  id: string;
  payload: unknown;
  returnvalue: unknown;
}> = {}) {
  return {
    id: overrides.id ?? '1',
    data: {
      payload: overrides.payload ?? createRef(),
      state: {},
    },
    returnvalue: overrides.returnvalue ?? createRef(),
  } as any;
}

describe('toroTaskBullMQAdapter', () => {
  const resolvedReturn = [0.1, 0.2, 0.3];

  const dataStore = {
    resolveDeep: jest.fn(async (value: unknown) => {
      if (value !== null && typeof value === 'object' && TOROTASK_DATA_REF in value) {
        return resolvedReturn;
      }
      return value;
    }),
  };

  const stepStateStore = {
    loadSteps: jest.fn(async () => ({
      step1_0: {
        status: 'completed',
        data: createRef(10_000),
      },
    })),
  };

  const taskClient = {
    queuePrefix: 'torotask:tasks',
    getDataStore: () => dataStore,
    getStepStateStore: () => stepStateStore,
  } as unknown as ToroTask;

  const queue = { name: 'ai.embedding', metaValues: { version: 'bullmq-5.63.0' } } as unknown as Queue;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps data refs unresolved in getJobs', async () => {
    const ref = createRef();
    const job = createJob({ payload: ref, returnvalue: ref });
    const adapter = new ToroTaskBullMQAdapter(taskClient, queue);
    jest.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(adapter)), 'getJobs').mockResolvedValue([job]);

    const jobs = await adapter.getJobs(['completed'], 0, 9);

    expect(dataStore.resolveDeep).not.toHaveBeenCalled();
    expect(stepStateStore.loadSteps).not.toHaveBeenCalled();
    expect(jobs[0].returnvalue).toEqual(ref);
    expect(jobs[0].data.payload).toEqual(ref);
  });

  it('resolves data refs and step state in getJob', async () => {
    const ref = createRef();
    const job = createJob({ payload: ref, returnvalue: ref });
    const adapter = new ToroTaskBullMQAdapter(taskClient, queue);
    jest.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(adapter)), 'getJob').mockResolvedValue(job);

    const result = await adapter.getJob('1');

    expect(dataStore.resolveDeep).toHaveBeenCalled();
    expect(stepStateStore.loadSteps).toHaveBeenCalledWith('ai.embedding', '1');
    expect(result?.returnvalue).toEqual(resolvedReturn);
    expect((result?.data as any).state.stepState.step1_0.data).toEqual(resolvedReturn);
  });

  it('formats returnValue refs as a readable label', () => {
    const adapter = new ToroTaskBullMQAdapter(taskClient, queue);
    const formatted = adapter.format('returnValue', createRef(32_929));

    expect(formatted).toBe('[ToroTask external data] 32.2 KiB, compressed — open job to load');
  });

  it('formats job data payload refs with a summary field', () => {
    const adapter = new ToroTaskBullMQAdapter(taskClient, queue);
    const ref = createRef(4096);
    const formatted = adapter.format('data', { payload: ref, state: {} }) as Record<string, unknown>;

    expect(formatted._torotaskPayloadRef).toBe('[ToroTask external data] 4.0 KiB, compressed — open job to load');
    expect(formatted.payload).toMatchObject({
      [TOROTASK_DATA_REF]: true,
      _display: '[ToroTask external data] 4.0 KiB, compressed — open job to load',
    });
  });

  it('chains truncate formatters after data-ref formatting', () => {
    const adapter = new ToroTaskBullMQAdapter(taskClient, queue, {
      truncate: { maxPropertyBytes: 32 },
    });
    const largePayload = { text: 'x'.repeat(500) };
    const formatted = adapter.format('data', { payload: largePayload, state: {} }) as Record<string, unknown>;

    expect(formatted.payload).toMatch(/^\[Value truncated - /);
  });

  it('preserves ref labels when truncation is enabled', () => {
    const adapter = new ToroTaskBullMQAdapter(taskClient, queue, {
      truncate: { maxStringLength: 10 },
    });
    const formatted = adapter.format('returnValue', createRef(32_929));

    expect(formatted).toBe('[ToroTask external data] 32.2 KiB, compressed — open job to load');
  });

  it('allows custom formatters to run after built-in formatters', () => {
    const adapter = new ToroTaskBullMQAdapter(taskClient, queue);
    adapter.setFormatter('returnValue', value => `custom:${String(value)}`);

    expect(adapter.format('returnValue', createRef(1024))).toBe(
      'custom:[ToroTask external data] 1.0 KiB, compressed — open job to load',
    );
  });

  it('exposes getActiveRateLimitTtl for Bull Board 9.x queue listings', async () => {
    const adapter = new ToroTaskBullMQAdapter(taskClient, queue);
    await expect(adapter.getActiveRateLimitTtl()).resolves.toBe(0);
  });

  it('patches the flow producer for multi-segment queue prefixes', async () => {
    const originalGetChildren = jest.fn();
    const producer = {
      getNode: jest.fn(),
      getChildren: originalGetChildren,
    };
    const adapter = new ToroTaskBullMQAdapter(taskClient, queue);
    jest
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(adapter)), 'getFlowProducer')
      .mockResolvedValue(producer);

    const result = await adapter.getFlowProducer();

    expect(result).toBe(producer);
    expect(producer.getChildren).not.toBe(originalGetChildren);
    await (producer as any).getChildren(
      {},
      ['torotask:tasks:ai.embedding:child-1'],
      3,
      10,
    );
    expect(producer.getNode).toHaveBeenCalledWith({}, {
      id: 'child-1',
      queueName: 'ai.embedding',
      prefix: 'torotask:tasks',
      depth: 3,
      maxChildren: 10,
    });
  });
});
