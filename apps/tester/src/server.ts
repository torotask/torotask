import { TaskServer, TaskHandlerContext, getTypedStep } from 'torotask';
import { pino } from 'pino';
import { taskGroups } from './tasks/index.js';

// Configure Pino with pretty printing
export const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      levelFirst: true,
      translateTime: 'SYS:standard', // More readable time format
    },
  },
});

//type TDefs = typeof taskGroups.exampleGroup.tasks;;
//type TTasks = TaskRegistry<TDefs>;
//type group = TTasks['newTask']['id'];
// Create the server with our task group definitions
export const server = new TaskServer(
  {
    logger,
  },
  taskGroups
);

/* * This function is used to get a step executor for a specific task group and task.
 * It takes a context object that contains the task job and the task group definitions.
 * The function returns a step executor that can be used to execute steps for the specified task.
 *
 * @param context - The context object containing the task job and task group definitions.
 * @returns A step executor for the specified task group and task.
 */
export function getStep<TCurrentTaskGroup extends keyof typeof taskGroups = never>(
  context: any,
  currentGroup?: TCurrentTaskGroup
) {
  // Use the getTypedStep function to retrieve the step executor
  return getTypedStep<typeof taskGroups, TCurrentTaskGroup>(context, currentGroup);
}
