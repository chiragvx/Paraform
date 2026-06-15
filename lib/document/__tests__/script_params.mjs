/**
 * Phase C2 — BuildScript parameter hoisting (extractScriptParams / setScriptParam).
 * Zero-dep node:assert. Registered in all.mjs.
 */
import assert from 'node:assert/strict';
import { extractScriptParams, setScriptParam } from '../script_params.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); _pass++; }
  catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

console.log('── Phase C2 — BuildScript parameter hoisting ──');

const SCRIPT = [
  'from build123d import *',
  'WIDTH = 40        # param',
  'HOLE_D = 5        # param [1:12]',
  'COUNT = 6         # param 2..24',
  'ANGLE = 30.0      # param [0:90] deg',
  'SECRET = 99       # not exposed (no marker)',
  'result = Box(WIDTH, WIDTH, 10)',
].join('\n');

t('extracts only marked params, with ranges + units', () => {
  const ps = extractScriptParams(SCRIPT);
  assert.equal(ps.length, 4, `expected 4 params, got ${ps.length}`);
  const by = Object.fromEntries(ps.map(p => [p.name, p]));
  assert.equal(by.WIDTH.value, 40);
  assert.equal(by.WIDTH.min, undefined);
  assert.deepEqual([by.HOLE_D.min, by.HOLE_D.max], [1, 12]);
  assert.deepEqual([by.COUNT.min, by.COUNT.max], [2, 24]);
  assert.deepEqual([by.ANGLE.min, by.ANGLE.max], [0, 90]);
  assert.equal(by.ANGLE.unit, 'deg');
  assert.equal(by.SECRET, undefined, 'unmarked constant must not be hoisted');
});

t('setScriptParam updates value, preserves marker + indentation', () => {
  const next = setScriptParam(SCRIPT, 'WIDTH', 55);
  assert.ok(next.includes('WIDTH = 55        # param'), `got:\n${next}`);
  // Everything else untouched.
  assert.ok(next.includes('result = Box(WIDTH, WIDTH, 10)'));
  assert.ok(next.includes('SECRET = 99'));
});

t('setScriptParam round-trips through extract', () => {
  const next = setScriptParam(SCRIPT, 'HOLE_D', 9);
  const p = extractScriptParams(next).find(x => x.name === 'HOLE_D');
  assert.equal(p.value, 9);
  assert.deepEqual([p.min, p.max], [1, 12], 'range preserved after edit');
});

t('setScriptParam writes floats and ints correctly', () => {
  assert.ok(setScriptParam(SCRIPT, 'ANGLE', 45).includes('ANGLE = 45 '), 'int form');
  assert.ok(setScriptParam(SCRIPT, 'ANGLE', 22.5).includes('ANGLE = 22.5 '), 'float form');
});

t('setScriptParam leaves code unchanged for unknown / unmarked names', () => {
  assert.equal(setScriptParam(SCRIPT, 'NOPE', 1), SCRIPT);
  assert.equal(setScriptParam(SCRIPT, 'SECRET', 1), SCRIPT, 'unmarked must not be editable');
});

t('handles empty / non-string input safely', () => {
  assert.deepEqual(extractScriptParams(''), []);
  assert.deepEqual(extractScriptParams(null), []);
  assert.equal(setScriptParam('', 'X', 1), '');
});

console.log(`\n${_pass} passed, ${_fail} failed`);
if (_fail > 0) process.exit(1);
