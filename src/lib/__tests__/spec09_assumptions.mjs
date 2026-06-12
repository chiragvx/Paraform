/**
 * Spec 09 — assumptions manifest.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/__tests__/spec09_assumptions.mjs
 *
 * Covers:
 *   1. AssumptionRecord factory shape
 *   2. Store ops (add / ack / remove / clear)
 *   3. Serialize round-trip — assumptions survive toJSON/fromJSON via changelog
 *   4. Extractor bridge — ambiguities become source='extractor' records
 *   5. Standard-parts default-grade emitter
 *   6. Panel filter logic (pure derivation)
 *   7. Manifest export markdown shape
 */
import assert from 'node:assert/strict';
import {
  makeAssumption,
  resetDocumentStore,
  getDocumentStore,
  addAssumption,
  acknowledgeAssumption,
  removeAssumption,
  clearAssumptions,
  ingestExtractorAmbiguities,
  recordStandardPartGradeDefaults,
  STANDARD_PART_DEFAULT_GRADES,
  addStandardPart,
} from '../../../lib/document/index.js';
import {
  exportAssumptionsManifest,
  defaultManifestFilename,
  ASSUMPTION_SOURCES,
} from '$lib/document/assumptions_manifest.js';
import { extract } from '$lib/extractor/index.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    _pass++;
  } catch (e) {
    console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`);
    _fail++;
  }
}

console.log('── spec 09 — assumptions manifest ──');

// 1. Factory shape ────────────────────────────────────────────────────────────
t('makeAssumption: defaults are sane', () => {
  const a = makeAssumption({ detail: 'hello' });
  assert.equal(a.source, 'user');
  assert.equal(a.kind, 'unspecified');
  assert.equal(a.detail, 'hello');
  assert.equal(a.severity, 'info');
  assert.equal(a.acknowledged, false);
  assert.equal(typeof a.timestamp, 'number');
  assert.match(a.id, /^asm_/);
});

t('makeAssumption: clamps unknown source / severity', () => {
  const a = makeAssumption({ source: 'bogus', severity: 'critical' });
  assert.equal(a.source, 'user');
  assert.equal(a.severity, 'info');
});

t('makeAssumption: respects valid source + severity + relatedFeatureId', () => {
  const a = makeAssumption({
    source: 'extractor',
    severity: 'warning',
    relatedFeatureId: 'feat_1',
    alternatives: ['6061', '7075'],
  });
  assert.equal(a.source, 'extractor');
  assert.equal(a.severity, 'warning');
  assert.equal(a.relatedFeatureId, 'feat_1');
  assert.deepEqual(a.alternatives, ['6061', '7075']);
});

// 2. Store ops ────────────────────────────────────────────────────────────────
t('addAssumption: appends to doc.assumptions', () => {
  resetDocumentStore();
  const rec = addAssumption({ source: 'user', kind: 'wall-thickness', detail: 'assumed 2mm' });
  const store = getDocumentStore();
  assert.equal(store.doc.assumptions.length, 1);
  assert.equal(store.doc.assumptions[0].id, rec.id);
});

t('addAssumption: dedups by (source,kind,detail,relatedFeatureId)', () => {
  resetDocumentStore();
  const a = addAssumption({ source: 'user', kind: 'k', detail: 'd' });
  const b = addAssumption({ source: 'user', kind: 'k', detail: 'd' });
  assert.ok(a);
  assert.equal(b, null);
  assert.equal(getDocumentStore().doc.assumptions.length, 1);
});

t('acknowledgeAssumption: flips the bool', () => {
  resetDocumentStore();
  const a = addAssumption({ source: 'user', kind: 'k', detail: 'd' });
  acknowledgeAssumption(a.id, true);
  assert.equal(getDocumentStore().doc.assumptions[0].acknowledged, true);
  acknowledgeAssumption(a.id, false);
  assert.equal(getDocumentStore().doc.assumptions[0].acknowledged, false);
});

t('removeAssumption: drops the row', () => {
  resetDocumentStore();
  const a = addAssumption({ source: 'user', kind: 'a', detail: 'one' });
  addAssumption({ source: 'user', kind: 'b', detail: 'two' });
  removeAssumption(a.id);
  const left = getDocumentStore().doc.assumptions;
  assert.equal(left.length, 1);
  assert.equal(left[0].kind, 'b');
});

t('clearAssumptions: filter by source clears only that source', () => {
  resetDocumentStore();
  addAssumption({ source: 'extractor', kind: 'k1', detail: 'd1' });
  addAssumption({ source: 'user',      kind: 'k2', detail: 'd2' });
  clearAssumptions({ source: 'extractor' });
  const left = getDocumentStore().doc.assumptions;
  assert.equal(left.length, 1);
  assert.equal(left[0].source, 'user');
});

t('clearAssumptions: no filter wipes everything', () => {
  resetDocumentStore();
  addAssumption({ source: 'user', kind: 'k', detail: 'd' });
  clearAssumptions();
  assert.equal(getDocumentStore().doc.assumptions.length, 0);
});

// 3. Serialize round-trip ─────────────────────────────────────────────────────
t('serialize round-trip: assumptions persist via changelog', () => {
  resetDocumentStore();
  addAssumption({ source: 'extractor', kind: 'material-grade', detail: 'aluminum default 6061', defaultUsed: '6061' });
  addAssumption({ source: 'user', kind: 'edge-distance', detail: 'assumed 5mm' });
  const json = getDocumentStore().toJSON();
  assert.ok(Array.isArray(json.assumptions));
  assert.equal(json.assumptions.length, 2);

  // Round trip
  const store2 = resetDocumentStore();
  store2.fromJSON(json);
  assert.equal(store2.doc.assumptions.length, 2);
  const sources = store2.doc.assumptions.map(a => a.source).sort();
  assert.deepEqual(sources, ['extractor', 'user']);
});

// 4. Extractor bridge ──────────────────────────────────────────────────────────
t('ingestExtractorAmbiguities: converts notes to source=extractor records', () => {
  resetDocumentStore();
  const fake = {
    ambiguities: [
      { kind: 'material-grade', detail: 'aluminum grade unspecified (default: 6061)', field: 'material' },
      { kind: 'fastener-length', detail: 'M3 length unspecified' },
    ],
  };
  const recs = ingestExtractorAmbiguities(fake, { relatedFeatureId: 'feat_x' });
  assert.equal(recs.length, 2);
  assert.equal(recs[0].source, 'extractor');
  assert.equal(recs[0].kind, 'material-grade');
  assert.equal(recs[0].relatedFeatureId, 'feat_x');
});

t('ingestExtractorAmbiguities: end-to-end on the worked example', () => {
  resetDocumentStore();
  const ex = extract('60×40×3 mm aluminum plate with four M3 clearance holes at the corners, 5 mm from each edge');
  assert.ok(ex.ambiguities.length >= 1);
  const before = getDocumentStore().doc.assumptions.length;
  const recs = ingestExtractorAmbiguities(ex);
  assert.ok(recs.length >= 1);
  assert.equal(getDocumentStore().doc.assumptions.length, before + recs.length);
  assert.ok(recs.every(r => r.source === 'extractor'));
});

// 5. Standard-parts default-grade emitter ─────────────────────────────────────
t('recordStandardPartGradeDefaults: family-only entryId produces an assumption', () => {
  resetDocumentStore();
  const f = { id: 'feat_sp1', type: 'StandardPart', params: { entryId: 'aluminum-default' } };
  const out = recordStandardPartGradeDefaults(f);
  assert.equal(out.length, 1);
  assert.equal(out[0].source, 'standard-parts');
  assert.equal(out[0].defaultUsed, STANDARD_PART_DEFAULT_GRADES.aluminum);
  assert.equal(out[0].relatedFeatureId, 'feat_sp1');
});

t('recordStandardPartGradeDefaults: graded entryId stays silent', () => {
  resetDocumentStore();
  // The catalog id carries an explicit grade ("6061"), so we shouldn't
  // record a default-grade assumption.
  const f = { id: 'feat_sp2', type: 'StandardPart', params: { entryId: 'aluminum-6061-plate' } };
  const out = recordStandardPartGradeDefaults(f);
  assert.equal(out.length, 0);
});

t('recordStandardPartGradeDefaults: partRef.materialFamily without grade triggers default', () => {
  resetDocumentStore();
  const f = { id: 'feat_sp3', type: 'StandardPart',
    params: { entryId: 'bearing-608', partRef: { materialFamily: 'steel' } } };
  const out = recordStandardPartGradeDefaults(f);
  assert.ok(out.length >= 1);
  assert.equal(out[0].defaultUsed, STANDARD_PART_DEFAULT_GRADES.steel);
});

t('addStandardPart: runs the audit automatically', () => {
  resetDocumentStore();
  addStandardPart('aluminum-default');
  const asms = getDocumentStore().doc.assumptions;
  assert.ok(asms.length >= 1);
  assert.ok(asms.some(a => a.source === 'standard-parts'));
});

// 6. Panel filter logic (pure derivation) ─────────────────────────────────────
t('filter by source: extracts only requested', () => {
  resetDocumentStore();
  addAssumption({ source: 'extractor', kind: 'k1', detail: 'd1' });
  addAssumption({ source: 'user',      kind: 'k2', detail: 'd2' });
  addAssumption({ source: 'extractor', kind: 'k3', detail: 'd3' });
  const all = getDocumentStore().doc.assumptions;
  const onlyExtractor = all.filter(a => a.source === 'extractor');
  assert.equal(onlyExtractor.length, 2);
});

t('ASSUMPTION_SOURCES enumerates the five sources', () => {
  assert.deepEqual([...ASSUMPTION_SOURCES].sort(),
    ['extractor', 'invariant', 'kernel', 'standard-parts', 'user']);
});

// 7. Manifest export markdown shape ───────────────────────────────────────────
t('exportAssumptionsManifest: empty list yields a recognisable empty body', () => {
  const md = exportAssumptionsManifest([], { generatedAt: 0 });
  assert.match(md, /# Assumptions manifest/);
  assert.match(md, /No assumptions recorded/);
});

t('exportAssumptionsManifest: groups by source and renders a markdown table', () => {
  const recs = [
    makeAssumption({ source: 'extractor', kind: 'material-grade', detail: 'al default 6061', defaultUsed: '6061' }),
    makeAssumption({ source: 'standard-parts', kind: 'material-grade', detail: 'bearing steel default', defaultUsed: '1018' }),
    makeAssumption({ source: 'user', kind: 'edge-distance', detail: '5mm', acknowledged: true }),
  ];
  const md = exportAssumptionsManifest(recs, { generatedAt: 0 });
  assert.match(md, /Extractor \(spec text\)/);
  assert.match(md, /Standard parts catalog/);
  assert.match(md, /\| Kind \| Detail \| Default \| Severity \| Acknowledged \|/);
  assert.match(md, /material-grade/);
  // Total / ack summary row is present.
  assert.match(md, /\*\*Total:\*\* 3/);
  assert.match(md, /Acknowledged:\*\* 1 \/ 3/);
});

t('defaultManifestFilename: sanitises name', () => {
  assert.equal(defaultManifestFilename('My/Doc.json'), 'My_Doc.json-assumptions.md');
  assert.equal(defaultManifestFilename(''), 'document-assumptions.md');
});

// ── Report ──
console.log(`\n  ${_pass} passed, ${_fail} failed`);
process.exit(_fail > 0 ? 1 : 0);
