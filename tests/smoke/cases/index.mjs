/**
 * Aggregates every smoke case. Each case file under cases/ exports a
 * `cases` array; this file flattens them into one list the runner
 * iterates. Adding a new case file = `import` + spread here.
 */
import { cases as primitives } from './primitives.mjs';
import { cases as sketch } from './sketch.mjs';
import { cases as booleans } from './booleans.mjs';
import { cases as patterns } from './patterns.mjs';
import { cases as modifiers } from './modifiers.mjs';
import { cases as importExport } from './import-export.mjs';

export const cases = [
  ...primitives,
  ...sketch,
  ...booleans,
  ...patterns,
  ...modifiers,
  ...importExport,
];
