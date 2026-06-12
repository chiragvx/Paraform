/**
 * E1 — palette-command surface tests.
 *
 * Verifies the 13 new commands shipped in E1 are registered with the right
 * shape (group + form fields + run + enabled gating). Does NOT execute the
 * command bodies (those call the kernel); it just verifies the contract so
 * the palette / ribbon / dialog plumbing has something to render against.
 *
 * Run with:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/commands/__tests__/registry.mjs
 */
import assert from 'node:assert/strict';
import { COMMANDS } from '../registry.js';
import { getDocumentStore, resetDocumentStore, addBox } from '../../../../lib/document/index.js';

let _pass = 0;
let _fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); _pass++; }
  catch (e) { console.error(`  FAIL ${name}\n    ${e?.message || e}`); _fail++; }
}

const byId = Object.fromEntries(COMMANDS.map(c => [c.id, c]));

const NEW_IDS = [
  'sketch.sweep', 'sketch.loft', 'geom.helix',
  'modifier.hole', 'modifier.draft',
  'pattern.linear', 'pattern.circular', 'pattern.mirror', 'pattern.path',
  'ref.plane', 'ref.axis', 'ref.point',
];
// Note: 12 form commands above + the 13th E1 item is the Toolbar wiring
// (E1.5). The 13 "ops" the spec asks about are sketch.sweep / sketch.loft /
// geom.helix / modifier.hole / modifier.draft / pattern.{linear,circular,
// mirror,path} / ref.{plane,axis,point}. (The Toolbar edits are verified by
// the build, not this test file.)

console.log('── E1 command registry contract ──');

// 1. presence
for (const id of NEW_IDS) {
  t(`${id} is registered`, () => {
    assert.ok(byId[id], `command ${id} not found in COMMANDS`);
  });
}

// 2. shape
for (const id of NEW_IDS) {
  t(`${id} has group + title + run + form`, () => {
    const c = byId[id];
    assert.equal(typeof c.title, 'string');
    assert.ok(c.title.length > 0);
    assert.equal(typeof c.group, 'string');
    assert.ok(c.group.length > 0);
    assert.equal(typeof c.run, 'function');
    assert.ok(c.form, 'expected form schema');
    assert.ok(Array.isArray(c.form.fields));
    assert.ok(c.form.fields.length > 0);
    for (const f of c.form.fields) {
      assert.equal(typeof f.key, 'string');
      assert.equal(typeof f.label, 'string');
      assert.ok(['number', 'boolean', 'select', 'text'].includes(f.type),
        `unsupported field type ${f.type} on ${id}/${f.key}`);
      if (f.type === 'select') {
        assert.ok(Array.isArray(f.options) && f.options.length > 0,
          `select field ${id}/${f.key} missing options`);
      }
    }
  });
}

// 3. enabled-gating for body-source commands
const BODY_GATED = [
  'modifier.hole', 'modifier.draft',
  'pattern.linear', 'pattern.circular', 'pattern.mirror', 'pattern.path',
];

t('body-gated commands disabled on empty store', () => {
  resetDocumentStore();
  const store = getDocumentStore();
  for (const id of BODY_GATED) {
    const c = byId[id];
    assert.equal(typeof c.enabled, 'function', `${id} should have enabled() gate`);
    assert.equal(c.enabled({ store }), false, `${id} enabled() should be false on empty store`);
  }
});

t('body-gated commands enabled when a body feature is selected', () => {
  resetDocumentStore();
  const store = getDocumentStore();
  const box = addBox({ length: 5, width: 5, height: 5 });
  // The body output is populated post-eval; emulate that for the test so
  // isBodySource() returns true.
  store.doc.features[box.id].outputs = { bodies: [{ id: box.id }], sketches: [], faces: [], edges: [] };
  store.selectFeature(box.id);
  for (const id of BODY_GATED) {
    const c = byId[id];
    assert.equal(c.enabled({ store }), true, `${id} enabled() should be true with selected body`);
  }
});

// 4. group taxonomy
t('groups match the spec', () => {
  assert.equal(byId['sketch.sweep'].group,    'Sketches');
  assert.equal(byId['sketch.loft'].group,     'Sketches');
  assert.equal(byId['geom.helix'].group,      'Reference geometry');
  assert.equal(byId['modifier.hole'].group,   'Modifiers');
  assert.equal(byId['modifier.draft'].group,  'Modifiers');
  assert.equal(byId['pattern.linear'].group,  'Pattern');
  assert.equal(byId['pattern.circular'].group,'Pattern');
  assert.equal(byId['pattern.mirror'].group,  'Pattern');
  assert.equal(byId['pattern.path'].group,    'Pattern');
  assert.equal(byId['ref.plane'].group,       'Reference geometry');
  assert.equal(byId['ref.axis'].group,        'Reference geometry');
  assert.equal(byId['ref.point'].group,       'Reference geometry');
});

// 5. submitLabel
t('form submitLabel present on every new command', () => {
  for (const id of NEW_IDS) {
    assert.ok(byId[id].form.submitLabel, `${id} missing submitLabel`);
  }
});

console.log(`\n${_pass} passed, ${_fail} failed`);
if (_fail > 0) process.exit(1);
