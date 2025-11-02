import type { TaskServer } from '../server.js';
import type { TaskGroup } from '../task-group.js';
import type { TaskGroupDefinitionRegistry, TaskGroupRegistry, WorkerFilterGroups } from '../types/index.js';

export function filterGroups<
  TGroupDefs extends TaskGroupDefinitionRegistry,
  TGroups extends TaskGroupRegistry<TGroupDefs>,
>(
  server: TaskServer<TGroupDefs, TGroups>,
  filter?: WorkerFilterGroups<TGroups>,
  actionContext: 'starting' | 'stopping' | 'closing' | string = 'processing',
): Array<TaskGroup<any, any>> {
  const groupsToProcessSet = new Set<TaskGroup<any, any>>();
  const notFoundKeys: Array<Extract<keyof TGroups, string>> = [];

  let requestedByIdCount = 0;

  // Process groups by id
  if (filter?.groupsById && filter.groupsById.length > 0) {
    requestedByIdCount = filter.groupsById.length;
    filter.groupsById.forEach((id) => {
      const group = server.taskGroups[id as keyof TGroupDefs];
      if (group) {
        groupsToProcessSet.add(group);
      }
      else {
        notFoundKeys.push(id);
      }
    });
  }

  const groupsToProcessArray = Array.from(groupsToProcessSet);

  // If no filter is provided, or filter is empty, get all groups
  if (requestedByIdCount === 0 && (!filter || (filter.groupsById?.length ?? 0) === 0)) {
    return Object.values(server.taskGroups) as Array<TaskGroup<any, any>>;
  }

  // Logging for missing groups
  if (notFoundKeys.length > 0) {
    const missingDetails: any = {};
    missingDetails.missingIds = notFoundKeys.map(String);
    missingDetails.requestedById = requestedByIdCount;
    missingDetails.foundById = requestedByIdCount - notFoundKeys.length;

    server.logger.warn(
      {
        ...missingDetails,
        totalFound: groupsToProcessArray.length,
        context: actionContext,
      },
      `Some requested groups for ${actionContext} were not found.`,
    );
  }

  if (groupsToProcessArray.length === 0 && requestedByIdCount > 0) {
    const filterCriteria: string[] = [];
    if (filter?.groupsById?.length) {
      filterCriteria.push(`ids: ${filter.groupsById.map(String).join(', ')}`);
    }
    server.logger.info(
      { filter: filterCriteria.length > 0 ? filterCriteria.join('; ') : 'all specified', context: actionContext },
      `No matching groups found to ${actionContext}.`,
    );
  }
  else if (groupsToProcessArray.length === 0 && requestedByIdCount === 0) {
    server.logger.info({ context: actionContext }, `No groups available to ${actionContext}.`);
  }

  return groupsToProcessArray;
}
