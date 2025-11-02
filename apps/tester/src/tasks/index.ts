import { defineTaskGroupRegistry } from 'torotask';
import { differentGroup } from './differentGroup/index.js';
import { exampleGroup } from './exampleGroup/index.js';
import { newGroup } from './newGroup/index.js';

export const taskGroups = defineTaskGroupRegistry({
  exampleGroup,
  differentGroup,
  newGroup,
} as const);
