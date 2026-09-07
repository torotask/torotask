import type { FlowProducer } from 'bullmq';
import { parseFlowDependencyKey } from './parse-flow-dependency-key.js';

const patchedFlowProducers = new WeakSet<FlowProducer>();

interface FlowNodeOptions {
  id: string;
  queueName: string;
  prefix?: string;
  depth?: number;
  maxChildren?: number;
}

interface PatchableFlowProducer {
  getChildren: (
    client: unknown,
    childrenKeys: string[],
    depth: number,
    maxChildren: number,
  ) => Promise<unknown[]>;
  getNode: (client: unknown, node: FlowNodeOptions) => Promise<unknown>;
}

/**
 * Patches BullMQ's FlowProducer so flow trees resolve when the queue prefix
 * contains colon separators (e.g. ToroTask's `torotask:tasks`).
 */
export function patchFlowProducerForMultiSegmentPrefix(
  producer: FlowProducer,
  queuePrefix: string,
): FlowProducer {
  if (!queuePrefix.includes(':') || patchedFlowProducers.has(producer)) {
    return producer;
  }

  const internals = producer as unknown as PatchableFlowProducer;
  const getNode = internals.getNode.bind(internals);

  internals.getChildren = (
    client: unknown,
    childrenKeys: string[],
    depth: number,
    maxChildren: number,
  ) => {
    const getChild = (key: string) => {
      const parsed = parseFlowDependencyKey(key, queuePrefix);
      if (!parsed) {
        return undefined;
      }

      return getNode(client, {
        id: parsed.id,
        queueName: parsed.queueName,
        prefix: parsed.prefix,
        depth,
        maxChildren,
      });
    };

    return Promise.all(childrenKeys.map(getChild));
  };

  patchedFlowProducers.add(producer);
  return producer;
}
