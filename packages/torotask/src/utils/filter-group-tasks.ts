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

  let requestedByKeyCount = 0;

  // Process tasks by key
  if (filter?.tasksByKey && filter.tasksByKey.length > 0) {
    requestedByKeyCount = filter.tasksByKey.length;
    filter.tasksByKey.forEach((key) => {
      const task = taskGroup.getTask(key);
      if (task) {
        tasksToProcessSet.add(task);
      } else {
        notFoundKeys.push(key);
      }
    });
  }

  const tasksToProcessArray = Array.from(tasksToProcessSet);

  // If no filter is provided, or filter is empty, get all tasks
  if (requestedByKeyCount === 0 && (!filter || (filter.tasksByKey?.length ?? 0) === 0)) {
    // Get all tasks if no specific filter is provided or if filters are empty
    // Object.values(this.tasks) will correctly return Array<TTasks[keyof TTasks]>
    // which is compatible with Array<Task<any, any, SchemaHandler>>
    return Object.values(taskGroup.tasks) as Array<Task<any, any, SchemaHandler>>;
  }

  // Logging for missing tasks
  if (notFoundKeys.length > 0) {
    const missingDetails: any = {};
    if (notFoundKeys.length > 0) {
      missingDetails.missingKeys = notFoundKeys.map(String);
      missingDetails.requestedByKey = requestedByKeyCount;
      missingDetails.foundByKey = requestedByKeyCount - notFoundKeys.length;
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

  if (tasksToProcessArray.length === 0 && requestedByKeyCount > 0) {
    const filterCriteria: string[] = [];
    if (filter?.tasksByKey?.length) {
      filterCriteria.push(`keys: ${filter.tasksByKey.join(', ')}`);
    }
    taskGroup.logger.info(
      { filter: filterCriteria.length > 0 ? filterCriteria.join('; ') : 'all specified', context: actionContext },
      `No matching tasks found to process workers for.`
    );
  } else if (tasksToProcessArray.length === 0 && requestedByKeyCount === 0) {
    taskGroup.logger.info({ context: actionContext }, `No tasks available in the group to process workers for.`);
  }

  return tasksToProcessArray;
}
