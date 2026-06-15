/**
 * Tests for src/lib/invariants/library.js.
 *
 * Run with: `node src/lib/invariants/__tests__/invariants.mjs`
 *
 * Strategy mirrors src/lib/dfm/__tests__/fit_check.mjs: feature / catalog
 * / measure / dfm providers are all injected via the test hatches and
 * each test feeds a minimal in-memory doc. Nothing reaches the kernel,
 * the DocumentStore, or three.js.
 *
 * Target: ≥ 30 cases, ≥ 1 per invariant covering pass / fail / not-applicable
 * where applicable.
 */

import assert from 'node:assert/strict';

import {
    INVARIANTS,
    INVARIANTS_BY_ID,
    SCOPE,
    _setDfmModuleForTests,
    _resetDfmCacheForTests,
} from '../library.js';
import {
    setCatalogProviderForInvariants,
    resetCatalogProviderForInvariants,
    setDocProviderForInvariants,
    resetDocProviderForInvariants,
    getMaterial,
    getThreadMultiplier,
    materialFamilyBucket,
    findStandardPartEntry,
} from '../lookups.js';

// ── tiny test runner ────────────────────────────────────────────────────────

const _tests = [];
function test(name, fn) { _tests.push({ name, fn }); }

async function run() {
    let pass = 0, fail = 0;
    for (const t of _tests) {
        resetCatalogProviderForInvariants();
        resetDocProviderForInvariants();
        _resetDfmCacheForTests();
        try {
            await t.fn();
            console.log(`  \x1b[32m✓\x1b[0m ${t.name}`);
            pass++;
        } catch (e) {
            console.log(`  \x1b[31m✗\x1b[0m ${t.name}`);
            console.log(`    ${e.stack || e.message}`);
            fail++;
        }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

// ── fixtures ────────────────────────────────────────────────────────────────

const BEARING_608 = {
    id: 'bearing-608',
    category: 'Bearing',
    name: '608',
    dims: { innerDiameter: 8, outerDiameter: 22, width: 7 },
};
const SHCS_M3_16 = {
    id: 'iso4762-m3-16',
    category: 'Fastener',
    name: 'M3x16 SHCS',
    dims: { threadNominal: 3.0, threadPitch: 0.5, headDiameter: 5.5, lengthTotal: 16 },
};
const SHCS_M5_20 = {
    id: 'iso4762-m5-20',
    category: 'Fastener',
    name: 'M5x20 SHCS',
    dims: { threadNominal: 5.0, threadPitch: 0.8, headDiameter: 8.5, lengthTotal: 20 },
};

function setCatalog(entries) {
    setCatalogProviderForInvariants(async () => entries);
}

function invoke(invId, target, ctx = {}) {
    const inv = INVARIANTS_BY_ID[invId];
    if (!inv) throw new Error(`unknown invariant '${invId}'`);
    return inv.check(target, ctx);
}

// Helper: stub DFM module so geometric invariants are deterministic.
function setDfm({ manifold, selfInt, zeroThick, threadEng, bearingFit, clearanceHole } = {}) {
    _setDfmModuleForTests({
        manifoldness: async () => manifold || { ok: true, severity: 'pass', message: 'mock', measured: null },
        selfIntersection: async () => selfInt || { ok: true, severity: 'pass', message: 'mock', measured: null },
        zeroThickness: async () => zeroThick || { ok: true, severity: 'pass', message: 'mock', measured: null },
        threadEngagement: async () => threadEng || { ok: true, severity: 'pass', message: 'mock', measured: null },
        bearingBoreFit: async () => bearingFit || { ok: true, severity: 'pass', message: 'mock', measured: null },
        clearanceHoleSize: async () => clearanceHole || { ok: true, severity: 'pass', message: 'mock', measured: null },
    });
}

// ── library structural tests ────────────────────────────────────────────────

test('library: exports 31 invariants', () => {
    assert.equal(INVARIANTS.length, 31);
});

test('library: every id is unique', () => {
    const ids = INVARIANTS.map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length);
});

test('library: every record has check/scope/severity/version', () => {
    for (const inv of INVARIANTS) {
        assert.equal(typeof inv.check, 'function', `${inv.id} missing check`);
        assert.ok(Object.values(SCOPE).includes(inv.scope), `${inv.id} bad scope`);
        assert.ok(['pass','warning','error'].includes(inv.severity), `${inv.id} bad severity`);
        assert.equal(typeof inv.version, 'string', `${inv.id} missing version`);
        assert.equal(typeof inv.category, 'string', `${inv.id} missing category`);
    }
});

// ── materials DB + lookups ──────────────────────────────────────────────────

test('lookups: getMaterial resolves id, name, alias case-insensitively', () => {
    assert.ok(getMaterial('6061-T6'));
    assert.ok(getMaterial('aluminum'));
    assert.ok(getMaterial('AL6061'));
    assert.ok(getMaterial('316'));
    assert.ok(getMaterial('1.4404'));
    assert.equal(getMaterial('not-a-material'), null);
    assert.equal(getMaterial(''), null);
    assert.equal(getMaterial(null), null);
});

test('lookups: materialFamilyBucket maps to thread-multiplier keys', () => {
    assert.equal(materialFamilyBucket('6061-T6'), 'aluminum');
    assert.equal(materialFamilyBucket('A36'), 'steel');
    assert.equal(materialFamilyBucket('PLA'), 'plastic');
    assert.equal(materialFamilyBucket('316'), 'steel');     // stainless → steel bucket
    assert.equal(materialFamilyBucket('unknown'), 'steel'); // fallback
});

test('lookups: getThreadMultiplier uses profile values', () => {
    const profile = { threadEngagementMultiplier: { steel: 1.0, aluminum: 1.5, plastic: 2.0 } };
    assert.equal(getThreadMultiplier('A36', profile), 1.0);
    assert.equal(getThreadMultiplier('6061-T6', profile), 1.5);
    assert.equal(getThreadMultiplier('PLA', profile), 2.0);
});

test('lookups: findStandardPartEntry resolves via catalog provider', async () => {
    setCatalog([BEARING_608, SHCS_M3_16]);
    const e = await findStandardPartEntry('bearing-608');
    assert.equal(e.id, 'bearing-608');
    const miss = await findStandardPartEntry('nope');
    assert.equal(miss, null);
});

// ── 1. manifoldness ─────────────────────────────────────────────────────────

test('i-manifold-all-bodies: pass for valid manifold', async () => {
    setDfm({ manifold: { ok: true, severity: 'pass', message: 'OK', measured: null } });
    const r = await invoke('i-manifold-all-bodies', { id: 'b1', type: 'Box' }, {});
    assert.equal(r.severity, 'pass');
});

test('i-manifold-all-bodies: error from DFM bubbles', async () => {
    setDfm({ manifold: { ok: false, severity: 'error', message: 'open edges', measured: null } });
    const r = await invoke('i-manifold-all-bodies', { id: 'b1', type: 'Box' }, {});
    assert.equal(r.severity, 'error');
});

test('i-manifold-all-bodies: not-applicable for non-body feature', async () => {
    const r = await invoke('i-manifold-all-bodies', { id: 'f1', type: 'Fillet' }, {});
    assert.equal(r.severity, 'pass');
});

// ── 2. self-intersection ────────────────────────────────────────────────────

test('i-no-self-intersection: pass for clean', async () => {
    setDfm({ selfInt: { ok: true, severity: 'pass', message: 'OK', measured: null } });
    const r = await invoke('i-no-self-intersection', { id: 'b1', type: 'Box' }, {});
    assert.equal(r.severity, 'pass');
});

test('i-no-self-intersection: error from DFM bubbles', async () => {
    setDfm({ selfInt: { ok: false, severity: 'error', message: 'overlap', measured: null } });
    const r = await invoke('i-no-self-intersection', { id: 'b1', type: 'Box' }, {});
    assert.equal(r.severity, 'error');
});

// ── 3. zero-thickness ───────────────────────────────────────────────────────

test('i-no-zero-thickness: pass for thick body', async () => {
    setDfm({ zeroThick: { ok: true, severity: 'pass', message: 'OK', measured: null } });
    const r = await invoke('i-no-zero-thickness', { id: 'b1', type: 'Box' }, {});
    assert.equal(r.severity, 'pass');
});

test('i-no-zero-thickness: error bubbles when too thin', async () => {
    setDfm({ zeroThick: { ok: false, severity: 'error', message: 'too thin', measured: null } });
    const r = await invoke('i-no-zero-thickness', { id: 'b1', type: 'Box' }, {});
    assert.equal(r.severity, 'error');
});

// ── 4. material-assigned ────────────────────────────────────────────────────

test('i-material-assigned: pass when material present', async () => {
    const r = await invoke('i-material-assigned', { id: 'b1', type: 'Box', params: { material: '6061-T6' } });
    assert.equal(r.severity, 'pass');
});

test('i-material-assigned: warn when missing', async () => {
    const r = await invoke('i-material-assigned', { id: 'b1', type: 'Box', params: {} });
    assert.equal(r.severity, 'warning');
});

test('i-material-assigned: not-applicable for non-body', async () => {
    const r = await invoke('i-material-assigned', { id: 'f1', type: 'Fillet', params: {} });
    assert.equal(r.severity, 'pass');
});

// ── 5. material-in-database ─────────────────────────────────────────────────

test('i-material-in-database: pass for known alias', async () => {
    const r = await invoke('i-material-in-database', { id: 'b1', type: 'Box', params: { material: '6061' } });
    assert.equal(r.severity, 'pass');
});

test('i-material-in-database: error for unknown material', async () => {
    const r = await invoke('i-material-in-database', { id: 'b1', type: 'Box', params: { material: 'unobtanium' } });
    assert.equal(r.severity, 'error');
});

test('i-material-in-database: not-applicable when material unset', async () => {
    const r = await invoke('i-material-in-database', { id: 'b1', type: 'Box', params: {} });
    assert.equal(r.severity, 'pass');
});

// ── 6. process-assigned ─────────────────────────────────────────────────────

test('i-process-assigned: pass when profileId is set', async () => {
    const r = await invoke('i-process-assigned', { profileId: '3d-print' }, {});
    assert.equal(r.severity, 'pass');
});

test('i-process-assigned: warn when nothing set', async () => {
    const r = await invoke('i-process-assigned', {}, {});
    assert.equal(r.severity, 'warning');
});

// ── 7. standard-part exists ─────────────────────────────────────────────────

test('i-standardpart-exists-in-catalog: pass for known entry', async () => {
    setCatalog([BEARING_608]);
    const r = await invoke('i-standardpart-exists-in-catalog',
        { id: 's1', type: 'StandardPart', params: { entryId: 'bearing-608' } });
    assert.equal(r.severity, 'pass');
});

test('i-standardpart-exists-in-catalog: error for missing entry', async () => {
    setCatalog([BEARING_608]);
    const r = await invoke('i-standardpart-exists-in-catalog',
        { id: 's1', type: 'StandardPart', params: { entryId: 'nope' } });
    assert.equal(r.severity, 'error');
});

test('i-standardpart-exists-in-catalog: error when entryId missing', async () => {
    const r = await invoke('i-standardpart-exists-in-catalog',
        { id: 's1', type: 'StandardPart', params: {} });
    assert.equal(r.severity, 'error');
});

// ── 8. clearance-hole-matches-iso273 ────────────────────────────────────────

test('i-clearance-hole-matches-iso273: delegates to DFM', async () => {
    setDfm({ clearanceHole: { ok: true, severity: 'pass', message: 'OK', measured: null } });
    const r = await invoke('i-clearance-hole-matches-iso273',
        { id: 'h1', type: 'Hole', params: { partRef: { role: 'clearance', entryId: 'iso4762-m3-16' } } });
    assert.equal(r.severity, 'pass');
});

test('i-clearance-hole-matches-iso273: not-applicable for non-clearance', async () => {
    const r = await invoke('i-clearance-hole-matches-iso273',
        { id: 'h1', type: 'Hole', params: { partRef: { role: 'tap' } } });
    assert.equal(r.severity, 'pass');
});

// ── 9. bearing-bore-has-partref ─────────────────────────────────────────────

test('i-bearing-bore-has-partref: pass when partRef present', async () => {
    const r = await invoke('i-bearing-bore-has-partref',
        { id: 'c1', type: 'Cylinder', params: { diameter: 22, partRef: { role: 'bore' } } });
    assert.equal(r.severity, 'pass');
});

test('i-bearing-bore-has-partref: warn when missing and matches bearing OD', async () => {
    const r = await invoke('i-bearing-bore-has-partref',
        { id: 'c1', type: 'Cylinder', params: { diameter: 22.05 } },
        { bearingOds: [22, 26] });
    assert.equal(r.severity, 'warning');
});

test('i-bearing-bore-has-partref: pass when missing and no bearing match', async () => {
    const r = await invoke('i-bearing-bore-has-partref',
        { id: 'c1', type: 'Cylinder', params: { diameter: 17 } },
        { bearingOds: [22, 26] });
    assert.equal(r.severity, 'pass');
});

// ── 10. fastener-thread-engagement ──────────────────────────────────────────

test('i-fastener-thread-engagement: delegates to DFM', async () => {
    setDfm({ threadEng: { ok: false, severity: 'error', message: 'too shallow', measured: null } });
    const r = await invoke('i-fastener-thread-engagement',
        { id: 'h1', type: 'Hole', params: { partRef: { role: 'tap', entryId: 'iso4762-m3-16' } } });
    assert.equal(r.severity, 'error');
});

test('i-fastener-thread-engagement: not-applicable for non-tap', async () => {
    const r = await invoke('i-fastener-thread-engagement',
        { id: 'h1', type: 'Hole', params: { partRef: { role: 'clearance' } } });
    assert.equal(r.severity, 'pass');
});

// ── 11. bearing-bore-in-fit-band ────────────────────────────────────────────

test('i-bearing-bore-in-fit-band: delegates to DFM', async () => {
    setDfm({ bearingFit: { ok: true, severity: 'pass', message: 'in band', measured: null } });
    const r = await invoke('i-bearing-bore-in-fit-band',
        { id: 'c1', type: 'Cylinder', params: { partRef: { role: 'bore', entryId: 'bearing-608' } } });
    assert.equal(r.severity, 'pass');
});

// ── 12. fastener bearing surface ────────────────────────────────────────────

test('i-fastener-bearing-surface: pass when reported ≥ required', async () => {
    setCatalog([SHCS_M5_20]);
    // M5 headDia=8.5 → required = 8.5 * 4.25 ≈ 36.1 mm²
    const r = await invoke('i-fastener-bearing-surface',
        { id: 'f1', type: 'StandardPart', params: { entryId: 'iso4762-m5-20', bearingSurfaceArea: 40 } });
    assert.equal(r.severity, 'pass');
});

test('i-fastener-bearing-surface: warn when reported < required', async () => {
    setCatalog([SHCS_M5_20]);
    const r = await invoke('i-fastener-bearing-surface',
        { id: 'f1', type: 'StandardPart', params: { entryId: 'iso4762-m5-20', bearingSurfaceArea: 5 } });
    assert.equal(r.severity, 'warning');
});

test('i-fastener-bearing-surface: not-applicable without reported area', async () => {
    setCatalog([SHCS_M5_20]);
    const r = await invoke('i-fastener-bearing-surface',
        { id: 'f1', type: 'StandardPart', params: { entryId: 'iso4762-m5-20' } });
    assert.equal(r.severity, 'pass');
});

// ── 13. fillet radius ───────────────────────────────────────────────────────

test('i-fillet-radius-positive: pass for r=2', async () => {
    const r = await invoke('i-fillet-radius-positive', { id: 'f1', type: 'Fillet', params: { radius: 2 } });
    assert.equal(r.severity, 'pass');
});
test('i-fillet-radius-positive: error for r=0', async () => {
    const r = await invoke('i-fillet-radius-positive', { id: 'f1', type: 'Fillet', params: { radius: 0 } });
    assert.equal(r.severity, 'error');
});

// ── 14. chamfer ─────────────────────────────────────────────────────────────

test('i-chamfer-length-positive: pass for length=1', async () => {
    const r = await invoke('i-chamfer-length-positive', { id: 'c1', type: 'Chamfer', params: { length: 1 } });
    assert.equal(r.severity, 'pass');
});
test('i-chamfer-length-positive: error for length=-1', async () => {
    const r = await invoke('i-chamfer-length-positive', { id: 'c1', type: 'Chamfer', params: { length: -1 } });
    assert.equal(r.severity, 'error');
});

// ── 15. shell ───────────────────────────────────────────────────────────────

test('i-shell-thickness-positive: pass for t=1.5', async () => {
    const r = await invoke('i-shell-thickness-positive', { id: 's1', type: 'Shell', params: { thickness: 1.5 } });
    assert.equal(r.severity, 'pass');
});
test('i-shell-thickness-positive: error for t=0', async () => {
    const r = await invoke('i-shell-thickness-positive', { id: 's1', type: 'Shell', params: { thickness: 0 } });
    assert.equal(r.severity, 'error');
});

// ── 16. extrude ─────────────────────────────────────────────────────────────

test('i-extrude-amount-positive: pass for amount=10', async () => {
    const r = await invoke('i-extrude-amount-positive', { id: 'e1', type: 'Extrude', params: { amount: 10 } });
    assert.equal(r.severity, 'pass');
});
test('i-extrude-amount-positive: error for amount=0', async () => {
    const r = await invoke('i-extrude-amount-positive', { id: 'e1', type: 'Extrude', params: { amount: 0 } });
    assert.equal(r.severity, 'error');
});
test('i-extrude-amount-positive: pass for both=true amount=-5', async () => {
    const r = await invoke('i-extrude-amount-positive', { id: 'e1', type: 'Extrude', params: { amount: -5, both: true } });
    assert.equal(r.severity, 'pass');
});

// ── 17. component-has-parent ────────────────────────────────────────────────

test('i-component-has-parent: pass for root', async () => {
    const r = await invoke('i-component-has-parent',
        { id: 'root', parentId: null },
        { doc: { components: { root: { id: 'root' } }, rootComponentId: 'root' } });
    assert.equal(r.severity, 'pass');
});
test('i-component-has-parent: error for orphan', async () => {
    const r = await invoke('i-component-has-parent',
        { id: 'orphan' },
        { doc: { components: { orphan: { id: 'orphan' }, root: { id: 'root' } }, rootComponentId: 'root' } });
    assert.equal(r.severity, 'error');
});
test('i-component-has-parent: error for dangling parent', async () => {
    const r = await invoke('i-component-has-parent',
        { id: 'c1', parentId: 'gone' },
        { doc: { components: { c1: { id: 'c1', parentId: 'gone' }, root: { id: 'root' } }, rootComponentId: 'root' } });
    assert.equal(r.severity, 'error');
});

// ── 18. no-cyclic-components ────────────────────────────────────────────────

test('i-no-cyclic-components: pass for tree', async () => {
    const doc = {
        components: { root: { id: 'root' }, a: { id: 'a', parentId: 'root' }, b: { id: 'b', parentId: 'a' } },
    };
    const r = await invoke('i-no-cyclic-components', doc, {});
    assert.equal(r.severity, 'pass');
});
test('i-no-cyclic-components: error when cycle present', async () => {
    const doc = {
        components: { a: { id: 'a', parentId: 'b' }, b: { id: 'b', parentId: 'a' } },
    };
    const r = await invoke('i-no-cyclic-components', doc, {});
    assert.equal(r.severity, 'error');
});

// ── 19. joint-references-valid ──────────────────────────────────────────────

test('i-joint-references-valid: pass when both refs exist', async () => {
    const r = await invoke('i-joint-references-valid',
        { id: 'j1', type: 'Joint', params: { sourceComponentId: 'a', targetComponentId: 'b' } },
        { doc: { components: { a: {}, b: {} } } });
    assert.equal(r.severity, 'pass');
});
test('i-joint-references-valid: error when missing ref', async () => {
    const r = await invoke('i-joint-references-valid',
        { id: 'j1', type: 'Joint', params: { sourceComponentId: 'a', targetComponentId: 'gone' } },
        { doc: { components: { a: {} } } });
    assert.equal(r.severity, 'error');
});
test('i-joint-references-valid: not-applicable for non-joint', async () => {
    const r = await invoke('i-joint-references-valid', { id: 'f1', type: 'Fillet' }, {});
    assert.equal(r.severity, 'pass');
});

// ── 20. no-inter-component-interference ─────────────────────────────────────

test('i-no-inter-component-interference-at-rest: pass when no overlap', async () => {
    const doc = { components: { a: {}, b: {} } };
    const measure = async () => ({ ok: true, intersects: false });
    const r = await invoke('i-no-inter-component-interference-at-rest', doc, { measure });
    assert.equal(r.severity, 'pass');
});
test('i-no-inter-component-interference-at-rest: error on overlap', async () => {
    const doc = { components: { a: {}, b: {} } };
    const measure = async () => ({ ok: true, intersects: true, volume: 1.0 });
    const r = await invoke('i-no-inter-component-interference-at-rest', doc, { measure });
    assert.equal(r.severity, 'error');
});
test('i-no-inter-component-interference-at-rest: not-applicable without measure', async () => {
    const doc = { components: { a: {}, b: {} } };
    const r = await invoke('i-no-inter-component-interference-at-rest', doc, {});
    assert.equal(r.severity, 'pass');
});

// ── 21. no-circular-parameters ──────────────────────────────────────────────

test('i-no-circular-parameters: pass for linear chain', async () => {
    const doc = {
        parameters: {
            a: { expression: '1' },
            b: { expression: 'a + 1' },
            c: { expression: 'b * 2' },
        },
    };
    const r = await invoke('i-no-circular-parameters', doc, {});
    assert.equal(r.severity, 'pass');
});
test('i-no-circular-parameters: error on cycle', async () => {
    const doc = {
        parameters: {
            a: { expression: 'b' },
            b: { expression: 'a' },
        },
    };
    const r = await invoke('i-no-circular-parameters', doc, {});
    assert.equal(r.severity, 'error');
});

// ── 22. parameters-have-units ───────────────────────────────────────────────

test('i-parameters-have-units: pass when unit set', async () => {
    const r = await invoke('i-parameters-have-units',
        { id: 'p1', type: 'Parameter', params: { unit: 'mm' } });
    assert.equal(r.severity, 'pass');
});
test('i-parameters-have-units: warn when unit missing', async () => {
    const r = await invoke('i-parameters-have-units',
        { id: 'p1', type: 'Parameter', params: {} });
    assert.equal(r.severity, 'warning');
});

// ── 23. bearing-pair-fits ───────────────────────────────────────────────────

test('i-bearing-pair-fits: pass when classes match', async () => {
    const doc = {
        features: {
            s1: { id: 's1', type: 'Cylinder', params: { partRef: { role: 'shaft', entryId: 'bearing-608', fitClass: 'H7/g6' } } },
            b1: { id: 'b1', type: 'Cylinder', params: { partRef: { role: 'bore', entryId: 'bearing-608', fitClass: 'H7/g6' } } },
        },
    };
    const r = await invoke('i-bearing-pair-fits', doc, {});
    assert.equal(r.severity, 'pass');
});
test('i-bearing-pair-fits: warn when classes mismatch', async () => {
    const doc = {
        features: {
            s1: { id: 's1', type: 'Cylinder', params: { partRef: { role: 'shaft', entryId: 'bearing-608', fitClass: 'H7/k6' } } },
            b1: { id: 'b1', type: 'Cylinder', params: { partRef: { role: 'bore', entryId: 'bearing-608', fitClass: 'H7/g6' } } },
        },
    };
    const r = await invoke('i-bearing-pair-fits', doc, {});
    assert.equal(r.severity, 'warning');
});

// ── 24. clearance-hole-for-fastener ─────────────────────────────────────────

test('i-clearance-hole-for-fastener: pass when matching fastener present', async () => {
    setCatalog([SHCS_M3_16]);
    const doc = {
        features: {
            h1: { id: 'h1', type: 'Hole', params: { partRef: { role: 'clearance', entryId: 'iso4762-m3-16' } } },
            f1: { id: 'f1', type: 'StandardPart', params: { entryId: 'iso4762-m3-16' } },
        },
    };
    const target = doc.features.h1;
    const r = await invoke('i-clearance-hole-for-fastener', target, { doc });
    assert.equal(r.severity, 'pass');
});
test('i-clearance-hole-for-fastener: warn when no fastener in doc', async () => {
    setCatalog([SHCS_M3_16]);
    const doc = {
        features: {
            h1: { id: 'h1', type: 'Hole', params: { partRef: { role: 'clearance', entryId: 'iso4762-m3-16' } } },
        },
    };
    const r = await invoke('i-clearance-hole-for-fastener', doc.features.h1, { doc });
    assert.equal(r.severity, 'warning');
});

// ── 25. standardpart-not-deprecated ─────────────────────────────────────────

test('i-standardpart-not-deprecated: pass for active entry', async () => {
    setCatalog([SHCS_M3_16]);
    const r = await invoke('i-standardpart-not-deprecated',
        { id: 'f1', type: 'StandardPart', params: { entryId: 'iso4762-m3-16' } });
    assert.equal(r.severity, 'pass');
});
test('i-standardpart-not-deprecated: warn for deprecated entry', async () => {
    setCatalog([{ ...SHCS_M3_16, deprecated: true, deprecationReason: 'use M4 instead' }]);
    const r = await invoke('i-standardpart-not-deprecated',
        { id: 'f1', type: 'StandardPart', params: { entryId: 'iso4762-m3-16' } });
    assert.equal(r.severity, 'warning');
});

// ── 27b. i-assembly-dof-sane (Phase 6) ───────────────────────────────────────

test('i-assembly-dof-sane: notApplicable with no joints', async () => {
    const r = await invoke('i-assembly-dof-sane', { components: { root: {} }, joints: {} });
    assert.equal(r.severity, 'pass');
    assert.match(r.message, /no joints/);
});
test('i-assembly-dof-sane: pass for a well-formed 2-DOF chain', async () => {
    const doc = {
        components: { root: { id: 'root' }, base: { id: 'base' }, tip: { id: 'tip' } },
        joints: {
            j1: { id: 'j1', kind: 'revolute', parent: 'root', child: 'base' },
            j2: { id: 'j2', kind: 'revolute', parent: 'base', child: 'tip' },
        },
    };
    const r = await invoke('i-assembly-dof-sane', doc);
    assert.equal(r.severity, 'pass');
    assert.equal(r.measured.totalDof, 2);
});
test('i-assembly-dof-sane: warn when a component is over-constrained', async () => {
    const doc = {
        components: { root: { id: 'root' }, a: { id: 'a' }, loop: { id: 'loop' } },
        joints: {
            j1: { id: 'j1', kind: 'revolute', parent: 'root', child: 'loop' },
            j2: { id: 'j2', kind: 'revolute', parent: 'a', child: 'loop' },
        },
    };
    const r = await invoke('i-assembly-dof-sane', doc);
    assert.equal(r.severity, 'warning');
    assert.ok(r.measured.overConstrained.includes('loop'));
});

// ── go ──────────────────────────────────────────────────────────────────────

run();
