/**
 * Aggregates every stability case. Mirrors the smoke index.mjs pattern:
 * each case file under cases/ exports a `cases` array; this file
 * flattens them into one list the runner iterates. Adding a new case
 * file = `import` + spread here.
 */
import { cases as primitives } from './primitives.mjs';
import { cases as modifiers } from './modifiers.mjs';
import { cases as patterns } from './patterns.mjs';

export const cases = [
  ...primitives,
  ...modifiers,
  ...patterns,
];
