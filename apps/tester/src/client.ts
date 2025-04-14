import { ToroTaskClient } from '@torotask/client';
import pino from 'pino';

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
export const client = new ToroTaskClient({
  logger,
});
