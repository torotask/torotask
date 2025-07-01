import { defineTaskGroupRegistry } from 'torotask';
import { exampleGroup } from './exampleGroup/index.js';
import { differentGroup } from './differentGroup/index.js';

export const taskGroups = defineTaskGroupRegistry({
  exampleGroup,
  differentGroup,
} as const);
