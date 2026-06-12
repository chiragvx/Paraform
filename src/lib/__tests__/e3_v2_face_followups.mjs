/**
 * E3 v2 follow-ups — Press-Pull gizmo + Move-Face tangent + Delete-Face heal.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/__tests__/e3_v2_face_followups.mjs
 *
 * Covers:
 *   1. Press-Pull drag-handle math (offsetFromDrag + PressPullGizmo lifecycle)
 *   2. addMoveFace tangent param shape + emit produces tangent= kwarg
 *   3. delete_face heal path — pure-JS error surface (kernel test is Python-side)
 */
import assert from 'node:assert/strict';
import {
    getDocumentStore, resetDocumentStore,
    addBox,
    addMoveFace,
    emitDocument,
} from '../../../lib/document/index.js';
import {
    PressPullGizmo,
    buildMoveFaceFrame,
    moveFaceParamsFromDrag,
    dragPlaneNormal,
    intersectRayPlane,
    offsetFromDrag,
} from '../viewport/press_pull_gizmo.js';

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

function freshDoc() {
    resetDocumentStore();
    return getDocumentStore();
}

const APPROX = 1e-9;
function near(a, b, eps = 1e-6) {
    return Math.abs(a - b) <= eps;
}

console.log('── E3 v2 (Press-Pull gizmo + Move-Face tangent + Delete-Face heal) ──');

// ── 1. intersectRayPlane basic correctness ──────────────────────────────────
t('intersectRayPlane hits a horizontal plane from above', () => {
    const hit = intersectRayPlane([0, 0, 10], [0, 0, -1], [0, 0, 0], [0, 0, 1]);
    assert.ok(hit);
    assert.ok(near(hit[0], 0) && near(hit[1], 0) && near(hit[2], 0));
});

t('intersectRayPlane returns null for ray parallel to plane', () => {
    const hit = intersectRayPlane([0, 0, 5], [1, 0, 0], [0, 0, 0], [0, 0, 1]);
    assert.equal(hit, null);
});

// ── 2. dragPlaneNormal picks the right plane ────────────────────────────────
t('dragPlaneNormal: +Z face + camera looking down-X picks a side plane', () => {
    // face normal +Z, camera looking along +X (camera dir = [1,0,0])
    // best plane: contains [0,0,1] and side = [0,1,0] → plane normal = +X (or -X)
    const n = dragPlaneNormal([0, 0, 1], [1, 0, 0]);
    assert.ok(near(Math.abs(n[0]), 1), `expected ±X plane normal, got ${n}`);
    assert.ok(near(n[1], 0) && near(n[2], 0));
});

t('dragPlaneNormal: camera parallel to face normal falls back via worldUp', () => {
    // face normal +Z, camera also along +Z → degenerate; fallback uses worldUp.
    // Our fallback walks worldUp then world +X. Result must be a unit vector.
    const n = dragPlaneNormal([0, 0, 1], [0, 0, 1]);
    const len = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
    assert.ok(near(len, 1, 1e-6) || near(len, 0, 1e-6),
        `degenerate-case plane normal should be unit or zero, got len=${len}`);
});

// ── 3. PressPullGizmo lifecycle ─────────────────────────────────────────────
t('PressPullGizmo: drag along ray that moves with normal returns positive offset', () => {
    // Face at origin, normal +Z (top of a box). Camera looks down -Z but we
    // orbit slightly so the drag plane is X-Z (normal = +Y).
    const giz = new PressPullGizmo({ faceCentroid: [0, 0, 0], faceNormal: [0, 0, 1] });
    // Camera looking down +X (dir = [1,0,0]) so drag plane = XZ plane (normal +Y).
    const ok = giz.beginDrag({
        rayOrigin: [10, 0, 0],   // sitting on +X side
        rayDir: [-1, 0, 0],      // looking at origin
        cameraDir: [-1, 0, 0],
    });
    assert.equal(ok, true);
    assert.equal(giz.isDragging, true);
    // Move the ray upwards by aiming at [0,0,5] instead of origin.
    const d1 = giz.updateDrag({
        rayOrigin: [10, 0, 5],
        rayDir: [-1, 0, 0],
    });
    assert.ok(near(d1, 5, 1e-6), `expected offset 5, got ${d1}`);
    const final = giz.endDrag();
    assert.ok(near(final, 5, 1e-6));
    assert.equal(giz.isDragging, false);
});

t('PressPullGizmo: snap rounds the live offset', () => {
    const giz = new PressPullGizmo({ faceCentroid: [0, 0, 0], faceNormal: [0, 0, 1], snap: 1 });
    giz.beginDrag({
        rayOrigin: [10, 0, 0], rayDir: [-1, 0, 0], cameraDir: [-1, 0, 0],
    });
    const d = giz.updateDrag({ rayOrigin: [10, 0, 2.7], rayDir: [-1, 0, 0] });
    assert.equal(d, 3, `snap=1 should round 2.7 → 3, got ${d}`);
});

t('PressPullGizmo: cancelDrag wipes state without committing', () => {
    const giz = new PressPullGizmo({ faceCentroid: [0, 0, 0], faceNormal: [0, 0, 1] });
    giz.beginDrag({ rayOrigin: [10, 0, 0], rayDir: [-1, 0, 0], cameraDir: [-1, 0, 0] });
    giz.updateDrag({ rayOrigin: [10, 0, 3], rayDir: [-1, 0, 0] });
    giz.cancelDrag();
    assert.equal(giz.isDragging, false);
    assert.equal(giz.currentOffset, 0);
});

t('PressPullGizmo: arrowTip sits on faceCentroid + normal * offset', () => {
    const giz = new PressPullGizmo({ faceCentroid: [1, 2, 3], faceNormal: [0, 0, 1] });
    giz.beginDrag({ rayOrigin: [10, 2, 3], rayDir: [-1, 0, 0], cameraDir: [-1, 0, 0] });
    giz.updateDrag({ rayOrigin: [10, 2, 7], rayDir: [-1, 0, 0] });
    const tip = giz.arrowTip;
    assert.ok(near(tip[0], 1) && near(tip[1], 2) && near(tip[2], 7),
        `tip should be [1,2,7], got ${tip}`);
});

t('PressPullGizmo: throws on bad faceCentroid / faceNormal', () => {
    assert.throws(() => new PressPullGizmo({ faceCentroid: null, faceNormal: [0, 0, 1] }), /faceCentroid/);
    assert.throws(() => new PressPullGizmo({ faceCentroid: [0, 0, 0], faceNormal: 'nope' }), /faceNormal/);
});

// ── 4. Move-Face frame + params ─────────────────────────────────────────────
t('buildMoveFaceFrame: +Z face yields {n:+Z, tU:+something_horizontal, tV: orthogonal}', () => {
    const f = buildMoveFaceFrame([0, 0, 1]);
    assert.ok(near(f.normal[2], 1));
    // n·tU ≈ 0
    assert.ok(near(f.normal[0] * f.tangentU[0] + f.normal[1] * f.tangentU[1] + f.normal[2] * f.tangentU[2], 0));
    // n·tV ≈ 0
    assert.ok(near(f.normal[0] * f.tangentV[0] + f.normal[1] * f.tangentV[1] + f.normal[2] * f.tangentV[2], 0));
    // tU·tV ≈ 0
    assert.ok(near(f.tangentU[0] * f.tangentV[0] + f.tangentU[1] * f.tangentV[1] + f.tangentU[2] * f.tangentV[2], 0));
});

t('buildMoveFaceFrame: face normal parallel to worldUp falls back without NaN', () => {
    // normal = worldUp would make the up-projected tangent zero → fallback path.
    const f = buildMoveFaceFrame([0, 0, 1], [0, 0, 1]);
    for (const v of [f.normal, f.tangentU, f.tangentV]) {
        for (const x of v) assert.ok(Number.isFinite(x));
        const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        assert.ok(near(len, 1, 1e-6), `expected unit vector, got len=${len}`);
    }
});

t('moveFaceParamsFromDrag(normal): returns vector = normal * d, no tangent', () => {
    const frame = buildMoveFaceFrame([0, 0, 1]);
    const params = moveFaceParamsFromDrag({ axis: 'normal', distance: 5, frame });
    assert.ok(Array.isArray(params.vector));
    assert.equal(params.vector.length, 3);
    assert.ok(near(params.vector[2], 5, 1e-6));
    assert.equal(params.tangent, undefined);
});

t('moveFaceParamsFromDrag(tangentU): returns tangent vector, vector = zero', () => {
    const frame = buildMoveFaceFrame([0, 0, 1]);
    const params = moveFaceParamsFromDrag({ axis: 'tangentU', distance: 2.5, frame });
    assert.deepEqual(params.vector, [0, 0, 0]);
    assert.ok(Array.isArray(params.tangent));
    const tlen = Math.sqrt(
        params.tangent[0] * params.tangent[0]
        + params.tangent[1] * params.tangent[1]
        + params.tangent[2] * params.tangent[2]
    );
    assert.ok(near(tlen, 2.5, 1e-6), `expected tangent length 2.5, got ${tlen}`);
});

t('moveFaceParamsFromDrag: throws on bad axis / distance', () => {
    const frame = buildMoveFaceFrame([0, 0, 1]);
    assert.throws(() => moveFaceParamsFromDrag({ axis: 'sideways', distance: 1, frame }), /unknown axis/);
    assert.throws(() => moveFaceParamsFromDrag({ axis: 'normal', distance: NaN, frame }), /numeric distance/);
});

// ── 5. addMoveFace tangent param shape ──────────────────────────────────────
t('addMoveFace accepts tangent in opts and stores it; warning chip is suppressed', () => {
    freshDoc();
    const box = addBox({ length: 10, width: 10, height: 10 });
    const face = { kind: 'face', feature: box.id };
    const feat = addMoveFace(face, [0, 0, 0], { tangent: [1, 0, 0] });
    assert.equal(feat.type, 'MoveFace');
    assert.deepEqual(feat.params.tangent, [1, 0, 0]);
    // With a tangent now supported, no warning chip about tangent-not-supported.
    const warns = (feat.warnings || []).join('|');
    assert.ok(!/tangent slide is not yet supported/i.test(warns),
        'tangent-supplied MoveFace should not carry the tangent-not-supported warning');
});

t('addMoveFace stamps warning when no tangent supplied (legacy behaviour)', () => {
    freshDoc();
    const box = addBox({});
    const face = { kind: 'face', feature: box.id };
    const feat = addMoveFace(face, [0, 0, 1]);
    assert.ok(Array.isArray(feat.warnings) && feat.warnings.length > 0);
});

t('addMoveFace rejects non-numeric tangent', () => {
    freshDoc();
    const box = addBox({});
    const face = { kind: 'face', feature: box.id };
    assert.throws(() => addMoveFace(face, [0, 0, 0], { tangent: [1, 2] }), /tangent/);
    assert.throws(() => addMoveFace(face, [0, 0, 0], { tangent: 'x' }), /tangent/);
});

// ── 6. Emit path: tangent= kwarg ────────────────────────────────────────────
t('emit produces move_face(..., tangent=[tx,ty,tz]) when tangent is set', () => {
    freshDoc();
    const box = addBox({});
    const face = { kind: 'face', feature: box.id };
    const mf = addMoveFace(face, [0, 0, 0], { tangent: [1.5, 0, 0] });
    const { code } = emitDocument(getDocumentStore().doc);
    assert.ok(new RegExp(`n_${mf.id}\\s*=\\s*move_face\\(n_${box.id},`).test(code),
        'expected move_face(n_<box>, …)');
    assert.ok(/tangent=\[1\.5,\s*0,\s*0\]/.test(code),
        `expected tangent=[1.5, 0, 0] kwarg in emit, got code:\n${code}`);
});

t('emit omits tangent= kwarg when no tangent set (back-compat)', () => {
    freshDoc();
    const box = addBox({});
    const face = { kind: 'face', feature: box.id };
    addMoveFace(face, [0, 0, 1]);
    const { code } = emitDocument(getDocumentStore().doc);
    assert.ok(!/tangent=/.test(code), 'unset tangent should not leak into emit');
});

// ── 7. Delete-Face heal path — JS-side error surface ────────────────────────
// The kernel runs in Python; we verify here that the JS feature shape is
// stable + the doc state survives delete-face additions across emits. The
// kernel's sewing heal is exercised by the Python harness tests.
t('delete-face feature carries a warning when JS-side, and survives emit', () => {
    freshDoc();
    const box = addBox({});
    const face = { kind: 'face', feature: box.id };
    // Reuse the existing op surface (unchanged in v2 on the JS side; kernel
    // adds the sewing heal). The JS warning continues to flag best-effort.
    // We import addDeleteFace through the same barrel.
    const { addDeleteFace } = (function load() {
        // Late lookup to keep the import map flat for tooling.
        return { addDeleteFace: arguments.length ? null : null };
    }());
    // The function actually lives in operations.js; pull it.
    return import('../../../lib/document/index.js').then(mod => {
        const feat = mod.addDeleteFace(face);
        assert.equal(feat.type, 'DeleteFace');
        assert.ok((feat.warnings || []).length > 0, 'DeleteFace stamps a warning chip');
        const { code, leafIds } = emitDocument(getDocumentStore().doc);
        assert.ok(/delete_face/.test(code), 'emit must produce a delete_face call');
        assert.ok(leafIds.includes(feat.id));
        assert.ok(!leafIds.includes(box.id));
    });
});

// ── Done ────────────────────────────────────────────────────────────────────
await new Promise(r => setTimeout(r, 50));
console.log(`\n${_pass} passed, ${_fail} failed`);
process.exit(_fail === 0 ? 0 : 1);
