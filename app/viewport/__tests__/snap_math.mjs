/**
 * Pure snap-math tests.
 *   node app/viewport/__tests__/snap_math.mjs
 */
import assert from 'node:assert/strict';
import { clamp, closestParamOnLine, pointSegmentDist2D, normalize3, snapGroundPosition } from '../snap_math.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
    try { fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

console.log('── snap_math ──');

t('clamp bounds', () => {
    assert.equal(clamp(5, 0, 10), 5);
    assert.equal(clamp(-3, 0, 10), 0);
    assert.equal(clamp(99, 0, 10), 10);
});

t('closestParamOnLine: ray down -Z meets X axis at t=0', () => {
    const t0 = closestParamOnLine([0, 0, 10], [0, 0, -1], [0, 0, 0], [1, 0, 0]);
    assert.ok(approx(t0, 0), `t=${t0}`);
});

t('closestParamOnLine: ray offset +X gives that offset as t', () => {
    const t0 = closestParamOnLine([7, 0, 10], [0, 0, -1], [0, 0, 0], [1, 0, 0]);
    assert.ok(approx(t0, 7), `t=${t0}`);
});

t('closestParamOnLine: parallel ray → null (singular)', () => {
    assert.equal(closestParamOnLine([0, 0, 10], [0, 0, -1], [0, 0, 0], [0, 0, 1]), null);
});

t('pointSegmentDist2D: perpendicular distance', () => {
    assert.ok(approx(pointSegmentDist2D(5, 5, 0, 0, 10, 0), 5));
});

t('pointSegmentDist2D: clamps past the A end', () => {
    assert.ok(approx(pointSegmentDist2D(-5, 0, 0, 0, 10, 0), 5));
});

t('pointSegmentDist2D: clamps past the B end', () => {
    assert.ok(approx(pointSegmentDist2D(15, 0, 0, 0, 10, 0), 5));
});

t('normalize3 unit', () => {
    const n = normalize3([0, 0, 5]);
    assert.deepEqual(n, [0, 0, 1]);
});

t('snapGroundPosition: origin lock when dropped near center', () => {
    assert.deepEqual(snapGroundPosition([3, -2, 0]), [0, 0, 0]);
    // outside the origin radius → unchanged (no ctrl)
    assert.deepEqual(snapGroundPosition([40, 12, 0]), [40, 12, 0]);
});

t('snapGroundPosition: Ctrl snaps X/Y to the 10mm grid, keeps z', () => {
    assert.deepEqual(snapGroundPosition([42, -7, 5], { ctrl: true }), [40, -10, 5]);
    assert.deepEqual(snapGroundPosition([44, 6, 0], { ctrl: true, gridMm: 20 }), [40, 0, 0]);
});

console.log(`\n  ${_pass} passed, ${_fail} failed`);
if (_fail > 0) process.exit(1);
