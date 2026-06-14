/**
 * vectorize.mjs — node test for the pure-JS raster → vector tracer.
 *
 * Run with bare node (NOT via $lib loader):
 *   node src/lib/sketch/__tests__/vectorize.mjs
 *
 * No test framework: a tiny t(name, fn) runner, node:assert/strict, and a final
 * "N passed, M failed" line. exit(1) on any failure.
 *
 * All bitmaps are synthesised in code as RGBA Uint8ClampedArray (the
 * ImageData.data shape) so the tests are hermetic — no fixtures, no canvas.
 */
import assert from 'node:assert/strict';
import { vectorizeImage, profilesToSketchEntities } from '../vectorize.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); fail++; }
}

// ── bitmap helpers ──────────────────────────────────────────────────────────

/** Allocate an all-white opaque RGBA image. */
function whiteImage(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    data[p] = 255; data[p + 1] = 255; data[p + 2] = 255; data[p + 3] = 255;
  }
  return { data, width: w, height: h };
}

/** Paint a solid dark (black) axis-aligned rectangle [x0,x1) × [y0,y1). */
function fillRect(img, x0, y0, x1, y1) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const p = (y * img.width + x) * 4;
      img.data[p] = 0; img.data[p + 1] = 0; img.data[p + 2] = 0; img.data[p + 3] = 255;
    }
  }
}

/** Paint a solid dark filled disk centred at (cx, cy) with radius r. */
function fillDisk(img, cx, cy, r) {
  const r2 = r * r;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2) {
        const p = (y * img.width + x) * 4;
        img.data[p] = 0; img.data[p + 1] = 0; img.data[p + 2] = 0; img.data[p + 3] = 255;
      }
    }
  }
}

/** Profile mm bounding box. */
function bounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

console.log('── vectorizeImage ──');

// 1. Solid filled rectangle → 1 profile, closed, 4–8 pts, aspect ≈ 60:40.
t('filled rectangle → single rectangular profile', () => {
  const img = whiteImage(200, 200);
  // 60 wide × 40 tall, centred at (100,100): x 70..130, y 80..120.
  fillRect(img, 70, 80, 130, 120);
  const res = vectorizeImage({ ...img, targetSizeMm: 100, simplifyTolerance: 1.5 });

  assert.equal(res.ok, true, 'ok');
  assert.equal(res.profiles.length, 1, 'exactly one profile');
  const prof = res.profiles[0];
  assert.equal(prof.closed, true, 'closed');
  assert.ok(prof.points.length >= 4 && prof.points.length <= 8,
    `4..8 points after simplify, got ${prof.points.length}`);

  const b = bounds(prof.points);
  // aspect ratio of mm bounds ≈ 60/40 = 1.5 (±15%)
  const aspect = b.w / b.h;
  assert.ok(Math.abs(aspect - 1.5) <= 1.5 * 0.15,
    `aspect ≈ 1.5 (±15%), got ${aspect.toFixed(3)}`);

  // longest side ≈ targetSizeMm (100)
  const longest = Math.max(b.w, b.h);
  assert.ok(Math.abs(longest - 100) <= 100 * 0.05,
    `longest side ≈ 100mm, got ${longest.toFixed(2)}`);
});

// 2. Filled disk → 1 profile, closed, many points, roughly square bounds.
t('filled disk → many-point near-square profile', () => {
  const img = whiteImage(200, 200);
  fillDisk(img, 100, 100, 50);
  const res = vectorizeImage({ ...img, targetSizeMm: 100, simplifyTolerance: 1.0 });

  assert.equal(res.ok, true, 'ok');
  assert.equal(res.profiles.length, 1, 'one profile');
  const prof = res.profiles[0];
  assert.equal(prof.closed, true, 'closed');
  assert.ok(prof.points.length > 8, `many points, got ${prof.points.length}`);

  const b = bounds(prof.points);
  const aspect = b.w / b.h;
  assert.ok(Math.abs(aspect - 1) <= 0.15, `roughly square, aspect ${aspect.toFixed(3)}`);
});

// 3. Two separate blocks → 2 profiles.
t('two separate blocks → two profiles', () => {
  const img = whiteImage(200, 200);
  fillRect(img, 20, 80, 70, 120);    // left block
  fillRect(img, 130, 80, 180, 120);  // right block (clear gap between)
  const res = vectorizeImage({ ...img });

  assert.equal(res.ok, true, 'ok');
  assert.equal(res.profiles.length, 2, `two profiles, got ${res.profiles.length}`);
  for (const p of res.profiles) assert.equal(p.closed, true, 'each closed');
});

// 4. Blank image → ok:true, 0 profiles, a warning.
t('blank white image → ok, 0 profiles, warning', () => {
  const img = whiteImage(64, 64);
  const res = vectorizeImage({ ...img });
  assert.equal(res.ok, true, 'ok true on blank');
  assert.equal(res.profiles.length, 0, 'no profiles');
  assert.ok(res.warnings.length >= 1, 'has a warning');
  assert.ok(res.warnings.some((w) => /no foreground/i.test(w)), 'no-foreground warning');
});

// 5. Garbage input (data:null) → ok:false, no throw.
t('null data → ok:false, no throw', () => {
  let res;
  assert.doesNotThrow(() => {
    res = vectorizeImage({ data: null, width: 10, height: 10 });
  });
  assert.equal(res.ok, false, 'ok false');
  assert.equal(res.profiles.length, 0, 'no profiles');
  assert.ok(res.error, 'has an error string');
});

// 5b. Mismatched length data → ok:false, no throw (defensive).
t('mismatched data length → ok:false, no throw', () => {
  let res;
  assert.doesNotThrow(() => {
    res = vectorizeImage({ data: new Uint8ClampedArray(7), width: 10, height: 10 });
  });
  assert.equal(res.ok, false, 'ok false');
  assert.ok(res.error, 'has an error string');
});

// 6. Y is flipped correctly: a shape in the TOP half (small image-y) maps to
//    POSITIVE sketch-y. Use an asymmetric shape (small block in the top-left).
t('Y flip: top-half shape → positive sketch-y', () => {
  const img = whiteImage(200, 200);
  // A block hugging the TOP of the image (small image-y), off to one side so
  // the shape is unambiguously asymmetric about both axes.
  fillRect(img, 40, 20, 90, 50); // image-y 20..50 = top region
  const res = vectorizeImage({ ...img, targetSizeMm: 100 });

  assert.equal(res.ok, true, 'ok');
  assert.equal(res.profiles.length, 1, 'one profile');
  const b = bounds(res.profiles[0].points);
  // The shape is the ONLY content, so overall-bounds centering puts its own
  // center at the origin — but the asymmetry test is about ORIENTATION, so we
  // additionally verify against a two-shape arrangement below.
  // Here: since it's the sole shape, its center is ~origin; instead assert the
  // top edge maps higher than bottom (always true) AND verify flip via a
  // companion test using two stacked shapes.
  assert.ok(b.maxY > b.minY, 'has vertical extent');
});

// 6b. Y flip with TWO stacked shapes: the one higher in the image (smaller
//     image-y) must end up with the LARGER sketch-y. This is the real flip
//     assertion — overall-bounds centering keeps both, and the top one must win
//     in +y.
t('Y flip: image-top shape outranks image-bottom in sketch +y', () => {
  const img = whiteImage(200, 200);
  fillRect(img, 80, 20, 120, 50);    // TOP shape   (image-y ~35 center)
  fillRect(img, 80, 150, 120, 180);  // BOTTOM shape (image-y ~165 center)
  const res = vectorizeImage({ ...img, targetSizeMm: 100 });

  assert.equal(res.ok, true, 'ok');
  assert.equal(res.profiles.length, 2, 'two profiles');

  // Centroid (mean y) of each profile.
  const cy = (pts) => pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const ys = res.profiles.map((p) => cy(p.points)).sort((a, b) => a - b);
  // Two distinct centroids, symmetric-ish about 0.
  const [lo, hi] = ys;
  assert.ok(hi > 0, `image-top shape lands at positive sketch-y, got ${hi.toFixed(2)}`);
  assert.ok(lo < 0, `image-bottom shape lands at negative sketch-y, got ${lo.toFixed(2)}`);
});

// 7. profilesToSketchEntities adapter shape.
t('profilesToSketchEntities → polyline entities', () => {
  const img = whiteImage(200, 200);
  fillRect(img, 70, 80, 130, 120);
  const res = vectorizeImage({ ...img });
  const ents = profilesToSketchEntities(res.profiles);
  assert.equal(ents.length, res.profiles.length, 'one entity per profile');
  for (const e of ents) {
    assert.equal(e.kind, 'polyline', 'kind polyline');
    assert.equal(e.closed, true, 'closed');
    assert.ok(Array.isArray(e.points) && e.points.length >= 3, 'has points');
  }
  // Defensive: bad input → []
  assert.deepEqual(profilesToSketchEntities(null), [], 'null → []');
  assert.deepEqual(profilesToSketchEntities(undefined), [], 'undefined → []');
});

// 8. invert flag: light shape on dark background.
t('invert: light shape on dark bg → 1 profile', () => {
  const w = 200, h = 200;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { const p = i * 4; data[p] = data[p + 1] = data[p + 2] = 0; data[p + 3] = 255; }
  // paint a WHITE rect
  for (let y = 80; y < 120; y++) for (let x = 70; x < 130; x++) {
    const p = (y * w + x) * 4; data[p] = data[p + 1] = data[p + 2] = 255;
  }
  const res = vectorizeImage({ data, width: w, height: h, invert: true });
  assert.equal(res.ok, true, 'ok');
  assert.equal(res.profiles.length, 1, 'one profile with invert');
});

// 9. grayscale single-channel input accepted (length === w*h).
t('grayscale (w*h) input accepted', () => {
  const w = 100, h = 100;
  const gray = new Uint8ClampedArray(w * h).fill(255);
  for (let y = 30; y < 70; y++) for (let x = 30; x < 70; x++) gray[y * w + x] = 0;
  const res = vectorizeImage({ data: gray, width: w, height: h });
  assert.equal(res.ok, true, 'ok');
  assert.equal(res.profiles.length, 1, 'one profile from grayscale');
});

// 10. speck cull: a 1px dot beside a real block → only the block survives.
t('speck cull: tiny dot dropped, real block kept', () => {
  const img = whiteImage(200, 200);
  fillRect(img, 70, 80, 130, 120); // real block
  fillRect(img, 5, 5, 6, 6);       // 1px speck
  const res = vectorizeImage({ ...img });
  assert.equal(res.ok, true, 'ok');
  assert.equal(res.profiles.length, 1, 'speck culled, one profile');
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
