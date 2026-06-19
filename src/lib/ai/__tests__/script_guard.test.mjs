/**
 * Script-guard tests — the fast static pre-check for AI-authored build123d.
 *
 * Covers the sandbox-escape rejections (imports / builtins / dunders) AND the
 * typed-op tool-call redirect added after the RC-car transcript: the model
 * crammed `addGear(...)` / `Box(..., centered=True)` into a writeBuildScript and
 * the script NameError'd at compile because those tools don't exist in the
 * sandbox. The guard now turns that into an actionable message up front. PURE.
 *
 * Run via:
 *   node src/lib/ai/__tests__/script_guard.test.mjs
 */
import assert from 'node:assert/strict';

import { guardScript } from '../script_guard.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
    try { fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

const ok = (r) => r && r.ok === true;
const blocked = (r) => r && r.ok === false && typeof r.error === 'string';

console.log('── Script guard (sandbox pre-check + typed-op redirect) ──');

// ── existing safety rails still hold (regression) ───────────────────────────
t('a clean pure-build123d script passes', () => {
    const code = 'from build123d import *\nresult = Box(10, 10, 10)';
    assert.ok(ok(guardScript(code)));
});

t('blocked module import is rejected', () => {
    const r = guardScript('import os\nresult = None');
    assert.ok(blocked(r));
    assert.match(r.error, /os/);
});

t('blocked builtin call is rejected', () => {
    assert.ok(blocked(guardScript('from build123d import *\nopen("x")')));
});

t('empty / non-string is rejected', () => {
    assert.ok(blocked(guardScript('')));
    assert.ok(blocked(guardScript(null)));
});

// ── typed-op tool calls inside a script → redirect ──────────────────────────
t('addGear(...) in a script is redirected (the RC-car bug)', () => {
    const code = 'from build123d import *\npinion = addGear(teeth=12, module=1.5)\nresult = pinion';
    const r = guardScript(code);
    assert.ok(blocked(r));
    assert.match(r.error, /addGear/);
    assert.match(r.error, /typed-op TOOL/);
});

t('a generator (addMountingPlate) in a script is redirected', () => {
    assert.ok(blocked(guardScript('from build123d import *\nresult = addMountingPlate(width=40)')));
});

t('snake_case tools (add_mate, build_part_recipe) are caught', () => {
    assert.ok(blocked(guardScript('from build123d import *\nadd_mate(a, b)\nresult = a')));
    assert.ok(blocked(guardScript('from build123d import *\nresult = build_part_recipe("servoMount")')));
});

t('placeLibraryPart in a script is redirected', () => {
    assert.ok(blocked(guardScript('from build123d import *\nresult = placeLibraryPart("m3_bolt")')));
});

t('a METHOD that merely shares a tool name is NOT flagged', () => {
    // `.addBox(` is a method call on some object, not the global tool.
    const code = 'from build123d import *\nbuilder = thing()\nbuilder.addBox(1)\nresult = builder.part';
    assert.ok(ok(guardScript(code)));
});

t('a longer identifier ending in a tool name is NOT flagged', () => {
    const code = 'from build123d import *\ndef my_addGear():\n    return Box(1,1,1)\nresult = my_addGear()';
    assert.ok(ok(guardScript(code)));
});

t('a script that DEFINES its own addGear may call it (user helper)', () => {
    const code = 'from build123d import *\ndef addGear(teeth):\n    return Cylinder(teeth, 5)\nresult = addGear(12)';
    assert.ok(ok(guardScript(code)));
});

t('the typed-op redirect does not fire on innocent build123d', () => {
    // `add(` (builder-mode lowercase) and `addends` must not trip the camelCase rule.
    const code = 'from build123d import *\naddends = [1, 2]\nresult = Box(sum(addends), 5, 5)';
    assert.ok(ok(guardScript(code)));
});

console.log(`\nScript guard: ${_pass} passed, ${_fail} failed`);
if (_fail) process.exit(1);
