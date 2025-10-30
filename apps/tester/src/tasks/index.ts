import { defineTaskGroupRegistry } from 'torotask';
import { exampleGroup } from './exampleGroup/index.js';
import { differentGroup } from './differentGroup/index.js';
import { newGroup } from './newGroup/index.js';

export const taskGroups = defineTaskGroupRegistry({
  exampleGroup,
  differentGroup,
  newGroup,
} as const);
