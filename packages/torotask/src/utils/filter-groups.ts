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
  const notFoundIds: Array<string> = [];

  let requestedByKeyCount = 0;
  let requestedByIdCount = 0;

  // Process groups by key
  if (filter?.groupsByKey && filter.groupsByKey.length > 0) {
    requestedByKeyCount = filter.groupsByKey.length;
    filter.groupsByKey.forEach((key) => {
      const group = server.taskGroups[key as keyof TGroupDefs];
      if (group) {
        groupsToProcessSet.add(group);
      } else {
        notFoundKeys.push(key); // Removed redundant cast as key is already the correct type
      }
    });
  }

  // Process groups by ID
  if (filter?.groupsById && filter.groupsById.length > 0) {
    requestedByIdCount = filter.groupsById.length;
    const allGroupsArray = Object.values(server.taskGroups) as Array<TaskGroup<any, any>>;
    filter.groupsById.forEach((id) => {
      const group = allGroupsArray.find((g) => g.id === id);
      if (group) {
        groupsToProcessSet.add(group);
      } else {
        notFoundIds.push(id);
      }
    });
  }

  const groupsToProcessArray = Array.from(groupsToProcessSet);

  // If neither filter is provided, or both are empty, get all groups
  if (
    requestedByKeyCount === 0 &&
    requestedByIdCount === 0 &&
    (!filter || ((filter.groupsByKey?.length ?? 0) === 0 && (filter.groupsById?.length ?? 0) === 0))
  ) {
    return Object.values(server.taskGroups) as Array<TaskGroup<any, any>>;
  }

  // Logging for missing groups
  if (notFoundKeys.length > 0 || notFoundIds.length > 0) {
    const missingDetails: any = {};
    if (notFoundKeys.length > 0) {
      missingDetails.missingKeys = notFoundKeys.map(String);
      missingDetails.requestedByKey = requestedByKeyCount;
      missingDetails.foundByKey = requestedByKeyCount - notFoundKeys.length;
    }
    if (notFoundIds.length > 0) {
      missingDetails.missingIds = notFoundIds;
      missingDetails.requestedById = requestedByIdCount;
      missingDetails.foundById = requestedByIdCount - notFoundIds.length;
    }
    server.logger.warn(
      {
        ...missingDetails,
        totalFound: groupsToProcessArray.length,
        context: actionContext,
      },
      `Some requested groups for ${actionContext} were not found.`
    );
  }

  if (groupsToProcessArray.length === 0 && (requestedByKeyCount > 0 || requestedByIdCount > 0)) {
    const filterCriteria: string[] = [];
    if (filter?.groupsByKey?.length) {
      filterCriteria.push(`keys: ${filter.groupsByKey.map(String).join(', ')}`);
    }
    if (filter?.groupsById?.length) {
      filterCriteria.push(`IDs: ${filter.groupsById.join(', ')}`);
    }
    server.logger.info(
      { filter: filterCriteria.length > 0 ? filterCriteria.join('; ') : 'all specified', context: actionContext },
      `No matching groups found to ${actionContext}.`
    );
  } else if (groupsToProcessArray.length === 0 && requestedByKeyCount === 0 && requestedByIdCount === 0) {
    server.logger.info({ context: actionContext }, `No groups available to ${actionContext}.`);
  }

  return groupsToProcessArray;
}
