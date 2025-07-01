import { TaskGroup } from '../task-group.js';
import type { Task } from '../task.js';
import type { TaskRegistry, TaskDefinitionRegistry, WorkerFilterTasks, SchemaHandler } from '../types/index.js';

export function filterGroupTasks<TDefs extends TaskDefinitionRegistry, TTasks extends TaskRegistry<TDefs>>(
  taskGroup: TaskGroup<TDefs>,
  filter?: WorkerFilterTasks<TTasks>,
  actionContext: 'starting' | 'stopping' | 'closing' | string = 'processing'
): Array<Task<any, any, SchemaHandler>> {
  // Return type changed to be more general
  const tasksToProcessSet = new Set<Task<any, any, SchemaHandler>>();
  const notFoundKeys: Array<Extract<keyof TTasks, string>> = [];

  let requestedByIdCount = 0;

  // Process tasks by id
  if (filter?.tasksById && filter.tasksById.length > 0) {
    requestedByIdCount = filter.tasksById.length;
    filter.tasksById.forEach((id) => {
      const task = taskGroup.getTask(id);
      if (task) {
        tasksToProcessSet.add(task);
      } else {
        notFoundKeys.push(id);
      }
    });
  }

  const tasksToProcessArray = Array.from(tasksToProcessSet);

  // If no filter is provided, or filter is empty, get all tasks
  if (requestedByIdCount === 0 && (!filter || (filter.tasksById?.length ?? 0) === 0)) {
    // Get all tasks if no specific filter is provided or if filters are empty
    // Object.values(this.tasks) will correctly return Array<TTasks[keyof TTasks]>
    // which is compatible with Array<Task<any, any, SchemaHandler>>
    return Object.values(taskGroup.tasks) as Array<Task<any, any, SchemaHandler>>;
  }

  // Logging for missing tasks
  if (notFoundKeys.length > 0) {
    const missingDetails: any = {};
    if (notFoundKeys.length > 0) {
      missingDetails.missingIds = notFoundKeys.map(String);
      missingDetails.requestedById = requestedByIdCount;
      missingDetails.foundById = requestedByIdCount - notFoundKeys.length;
    }
    taskGroup.logger.warn(
      {
        ...missingDetails,
        totalFound: tasksToProcessArray.length,
        context: actionContext,
      },
      `Some requested tasks for ${actionContext} workers were not found.`
    );
  }

  if (tasksToProcessArray.length === 0 && requestedByIdCount > 0) {
    const filterCriteria: string[] = [];
    if (filter?.tasksById?.length) {
      filterCriteria.push(`ids: ${filter.tasksById.join(', ')}`);
    }
    taskGroup.logger.info(
      { filter: filterCriteria.length > 0 ? filterCriteria.join('; ') : 'all specified', context: actionContext },
      `No matching tasks found to process workers for.`
    );
  } else if (tasksToProcessArray.length === 0 && requestedByIdCount === 0) {
    taskGroup.logger.info({ context: actionContext }, `No tasks available in the group to process workers for.`);
  }

  return tasksToProcessArray;
}
