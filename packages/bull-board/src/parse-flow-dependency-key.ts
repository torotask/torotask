export interface ParsedFlowDependencyKey {
  prefix: string;
  queueName: string;
  id: string;
}

/**
 * Parses a BullMQ parent/child dependency key into prefix, queue name, and job id.
 *
 * BullMQ's stock `FlowProducer.getChildren()` assumes the prefix has no colons and
 * uses `key.split(':')` with exactly three segments. ToroTask uses a multi-segment
 * queue prefix (`torotask:tasks`), so keys look like:
 * `torotask:tasks:cornerstone.learningSectionsProcess:<jobId>`
 */
export function parseFlowDependencyKey(
  key: string,
  queuePrefix?: string,
): ParsedFlowDependencyKey | null {
  if (!key) {
    return null;
  }

  if (queuePrefix) {
    const prefixDelimiter = `${queuePrefix}:`;
    if (key.startsWith(prefixDelimiter)) {
      const remainder = key.slice(prefixDelimiter.length);
      const lastColon = remainder.lastIndexOf(':');
      if (lastColon <= 0) {
        return null;
      }

      return {
        prefix: queuePrefix,
        queueName: remainder.slice(0, lastColon),
        id: remainder.slice(lastColon + 1),
      };
    }
  }

  const parts = key.split(':');
  if (parts.length < 3) {
    return null;
  }

  return {
    prefix: parts[0],
    queueName: parts[1],
    id: parts.slice(2).join(':'),
  };
}
