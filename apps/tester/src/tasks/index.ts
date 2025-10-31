import { defineTaskGroupRegistry } from 'torotask';
import { differentGroup } from './differentGroup/index.js';
import { exampleGroup } from './exampleGroup/index.js';

export const taskGroups = defineTaskGroupRegistry({
  exampleGroup,
  differentGroup,
} as const);
