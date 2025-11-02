import { pino } from 'pino';
import { TaskServer } from 'torotask';
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

// type TDefs = typeof taskGroups.exampleGroup.tasks;;
// type TTasks = TaskRegistry<TDefs>;
// type group = TTasks['newTask']['id'];
// Create the server with our task group definitions
export const server = new TaskServer(
  {
    logger,
  },
  taskGroups,
);
