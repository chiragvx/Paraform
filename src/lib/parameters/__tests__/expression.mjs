// Zero-dep test suite for the expression parser.
// Run with: node src/lib/parameters/__tests__/expression.mjs

import assert from 'node:assert/strict';
import {
  parse,
  evaluate,
  extractDeps,
  validate,
  format,
} from '../expression.js';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push({ name, error: e });
  }
}

const approx = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

// ---- Literals --------------------------------------------------------------

test('integer literal', () => assert.equal(evaluate('5', {}), 5));
test('decimal literal', () => assert.equal(evaluate('5.5', {}), 5.5));
test('leading-dot decimal', () => assert.equal(evaluate('.5', {}), 0.5));
test('literal with mm', () => assert.equal(evaluate('5mm', {}), 5));
test('literal with cm', () => assert.equal(evaluate('1cm', {}), 10));
test('literal with m', () => assert.equal(evaluate('1m', {}), 1000));
test('literal with in', () => approx(evaluate('1in', {}), 25.4));
test('decimal with unit', () => approx(evaluate('0.5m', {}), 500));

// ---- Operators and precedence ---------------------------------------------

test('addition', () => assert.equal(evaluate('2 + 3', {}), 5));
test('subtraction', () => assert.equal(evaluate('10 - 4', {}), 6));
test('multiplication', () => assert.equal(evaluate('3 * 4', {}), 12));
test('division', () => assert.equal(evaluate('12 / 4', {}), 3));
test('mul before add', () => assert.equal(evaluate('2 + 3 * 4', {}), 14));
test('div before sub', () => assert.equal(evaluate('20 - 12 / 4', {}), 17));
test('parens override', () => assert.equal(evaluate('(2 + 3) * 4', {}), 20));
test('left-assoc subtraction', () => assert.equal(evaluate('10 - 3 - 2', {}), 5));
test('left-assoc division', () => assert.equal(evaluate('100 / 5 / 2', {}), 10));
test('unary minus', () => assert.equal(evaluate('-5', {}), -5));
test('unary plus', () => assert.equal(evaluate('+5', {}), 5));
test('unary in expr', () => assert.equal(evaluate('3 + -2', {}), 1));
test('double unary', () => assert.equal(evaluate('--5', {}), 5));

// ---- Functions -------------------------------------------------------------

test('min()', () => assert.equal(evaluate('min(3, 5)', {}), 3));
test('max()', () => assert.equal(evaluate('max(3, 5)', {}), 5));
test('abs() positive', () => assert.equal(evaluate('abs(5)', {}), 5));
test('abs() negative', () => assert.equal(evaluate('abs(-5)', {}), 5));
test('sqrt()', () => assert.equal(evaluate('sqrt(16)', {}), 4));
test('sin(0)', () => approx(evaluate('sin(0)', {}), 0));
test('cos(0)', () => approx(evaluate('cos(0)', {}), 1));
test('pi constant', () => approx(evaluate('pi', {}), Math.PI));
test('sin(pi)', () => approx(evaluate('sin(pi)', {}), 0, 1e-10));
test('nested functions', () =>
  assert.equal(evaluate('max(min(10, 5), 3)', {}), 5));
test('function in expr', () =>
  assert.equal(evaluate('2 * sqrt(16) + 1', {}), 9));

// ---- Identifier lookup -----------------------------------------------------

test('simple identifier', () =>
  assert.equal(evaluate('width', { width: 30 }), 30));
test('identifier in expr', () =>
  assert.equal(evaluate('width / 2', { width: 30 }), 15));
test('multiple identifiers', () =>
  assert.equal(evaluate('w + h', { w: 10, h: 5 }), 15));
test('snake_case identifier', () =>
  assert.equal(evaluate('outer_size', { outer_size: 42 }), 42));
test('camelCase identifier', () =>
  assert.equal(evaluate('wallThickness', { wallThickness: 2.5 }), 2.5));
test('identifier with digits', () =>
  assert.equal(evaluate('len2 + 1', { len2: 4 }), 5));
test('identifier with leading underscore', () =>
  assert.equal(evaluate('_x', { _x: 7 }), 7));

// ---- Mixed units -----------------------------------------------------------

test('5mm + 1in', () => approx(evaluate('5mm + 1in', {}), 30.4));
test('1m - 50cm', () => approx(evaluate('1m - 50cm', {}), 500));
test('mixed with ident', () =>
  approx(evaluate('width + 1in', { width: 10 }), 35.4));

// ---- Error cases -----------------------------------------------------------

test('empty expression throws', () =>
  assert.throws(() => evaluate('', {}), /empty expression/));
test('whitespace-only throws', () =>
  assert.throws(() => evaluate('   ', {}), /empty expression/));
test('unknown variable throws', () =>
  assert.throws(() => evaluate('foo + 1', {}), /unknown variable: foo/));
test('divide by zero throws', () =>
  assert.throws(() => evaluate('5 / 0', {}), /divide by zero/));
test('divide by zero via expr', () =>
  assert.throws(() => evaluate('5 / (2 - 2)', {}), /divide by zero/));
test('syntax error: trailing op', () =>
  assert.throws(() => evaluate('5 +', {})));
test('syntax error: unmatched paren', () =>
  assert.throws(() => evaluate('(5 + 3', {})));
test('syntax error: bad char', () =>
  assert.throws(() => evaluate('5 & 3', {})));
test('unknown unit throws', () =>
  assert.throws(() => evaluate('5foo', {}), /unknown unit/));
test('unknown function throws', () =>
  assert.throws(() => evaluate('bogus(5)', {}), /unknown function/));
test('wrong arity throws', () =>
  assert.throws(() => evaluate('min(5)', {}), /expects 2/));

// ---- validate() ------------------------------------------------------------

test('validate ok', () => {
  const r = validate('5 + 3');
  assert.equal(r.valid, true);
  assert.equal(r.error, undefined);
});
test('validate empty', () => {
  const r = validate('');
  assert.equal(r.valid, false);
  assert.match(r.error, /empty/);
});
test('validate syntax error', () => {
  const r = validate('5 +');
  assert.equal(r.valid, false);
  assert.ok(r.error);
});
test('validate never throws', () => {
  // any garbage input should be a clean { valid: false }
  for (const s of ['', '   ', '5 +', '(((', ')', '@#$', '5 & 3']) {
    const r = validate(s);
    assert.equal(r.valid, false);
  }
});

// ---- extractDeps -----------------------------------------------------------

test('extractDeps: simple', () =>
  assert.deepEqual(extractDeps('width / 2'), ['width']));
test('extractDeps: multiple', () =>
  assert.deepEqual(extractDeps('w + h * 2').sort(), ['h', 'w']));
test('extractDeps: dedup', () =>
  assert.deepEqual(extractDeps('w + w * w'), ['w']));
test('extractDeps: ignores functions', () =>
  assert.deepEqual(extractDeps('min(a, b)').sort(), ['a', 'b']));
test('extractDeps: ignores pi', () =>
  assert.deepEqual(extractDeps('r * pi'), ['r']));
test('extractDeps: literal only', () =>
  assert.deepEqual(extractDeps('5 + 3'), []));
test('extractDeps: nested funcs', () =>
  assert.deepEqual(extractDeps('max(sqrt(x), abs(y))').sort(), ['x', 'y']));
test('extractDeps: unit literal', () =>
  assert.deepEqual(extractDeps('5mm + 1in'), []));

// ---- parse() returns AST ---------------------------------------------------

test('parse returns object', () => {
  const ast = parse('5 + 3');
  assert.equal(ast.type, 'binop');
  assert.equal(ast.op, '+');
});
test('parse throws on empty', () =>
  assert.throws(() => parse(''), /empty expression/));

// ---- format() --------------------------------------------------------------

test('format default', () => assert.equal(format(30.4, 'mm', 2), '30.40 mm'));
test('format no decimals', () => assert.equal(format(30.4, 'mm', 0), '30 mm'));
test('format different unit', () =>
  assert.equal(format(1.5, 'in', 3), '1.500 in'));
test('format no unit', () => assert.equal(format(5, '', 1), '5.0'));
test('format defaults to mm/2', () =>
  assert.equal(format(3.14159), '3.14 mm'));

// ---- Done ------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const { name, error } of failures) {
    console.error(`  FAIL: ${name}`);
    console.error(`    ${error.message}`);
  }
  process.exit(1);
}
