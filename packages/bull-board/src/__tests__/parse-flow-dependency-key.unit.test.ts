import { parseFlowDependencyKey } from '../parse-flow-dependency-key.js';
import { patchFlowProducerForMultiSegmentPrefix } from '../patch-flow-producer.js';

describe('parseFlowDependencyKey', () => {
  it('parses ToroTask multi-segment prefix keys', () => {
    expect(
      parseFlowDependencyKey(
        'torotask:tasks:cornerstone.learningSectionsProcess:abc-123',
        'torotask:tasks',
      ),
    ).toEqual({
      prefix: 'torotask:tasks',
      queueName: 'cornerstone.learningSectionsProcess',
      id: 'abc-123',
    });
  });

  it('parses standard single-segment prefix keys when prefix is provided', () => {
    expect(parseFlowDependencyKey('bull:email:job-1', 'bull')).toEqual({
      prefix: 'bull',
      queueName: 'email',
      id: 'job-1',
    });
  });

  it('falls back to legacy three-part parsing without a known prefix', () => {
    expect(parseFlowDependencyKey('bull:email:job-1')).toEqual({
      prefix: 'bull',
      queueName: 'email',
      id: 'job-1',
    });
  });

  it('returns null for malformed keys', () => {
    expect(parseFlowDependencyKey('', 'torotask:tasks')).toBeNull();
    expect(parseFlowDependencyKey('torotask:tasks:only-queue', 'torotask:tasks')).toBeNull();
  });
});

describe('patchFlowProducerForMultiSegmentPrefix', () => {
  it('resolves children using the ToroTask queue prefix', async () => {
    const childNode = { job: { id: 'child-1' } };
    const getNode = jest.fn(async () => childNode);
    const producer = {
      getNode,
      getChildren: jest.fn(),
    };

    patchFlowProducerForMultiSegmentPrefix(producer as any, 'torotask:tasks');

    const children = await (producer as any).getChildren(
      {},
      ['torotask:tasks:opensearch.bulkIndex:child-1'],
      5,
      20,
    );

    expect(getNode).toHaveBeenCalledWith({}, {
      id: 'child-1',
      queueName: 'opensearch.bulkIndex',
      prefix: 'torotask:tasks',
      depth: 5,
      maxChildren: 20,
    });
    expect(children).toEqual([childNode]);
  });

  it('does not patch producers when the prefix has no colons', () => {
    const producer = {
      getNode: jest.fn(),
      getChildren: jest.fn(),
    };

    const result = patchFlowProducerForMultiSegmentPrefix(producer as any, 'bull');

    expect(result).toBe(producer);
    expect(producer.getChildren).not.toHaveBeenCalled();
  });

  it('patches a producer only once', () => {
    const producer = {
      getNode: jest.fn(),
      getChildren: jest.fn(),
    };

    patchFlowProducerForMultiSegmentPrefix(producer as any, 'torotask:tasks');
    const patchedGetChildren = producer.getChildren;
    patchFlowProducerForMultiSegmentPrefix(producer as any, 'torotask:tasks');

    expect(producer.getChildren).toBe(patchedGetChildren);
  });
});
