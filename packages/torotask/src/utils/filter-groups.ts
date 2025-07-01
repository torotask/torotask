import { TaskServer } from '../server.js';
import { TaskGroup } from '../task-group.js';
import type { Task } from '../task.js';
import type { TaskGroupRegistry, TaskGroupDefinitionRegistry, WorkerFilterGroups } from '../types/index.js';

export function filterGroups<
  TGroupDefs extends TaskGroupDefinitionRegistry,
  TGroups extends TaskGroupRegistry<TGroupDefs>,
>(
  server: TaskServer<TGroupDefs, TGroups>,
  filter?: WorkerFilterGroups<TGroups>,
  actionContext: 'starting' | 'stopping' | 'closing' | string = 'processing'
): Array<TaskGroup<any, any>> {
  const groupsToProcessSet = new Set<TaskGroup<any, any>>();
  const notFoundKeys: Array<Extract<keyof TGroups, string>> = [];

  let requestedByKeyCount = 0;

  // Process groups by key
  if (filter?.groupsByKey && filter.groupsByKey.length > 0) {
    requestedByKeyCount = filter.groupsByKey.length;
    filter.groupsByKey.forEach((key) => {
      const group = server.taskGroups[key as keyof TGroupDefs];
      if (group) {
        groupsToProcessSet.add(group);
      } else {
        notFoundKeys.push(key);
      }
    });
  }

  const groupsToProcessArray = Array.from(groupsToProcessSet);

  // If no filter is provided, or filter is empty, get all groups
  if (requestedByKeyCount === 0 && (!filter || (filter.groupsByKey?.length ?? 0) === 0)) {
    return Object.values(server.taskGroups) as Array<TaskGroup<any, any>>;
  }

  // Logging for missing groups
  if (notFoundKeys.length > 0) {
    const missingDetails: any = {};
    missingDetails.missingKeys = notFoundKeys.map(String);
    missingDetails.requestedByKey = requestedByKeyCount;
    missingDetails.foundByKey = requestedByKeyCount - notFoundKeys.length;

    server.logger.warn(
      {
        ...missingDetails,
        totalFound: groupsToProcessArray.length,
        context: actionContext,
      },
      `Some requested groups for ${actionContext} were not found.`
    );
  }

  if (groupsToProcessArray.length === 0 && requestedByKeyCount > 0) {
    const filterCriteria: string[] = [];
    if (filter?.groupsByKey?.length) {
      filterCriteria.push(`keys: ${filter.groupsByKey.map(String).join(', ')}`);
    }
    server.logger.info(
      { filter: filterCriteria.length > 0 ? filterCriteria.join('; ') : 'all specified', context: actionContext },
      `No matching groups found to ${actionContext}.`
    );
  } else if (groupsToProcessArray.length === 0 && requestedByKeyCount === 0) {
    server.logger.info({ context: actionContext }, `No groups available to ${actionContext}.`);
  }

  return groupsToProcessArray;
}
