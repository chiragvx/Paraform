/**
 * Code escape-hatch tools — guardScript static pre-check + CODE_TOOLS shape.
 *
 * Verifies that:
 *   (a) guardScript REJECTS dangerous tokens (`import os`, `from subprocess
 *       import run`, `eval(`, `__subclasses__`) with a message naming them;
 *   (b) guardScript PASSES a normal build123d snippet that assigns `result`;
 *   (c) CODE_TOOLS exposes writeBuildScript and editBuildScript in the standard
 *       tool shape — each a handler function with an input_schema requiring code.
 *
 * Plain `node` asserts, no framework, relative imports so it needs no loader.
 *
 * Run via:
 *   node src/lib/ai/__tests__/code_tools.test.mjs
 */
import assert from 'node:assert/strict';

import { guardScript } from '../script_guard.js';
import { CODE_TOOLS } from '../tools_code.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
    try { fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

console.log('── Code escape-hatch tools (guardScript + CODE_TOOLS) ──');

// ── (a) guardScript rejects the dangerous tokens ─────────────────────────────

t('guardScript rejects `import os`', () => {
    const r = guardScript('import os\nresult = None');
    assert.equal(r.ok, false, 'import os must be rejected');
    assert.match(r.error, /os/, 'error names the offending module');
});

t('guardScript rejects `from subprocess import run`', () => {
    const r = guardScript('from subprocess import run\nresult = None');
    assert.equal(r.ok, false, 'from subprocess import must be rejected');
    assert.match(r.error, /subprocess/, 'error names the offending module');
});

t('guardScript rejects an `eval(` call', () => {
    const r = guardScript('from build123d import *\nx = eval("1+1")\nresult = Box(1,1,1)');
    assert.equal(r.ok, false, 'eval( must be rejected');
    assert.match(r.error, /eval/, 'error names the offending builtin');
});

t('guardScript rejects the `__subclasses__` dunder escape', () => {
    const r = guardScript('result = (object).__subclasses__()');
    assert.equal(r.ok, false, '__subclasses__ must be rejected');
    assert.match(r.error, /__subclasses__/, 'error names the offending dunder');
});

// ── (b) guardScript passes a normal snippet ──────────────────────────────────

t('guardScript passes a normal build123d snippet assigning result', () => {
    const code = [
        'from build123d import *',
        'import math',
        'with BuildPart() as part:',
        '    Box(20, 20, 10)',
        'result = part.part',
    ].join('\n');
    const r = guardScript(code);
    assert.equal(r.ok, true, `expected pass, got: ${r.error}`);
});

t('guardScript does NOT flag a variable that merely contains the word import', () => {
    // `import_count` has no import/from keyword in front → must pass.
    const code = 'from build123d import *\nimport_count = 3\nresult = Box(1, 1, 1)';
    const r = guardScript(code);
    assert.equal(r.ok, true, `expected pass, got: ${r.error}`);
});

// ── (c) CODE_TOOLS shape ─────────────────────────────────────────────────────

t('CODE_TOOLS contains writeBuildScript and editBuildScript', () => {
    assert.ok(Array.isArray(CODE_TOOLS), 'CODE_TOOLS is an array');
    const names = CODE_TOOLS.map((x) => x.name);
    assert.ok(names.includes('writeBuildScript'), 'writeBuildScript present');
    assert.ok(names.includes('editBuildScript'), 'editBuildScript present');
});

t('each code tool has a handler fn and an input_schema requiring code', () => {
    for (const name of ['writeBuildScript', 'editBuildScript']) {
        const tool = CODE_TOOLS.find((x) => x.name === name);
        assert.ok(tool, `${name} found`);
        assert.equal(typeof tool.handler, 'function', `${name} has a handler function`);
        assert.equal(typeof tool.description, 'string', `${name} has a description`);
        assert.ok(tool.input_schema && tool.input_schema.type === 'object', `${name} has an object input_schema`);
        assert.ok(
            Array.isArray(tool.input_schema.required) && tool.input_schema.required.includes('code'),
            `${name} input_schema requires 'code'`,
        );
    }
    // editBuildScript additionally requires featureId.
    const edit = CODE_TOOLS.find((x) => x.name === 'editBuildScript');
    assert.ok(edit.input_schema.required.includes('featureId'), 'editBuildScript requires featureId');
});

console.log(`\n${_pass} passed, ${_fail} failed`);
if (_fail > 0) process.exit(1);
