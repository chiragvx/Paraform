/**
 * vectorize.js — pure-JS raster → vector tracer (no DOM, no canvas, no imports).
 *
 * Turns an uploaded raster image (hand sketch, logo, silhouette) into a set of
 * 2D PROFILES the CAD kernel can extrude. The kernel consumes profiles as
 * CLOSED polylines of [x, y] points in MILLIMETRES, Z-up sketch space (so image
 * Y — which grows DOWN — is flipped to sketch Y, which grows UP).
 *
 * Runs identically in the browser and in Node: it takes raw pixel data as input
 * (the shape of `ImageData.data`, an RGBA byte array) rather than touching any
 * canvas or DOM API.
 *
 * Pipeline:
 *   (1) luminance      — RGBA (or grayscale) → per-pixel brightness 0..255
 *   (2) threshold      — brightness → binary foreground mask (dark = ink)
 *   (3) contour trace  — Moore-neighbor boundary tracing → closed pixel loops
 *   (4) simplify       — Ramer–Douglas–Peucker (RDP) to drop redundant points
 *   (5) speck cull     — drop loops whose area < ~0.2% of the image
 *   (6) keep top-N     — keep the largest `maxProfiles` loops by area
 *   (7) px → mm        — center the OVERALL bounds at origin, FLIP Y, scale so
 *                        the longest overall bound == targetSizeMm
 *   (8) point cap      — keep each profile under `maxPointsPerProfile`
 *
 * Everything here is a pure function — no globals, no shared mutable state.
 */

// ───────────────────────────────────────────────────────────────────────────
// (1) Grayscale / luminance
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build a Float-ish luminance buffer (one value 0..255 per pixel) from either
 * an RGBA byte array (length === w*h*4, the ImageData.data shape) or an
 * already-grayscale array (length === w*h). We detect which by length.
 *
 * Rec. 601 luma weights (0.299 R + 0.587 G + 0.114 B) — the classic perceptual
 * brightness. Fully-transparent pixels (alpha 0) are treated as WHITE
 * background, so a PNG logo with a transparent canvas thresholds as expected
 * rather than reading its undefined RGB.
 */
function toLuminance(data, width, height) {
  const n = width * height;
  const lum = new Float32Array(n);

  if (data.length === n) {
    // Already one channel per pixel — copy through, clamping into 0..255.
    for (let i = 0; i < n; i++) {
      const v = data[i];
      lum[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    return lum;
  }

  if (data.length === n * 4) {
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const a = data[p + 3];
      if (a === 0) {
        // Transparent → background (white). Avoids tracing the bounding box of
        // a transparent canvas.
        lum[i] = 255;
        continue;
      }
      const r = data[p], g = data[p + 1], b = data[p + 2];
      lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
    return lum;
  }

  throw new Error(
    `data length ${data.length} matches neither grayscale (${n}) nor RGBA (${n * 4}) for ${width}x${height}`
  );
}

// ───────────────────────────────────────────────────────────────────────────
// (2) Threshold → binary mask
// ───────────────────────────────────────────────────────────────────────────

/**
 * Threshold the luminance into a Uint8Array mask where 1 === foreground (ink).
 *
 * By default foreground is the DARKER pixels (a pencil sketch on white paper):
 * a pixel is foreground when its luminance < threshold. `invert` flips that for
 * light-on-dark images (white chalk on a blackboard).
 */
function thresholdMask(lum, width, height, threshold, invert) {
  const n = width * height;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const dark = lum[i] < threshold;
    mask[i] = (invert ? !dark : dark) ? 1 : 0;
  }
  return mask;
}

// Mask sampling that treats out-of-bounds as background (0). Centralised so the
// contour tracer never indexes outside the array.
function at(mask, width, height, x, y) {
  if (x < 0 || y < 0 || x >= width || y >= height) return 0;
  return mask[y * width + x];
}

// ───────────────────────────────────────────────────────────────────────────
// (3) Connected-component labelling + Moore-neighbor boundary tracing
// ───────────────────────────────────────────────────────────────────────────

/**
 * Label 4-connected foreground regions with a flood fill (iterative stack, so a
 * large blob can't blow the call stack). Returns an Int32Array of labels
 * (0 === background, 1..k === components) and the component count.
 *
 * We label first so we can trace ONE outer contour per region and ignore the
 * region's interior — two ink blobs that touch only diagonally stay separate
 * (4-connectivity), which matches how a human reads two distinct shapes.
 */
function labelComponents(mask, width, height) {
  const labels = new Int32Array(width * height); // 0 = unlabelled/background
  let next = 0;
  const stack = []; // flat [x,y,x,y,...] to avoid per-pixel object allocation

  for (let sy = 0; sy < height; sy++) {
    for (let sx = 0; sx < width; sx++) {
      const si = sy * width + sx;
      if (mask[si] === 0 || labels[si] !== 0) continue;

      next += 1;
      stack.length = 0;
      stack.push(sx, sy);
      labels[si] = next;

      while (stack.length) {
        const y = stack.pop();
        const x = stack.pop();
        // 4-neighbourhood
        if (x + 1 < width) {
          const i = y * width + (x + 1);
          if (mask[i] === 1 && labels[i] === 0) { labels[i] = next; stack.push(x + 1, y); }
        }
        if (x - 1 >= 0) {
          const i = y * width + (x - 1);
          if (mask[i] === 1 && labels[i] === 0) { labels[i] = next; stack.push(x - 1, y); }
        }
        if (y + 1 < height) {
          const i = (y + 1) * width + x;
          if (mask[i] === 1 && labels[i] === 0) { labels[i] = next; stack.push(x, y + 1); }
        }
        if (y - 1 >= 0) {
          const i = (y - 1) * width + x;
          if (mask[i] === 1 && labels[i] === 0) { labels[i] = next; stack.push(x, y - 1); }
        }
      }
    }
  }
  return { labels, count: next };
}

/**
 * Moore-neighbor boundary tracing (a.k.a. Moore tracing with Jacob's stopping
 * criterion) of the OUTER contour of one labelled component.
 *
 * Idea: find the top-left-most foreground pixel of the component (guaranteed to
 * be on the outer boundary), then walk the boundary clockwise. At each boundary
 * pixel we sweep its 8-neighbours starting just "behind" the direction we came
 * from, and step onto the first foreground neighbour. We stop when we return to
 * the start pixel having re-entered from the same backtrack direction (Jacob's
 * criterion) — this reliably terminates even on 1-pixel-wide spurs.
 *
 * The returned loop is a list of integer pixel coordinates [x, y] in CLOCKWISE
 * order. It is NOT closed (first point is not repeated); callers treat it as a
 * closed ring.
 *
 * `componentMask` here is "this pixel belongs to the component we're tracing"
 * — we pass labels + the target label so interior holes of OTHER components
 * never leak in.
 */
function traceOuterContour(labels, width, height, label, start) {
  // 8-neighbour offsets indexed CLOCKWISE starting at EAST:
  //   0 E, 1 SE, 2 S, 3 SW, 4 W, 5 NW, 6 N, 7 NE.
  // (Remember image-y grows DOWN, so "S" = y+1.) Clockwise order in screen
  // space is the standard convention for Moore tracing.
  const DX = [1, 1, 0, -1, -1, -1, 0, 1];
  const DY = [0, 1, 1, 1, 0, -1, -1, -1];

  const isFg = (x, y) =>
    x >= 0 && y >= 0 && x < width && y < height && labels[y * width + x] === label;

  const sx = start[0], sy = start[1];

  // Single isolated pixel has no neighbours → return the dot.
  let hasNeighbour = false;
  for (let d = 0; d < 8; d++) if (isFg(sx + DX[d], sy + DY[d])) { hasNeighbour = true; break; }
  if (!hasNeighbour) return [[sx, sy]];

  const contour = [[sx, sy]];

  // Moore-neighbor tracing: at each boundary pixel we restart the clockwise
  // sweep from the neighbour just *clockwise* of the one we backed in from
  // (`(backtrack + 1) % 8`) and step onto the first foreground neighbour. The
  // backtrack pixel is the cell we entered from; the seed comes from the WEST
  // (the pixel before the top-left seed along a clockwise outer walk is always
  // background to its west, so we begin the search from there).
  let cx = sx, cy = sy;
  let backtrack = 4; // index of WEST — the assumed "came-from" for the seed

  // Hard cap so a pathological mask can never spin forever.
  const maxSteps = 8 * width * height + 8;

  for (let step = 0; step < maxSteps; step++) {
    let moved = false;
    // Sweep clockwise beginning one slot after the backtrack direction.
    for (let k = 1; k <= 8; k++) {
      const dir = (backtrack + k) % 8;
      const nx = cx + DX[dir];
      const ny = cy + DY[dir];
      if (isFg(nx, ny)) {
        cx = nx; cy = ny;
        // New backtrack = the cell we just came from, relative to the new
        // pixel = opposite of `dir`.
        backtrack = (dir + 4) % 8;
        moved = true;
        break;
      }
    }
    if (!moved) break; // dead end (shouldn't happen given the seed has a nbr)

    // Stop when we return to the seed. (Simple stopping criterion: revisiting
    // the start pixel. For our solid filled regions this terminates cleanly;
    // the maxSteps cap is the ultimate backstop.)
    if (cx === sx && cy === sy) break;

    contour.push([cx, cy]);
  }

  return contour;
}

// ───────────────────────────────────────────────────────────────────────────
// (4) Ramer–Douglas–Peucker simplification
// ───────────────────────────────────────────────────────────────────────────

// Perpendicular distance from point p to the infinite line through a→b.
function perpDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    // a and b coincide — fall back to point distance.
    const ex = p[0] - a[0], ey = p[1] - a[1];
    return Math.sqrt(ex * ex + ey * ey);
  }
  // |cross(b-a, p-a)| / |b-a|
  const cross = Math.abs(dx * (a[1] - p[1]) - (a[0] - p[0]) * dy);
  return cross / Math.sqrt(len2);
}

/**
 * Classic RDP on an OPEN polyline: keep the two endpoints, recursively keep the
 * farthest point if it exceeds `tol`, discard the rest. Iterative (explicit
 * stack of index ranges) so deep contours don't recurse past the stack limit.
 */
function rdpOpen(points, tol) {
  const nPts = points.length;
  if (nPts < 3) return points.slice();

  const keep = new Uint8Array(nPts);
  keep[0] = 1;
  keep[nPts - 1] = 1;

  const stack = [[0, nPts - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let maxD = -1, maxI = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDistance(points[i], points[lo], points[hi]);
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > tol && maxI !== -1) {
      keep[maxI] = 1;
      stack.push([lo, maxI]);
      stack.push([maxI, hi]);
    }
  }

  const out = [];
  for (let i = 0; i < nPts; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/**
 * Simplify a CLOSED ring. A naive RDP on a closed ring can collapse it because
 * its two "endpoints" are adjacent. We split the ring at the two points that
 * are farthest apart (a stable diameter), RDP each open half, then stitch — a
 * well-known trick for closed-curve RDP.
 */
function rdpClosed(ring, tol) {
  const n = ring.length;
  if (n < 4) return ring.slice();

  // Find the point farthest from ring[0] — gives us a robust "split" vertex so
  // we don't break the ring at an arbitrary near-collinear seam.
  let farI = 0, farD = -1;
  for (let i = 1; i < n; i++) {
    const dx = ring[i][0] - ring[0][0];
    const dy = ring[i][1] - ring[0][1];
    const d = dx * dx + dy * dy;
    if (d > farD) { farD = d; farI = i; }
  }

  // Two open arcs: [0..farI] and [farI..n-1, 0].
  const arcA = ring.slice(0, farI + 1);
  const arcB = ring.slice(farI).concat([ring[0]]);

  const sa = rdpOpen(arcA, tol); // includes ring[0] and ring[farI]
  const sb = rdpOpen(arcB, tol); // includes ring[farI] and ring[0] (dup)

  // Stitch: sa already ends at ring[farI]; sb starts at ring[farI] (skip it)
  // and ends back at ring[0] (skip that duplicate too).
  const out = sa.slice();
  for (let i = 1; i < sb.length - 1; i++) out.push(sb[i]);
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// (5/6) Area + culling
// ───────────────────────────────────────────────────────────────────────────

/**
 * Signed polygon area via the shoelace formula. Positive/negative encodes
 * winding; callers use Math.abs for magnitude. Works on an unclosed ring (we
 * wrap the last→first edge).
 */
function signedArea(ring) {
  let a = 0;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

// ───────────────────────────────────────────────────────────────────────────
// (7) Pixel → mm transform
// ───────────────────────────────────────────────────────────────────────────

/**
 * Compute the overall bounding box across every ring (in pixel space).
 */
function overallBounds(rings) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
    }
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Map pixel rings → mm rings:
 *  - translate so the OVERALL bounds center sits at the origin,
 *  - FLIP Y (image Y grows down; sketch/CAD Y grows up),
 *  - uniform scale so the LONGEST overall bound == targetSizeMm.
 *
 * Centering on the *overall* bounds (not per-profile) keeps multiple profiles
 * in their correct relative positions — two blocks stay side by side.
 */
function pixelsToMm(rings, targetSizeMm) {
  const { minX, minY, maxX, maxY } = overallBounds(rings);
  const wPx = maxX - minX;
  const hPx = maxY - minY;
  const longest = Math.max(wPx, hPx) || 1; // guard divide-by-zero on a dot
  const scale = targetSizeMm / longest;

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  return rings.map((ring) =>
    ring.map(([px, py]) => {
      const x = (px - cx) * scale;
      // FLIP Y: subtract from center so smaller image-y (top) → larger sketch-y.
      const y = (cy - py) * scale;
      return [x, y];
    })
  );
}

// ───────────────────────────────────────────────────────────────────────────
// (8) Point cap (uniform decimation, preserving start vertex)
// ───────────────────────────────────────────────────────────────────────────

/**
 * If a (already RDP'd) ring still exceeds `maxPoints`, uniformly resample down
 * to that budget. We keep evenly spaced indices so the silhouette stays
 * recognisable rather than lopping off a contiguous arc.
 */
function capPoints(ring, maxPoints) {
  const n = ring.length;
  if (n <= maxPoints) return ring;
  const out = [];
  const stepF = n / maxPoints;
  for (let k = 0; k < maxPoints; k++) {
    out.push(ring[Math.floor(k * stepF)]);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────────────

/**
 * Vectorize raster pixel data into closed mm profiles.
 *
 * @param {object} opts
 * @param {Uint8ClampedArray|Uint8Array|number[]} opts.data  RGBA (w*h*4) or grayscale (w*h)
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {number} [opts.threshold=128]            luminance cutoff (0..255)
 * @param {boolean} [opts.invert=false]            treat lighter pixels as foreground
 * @param {number} [opts.simplifyTolerance=1.5]    RDP tolerance in pixels
 * @param {number} [opts.targetSizeMm=100]         longest overall bound in mm
 * @param {number} [opts.maxProfiles=6]            keep the N largest contours
 * @param {number} [opts.maxPointsPerProfile=200]  per-profile vertex cap
 * @returns {{ ok:boolean, profiles:Array<{points:[number,number][],closed:true,area:number}>, warnings:string[], error?:string }}
 *
 * NEVER throws — all failures return { ok:false, error, profiles:[], warnings }.
 */
export function vectorizeImage({
  data,
  width,
  height,
  threshold = 128,
  invert = false,
  simplifyTolerance = 1.5,
  targetSizeMm = 100,
  maxProfiles = 6,
  maxPointsPerProfile = 200,
} = {}) {
  const warnings = [];
  try {
    // ── Validate inputs defensively (no throws escape this function) ────────
    if (!data || typeof data.length !== 'number') {
      return { ok: false, error: 'data is null or not array-like', profiles: [], warnings };
    }
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      return { ok: false, error: `invalid dimensions ${width}x${height}`, profiles: [], warnings };
    }

    // (1) luminance
    const lum = toLuminance(data, width, height); // may throw on length mismatch → caught below

    // (2) threshold → mask
    const mask = thresholdMask(lum, width, height, threshold, invert);

    // Early-out: completely blank (no foreground) image is a legitimate,
    // non-error result.
    let anyFg = false;
    for (let i = 0; i < mask.length; i++) { if (mask[i]) { anyFg = true; break; } }
    if (!anyFg) {
      warnings.push('no foreground found');
      return { ok: true, profiles: [], warnings };
    }

    // (3) connected components, then trace one outer contour per component.
    const { labels, count } = labelComponents(mask, width, height);

    // For each label, find its top-left seed pixel (smallest y, then smallest x
    // among that label's pixels) — a guaranteed outer-boundary start.
    const seeds = new Array(count + 1).fill(null);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const lbl = labels[y * width + x];
        if (lbl !== 0 && seeds[lbl] === null) seeds[lbl] = [x, y];
      }
    }

    const imageArea = width * height;
    const minArea = imageArea * 0.002; // (5) speck threshold: ~0.2% of image

    /** @type {{ ring:number[][], area:number }[]} */
    const traced = [];
    for (let lbl = 1; lbl <= count; lbl++) {
      const seed = seeds[lbl];
      if (!seed) continue;
      const ring = traceOuterContour(labels, width, height, lbl, seed);
      if (ring.length < 3) continue; // dot / line — not a fillable profile
      const area = Math.abs(signedArea(ring));
      if (area < minArea) continue; // (5) cull specks
      traced.push({ ring, area });
    }

    if (traced.length === 0) {
      warnings.push('only specks found (all regions below area threshold)');
      return { ok: true, profiles: [], warnings };
    }

    // (6) keep the largest `maxProfiles` by area.
    traced.sort((p, q) => q.area - p.area);
    if (traced.length > maxProfiles) {
      warnings.push(`kept ${maxProfiles} largest of ${traced.length} regions`);
      traced.length = maxProfiles;
    }

    // (4) simplify each ring with RDP (closed-curve variant).
    const simplified = traced.map(({ ring }) => rdpClosed(ring, simplifyTolerance));

    // (7) transform pixel coords → mm (centered, Y-flipped, scaled). We scale
    // against the OVERALL bounds so relative placement is preserved.
    const mmRings = pixelsToMm(simplified, targetSizeMm);

    // (8) cap points + assemble final profiles, recomputing area in mm.
    const profiles = mmRings.map((ring) => {
      const capped = capPoints(ring, maxPointsPerProfile);
      return {
        points: capped,            // closed:true ⇒ first != last (no duplicate)
        closed: true,
        area: Math.abs(signedArea(capped)),
      };
    });

    // Largest first (after the mm transform area magnitudes can re-order via
    // floating point; keep a stable largest-first ordering for callers).
    profiles.sort((a, b) => b.area - a.area);

    return { ok: true, profiles, warnings };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : String(err),
      profiles: [],
      warnings,
    };
  }
}

/**
 * Adapt vectorize output into the entity shape the studio's `addSketch` tool
 * consumes: a flat list of polyline entities.
 *
 * @param {Array<{points:[number,number][],closed?:boolean}>} profiles
 * @returns {Array<{kind:'polyline', points:[number,number][], closed:true}>}
 */
export function profilesToSketchEntities(profiles) {
  if (!Array.isArray(profiles)) return [];
  return profiles
    .filter((p) => p && Array.isArray(p.points) && p.points.length >= 3)
    .map((p) => ({ kind: 'polyline', points: p.points, closed: true }));
}
