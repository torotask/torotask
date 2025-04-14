import { TaskServer } from '@torotask/server';
import { pino } from 'pino';
import path from 'path';
import { fileURLToPath } from 'url'; // Make sure this import is present

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

// Pass the logger instance to the client
export const server = new TaskServer({
  logger,
  clientOptions: {},
  rootDir: __dirname,
});
