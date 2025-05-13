import { TaskServer } from 'torotask';
import path from 'path';
import { pino } from 'pino';
import { fileURLToPath } from 'url'; // Make sure this import is present
import { taskGroups } from './tasks/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// Create the server with our task group definitions
export const server = new TaskServer(
  {
    logger,
    clientOptions: {},
    rootDir: __dirname,
  },
  taskGroups
);
