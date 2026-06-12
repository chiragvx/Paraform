import * as v4 from '../../../lib/document/index.js';
import { getPickingSelection } from '../../../lib/picking/selection.js';
import { studio } from '$lib/studio/runtime.svelte.js';
import { dialogs } from '$lib/dialogs/dialogs.svelte.js';
import { openLibrary, openDiff, openCustomModel } from '$lib/dialogs/extras.svelte.js';
import {
  clearSavedDocument,
  saveDocumentToFile,
  saveDocumentAs,
  openDocumentFromFile,
  shareDocumentBundle,
  hasUnsavedChanges,
} from '$lib/document/persistence.svelte.js';
import { enterSketch, cancelSketch, isSketchActive } from '$lib/sketch/boot.js';
import { addBookmark, snapshotCamera } from '$lib/viewport/bookmarks.js';
import { getDocumentStore as _getDocStore } from '../../../lib/document/index.js';
import { V1 } from '../flags.js';

/**
 * Command catalog. Each command:
 *   - id        — stable identifier
 *   - title     — shown in the palette
 *   - group     — section header
 *   - hint?     — optional right-aligned shortcut/help text
 *   - keywords? — extra strings the fuzzy filter matches against
 *   - run(ctx)  — executes. ctx = { store, params? }
 *   - enabled?(ctx) — return false to grey out / skip
 *   - v1Hidden? — true hides the command from palette/search in the V1
 *                 launch UI (src/lib/flags.js). Still invocable by id
 *                 (AI tools, marking menu, shortcuts).
 *   - form?     — { title, description?, fields: [...], submitLabel? }
 *                 When present, palette opens FeatureFormDialog before running.
 */

/** Helpers that read live store/selection inside command handlers. */
function selectedId(store) { return store.selectedFeatureId(); }

/** True when the feature emits at least one body the kernel can operate on. */
function isBodySource(store, featureId) {
  const f = store.doc.features?.[featureId];
  if (!f || f.enabled === false) return false;
  return Array.isArray(f.outputs?.bodies) && f.outputs.bodies.length > 0;
}

/** True when the feature emits a sketch (the operand Extrude/Revolve want). */
function isSketchSource(store, featureId) {
  const f = store.doc.features?.[featureId];
  if (!f || f.enabled === false) return false;
  if (f.type === 'Sketch') return true;
  return Array.isArray(f.outputs?.sketches) && f.outputs.sketches.length > 0;
}

function lastFeatureIds(store, n) {
  const order = store.doc.featureOrder || [];
  return order.slice(-n);
}

function lastBodyIds(store, n) {
  const order = store.doc.featureOrder || [];
  const bodies = order.filter((id) => isBodySource(store, id));
  return bodies.slice(-n);
}

/**
 * Feature IDs covered by the picking selection (unique, in pick order).
 * Used by booleans so Shift+click on N bodies feeds the right operands.
 * Falls back to the store's single-feature selection when picking is empty.
 */
function pickedFeatureIds(store) {
  const sel = getPickingSelection();
  const ids = [];
  const seen = new Set();
  for (const entry of sel.toArray()) {
    const fid = entry.payload?.featureId || entry.descriptor?.featureId;
    if (fid && !seen.has(fid)) { seen.add(fid); ids.push(fid); }
  }
  if (ids.length === 0) {
    const single = selectedId(store);
    if (single) ids.push(single);
  }
  return ids;
}

/** Picked + filtered to body-emitting features only. Used by booleans/modifiers/transforms. */
function pickedBodyIds(store) {
  return pickedFeatureIds(store).filter((id) => isBodySource(store, id));
}

// Exported for tests / external callers that want the same gating logic.
export { pickedBodyIds, pickedFeatureIds };

/**
 * E4 — Marking-menu wedge action map.
 *
 * 8 sectors in clockwise order: N, NE, E, SE, S, SW, W, NW.
 * Each maps to a registry command id; viewer code fires
 * COMMANDS.find(id).run({store}) on the selected wedge.
 *
 * v1 is a fixed action set; user customization is a v2 follow-up.
 */
export const MARKING_MENU_ACTIONS = {
  n:  'modifier.fillet',
  ne: 'modifier.pressPull',
  e:  'xform.move',
  se: 'visibility.hideSelected',
  s:  'edit.delete',
  sw: 'modifier.hole',
  w:  'modifier.chamfer',
  nw: 'modifier.shell',
};

export const COMMANDS = [
  // ── Primitives (defaults — single click) ───────────────────────────────
  { id: 'primitive.box',      title: 'Add Box',      group: 'Primitives', keywords: 'cube',         run: () => v4.addBox() },
  { id: 'primitive.cylinder', title: 'Add Cylinder', group: 'Primitives', keywords: 'tube pipe',    run: () => v4.addCylinder() },
  { id: 'primitive.sphere',   title: 'Add Sphere',   group: 'Primitives', keywords: 'ball',         run: () => v4.addSphere() },
  { id: 'primitive.torus',    title: 'Add Torus',    group: 'Primitives', keywords: 'donut ring',   run: () => v4.addTorus() },

  // ── Primitives with parameter wizard ───────────────────────────────────
  {
    id: 'primitive.box.form',
    title: 'Add Box…',
    group: 'Primitives',
    keywords: 'cube custom dimensions',
    form: {
      title: 'Add Box',
      fields: [
        { key: 'length', label: 'Length', type: 'number', default: 20, unit: 'mm' },
        { key: 'width',  label: 'Width',  type: 'number', default: 20, unit: 'mm' },
        { key: 'height', label: 'Height', type: 'number', default: 20, unit: 'mm' },
      ],
      submitLabel: 'Add',
    },
    run: ({ params }) => v4.addBox(params),
  },
  {
    id: 'primitive.cylinder.form',
    title: 'Add Cylinder…',
    group: 'Primitives',
    keywords: 'tube custom',
    form: {
      title: 'Add Cylinder',
      fields: [
        { key: 'radius', label: 'Radius', type: 'number', default: 10, unit: 'mm' },
        { key: 'height', label: 'Height', type: 'number', default: 20, unit: 'mm' },
      ],
      submitLabel: 'Add',
    },
    run: ({ params }) => v4.addCylinder(params),
  },
  {
    id: 'primitive.sphere.form',
    title: 'Add Sphere…',
    group: 'Primitives',
    form: {
      title: 'Add Sphere',
      fields: [
        { key: 'radius', label: 'Radius', type: 'number', default: 10, unit: 'mm' },
      ],
      submitLabel: 'Add',
    },
    run: ({ params }) => v4.addSphere(params),
  },
  {
    id: 'primitive.torus.form',
    title: 'Add Torus…',
    group: 'Primitives',
    form: {
      title: 'Add Torus',
      fields: [
        { key: 'majorRadius', label: 'Major radius', type: 'number', default: 20, unit: 'mm' },
        { key: 'minorRadius', label: 'Minor radius', type: 'number', default: 4,  unit: 'mm' },
      ],
      submitLabel: 'Add',
    },
    run: ({ params }) => v4.addTorus(params),
  },

  // ── Sketches ───────────────────────────────────────────────────────────
  // Real in-viewport sketcher from app/sketch_3d/ — brings its own DOM
  // overlay, toolbar, dimension constraints, and edit tools.
  {
    id: 'sketch.enter.xy',
    title: 'New Sketch on XY',
    group: 'Sketches',
    keywords: 'draw 2d plane top',
    v1Hidden: true,
    enabled: () => !isSketchActive(),
    run: () => enterSketch('XY'),
  },
  {
    id: 'sketch.enter.xz',
    title: 'New Sketch on XZ',
    group: 'Sketches',
    keywords: 'draw 2d plane front',
    v1Hidden: true,
    enabled: () => !isSketchActive(),
    run: () => enterSketch('XZ'),
  },
  {
    id: 'sketch.enter.yz',
    title: 'New Sketch on YZ',
    group: 'Sketches',
    keywords: 'draw 2d plane right',
    v1Hidden: true,
    enabled: () => !isSketchActive(),
    run: () => enterSketch('YZ'),
  },
  {
    id: 'sketch.cancel',
    title: 'Exit Sketch',
    group: 'Sketches',
    hint: 'Esc',
    v1Hidden: true,
    enabled: () => isSketchActive(),
    run: () => cancelSketch(),
  },
  // E2.1 — re-enter sketching on a SketchOnFace feature. Selecting one in
  // the sidebar arms this command; runs without touching Sidebar.svelte.
  {
    id: 'sketch.editFace',
    title: 'Edit Sketch on Face',
    group: 'Sketches',
    keywords: 're-enter resume face sketch',
    v1Hidden: true,
    enabled: ({ store }) => {
      if (isSketchActive()) return false;
      const id = selectedId(store);
      const f = id && store.doc.features?.[id];
      return !!(f && f.type === 'SketchOnFace' && f.params?.face);
    },
    run: ({ store }) => {
      const id = selectedId(store);
      const f = id && store.doc.features?.[id];
      if (!f || f.type !== 'SketchOnFace' || !f.params?.face) return;
      enterSketch({ faceDescriptor: f.params.face, featureId: f.id });
    },
  },

  // Quick-add helpers (no sketcher — commits a finished sketch feature). Kept
  // for scripted/headless usage; the full sketcher above is the primary path.
  { id: 'sketch.rect.xy.quick',   title: 'Quick Rectangle Sketch on XY', group: 'Sketches', keywords: 'preset', v1Hidden: true,
    run: () => v4.rectangleSketch('XY', 20, 20) },
  { id: 'sketch.circle.xy.quick', title: 'Quick Circle Sketch on XY',    group: 'Sketches', keywords: 'preset', v1Hidden: true,
    run: () => v4.circleSketch('XY', 10) },

  // ── Sketch operations (act on selected sketch) ─────────────────────────
  {
    id: 'sketch.extrude',
    title: 'Extrude Selected Sketch…',
    group: 'Sketches',
    keywords: 'pad pull',
    v1Hidden: true,
    enabled: ({ store }) => isSketchSource(store, selectedId(store)),
    form: {
      title: 'Extrude',
      fields: [
        { key: 'amount', label: 'Distance', type: 'number', default: 10, unit: 'mm' },
        { key: 'both',   label: 'Both directions', type: 'boolean', default: false },
        { key: 'taper',  label: 'Taper angle', type: 'number', default: 0, unit: 'deg' },
      ],
      submitLabel: 'Extrude',
    },
    run: ({ store, params }) => v4.addExtrude(selectedId(store), params),
  },
  {
    id: 'sketch.revolve',
    title: 'Revolve Selected Sketch…',
    group: 'Sketches',
    keywords: 'spin lathe',
    v1Hidden: true,
    enabled: ({ store }) => isSketchSource(store, selectedId(store)),
    form: {
      title: 'Revolve',
      fields: [
        { key: 'axis',  label: 'Axis', type: 'select', default: 'Z',
          options: [{ value: 'X', label: 'X' }, { value: 'Y', label: 'Y' }, { value: 'Z', label: 'Z' }] },
        { key: 'angle', label: 'Angle', type: 'number', default: 360, unit: 'deg' },
      ],
      submitLabel: 'Revolve',
    },
    run: ({ store, params }) => v4.addRevolve(selectedId(store), { angle: params.angle, axis: params.axis }),
  },

  // ── Modifiers (act on selected body) ───────────────────────────────────
  {
    id: 'modifier.fillet',
    title: 'Fillet Selected…',
    group: 'Modifiers',
    keywords: 'round edge',
    enabled: ({ store }) => isBodySource(store, selectedId(store)),
    form: {
      title: 'Fillet',
      description: 'Round all edges of the selected body.',
      fields: [{ key: 'radius', label: 'Radius', type: 'number', default: 2, unit: 'mm' }],
      submitLabel: 'Apply',
    },
    run: ({ store, params }) => v4.addFillet(selectedId(store), { radius: params.radius }),
  },
  {
    id: 'modifier.chamfer',
    title: 'Chamfer Selected…',
    group: 'Modifiers',
    keywords: 'bevel edge',
    enabled: ({ store }) => isBodySource(store, selectedId(store)),
    form: {
      title: 'Chamfer',
      description: 'Break all edges of the selected body.',
      fields: [{ key: 'length', label: 'Length', type: 'number', default: 1, unit: 'mm' }],
      submitLabel: 'Apply',
    },
    run: ({ store, params }) => v4.addChamfer(selectedId(store), { length: params.length }),
  },
  {
    id: 'modifier.shell',
    title: 'Shell Selected…',
    group: 'Modifiers',
    keywords: 'hollow wall',
    enabled: ({ store }) => isBodySource(store, selectedId(store)),
    form: {
      title: 'Shell',
      description: 'Hollow the selected body to a given wall thickness.',
      fields: [{ key: 'thickness', label: 'Thickness', type: 'number', default: 1, unit: 'mm' }],
      submitLabel: 'Apply',
    },
    run: ({ store, params }) => v4.addShell(selectedId(store), { thickness: params.thickness }),
  },

  // ── Booleans (operate on picked bodies; shift-click adds) ──────────────
  // Picking selection IS the multi-selection. Shift+click bodies to build it,
  // then run a boolean. Sketches and other non-body features are filtered out
  // — the kernel can't combine a sketch with a body.
  {
    id: 'bool.union',
    title: 'Union Selected',
    group: 'Boolean',
    keywords: 'add fuse merge',
    enabled: ({ store }) => pickedBodyIds(store).length >= 2 || lastBodyIds(store, 2).length === 2,
    run: ({ store }) => {
      const picks = pickedBodyIds(store);
      v4.addUnion(picks.length >= 2 ? picks : lastBodyIds(store, 2));
    },
  },
  {
    id: 'bool.union.form',
    title: 'Union Selected…',
    group: 'Boolean',
    keywords: 'add fuse merge keep tools',
    enabled: ({ store }) => pickedBodyIds(store).length >= 2 || lastBodyIds(store, 2).length === 2,
    form: {
      title: 'Union',
      description: 'Combine picked bodies. Keep operands when their originals are still needed downstream.',
      fields: [
        { key: 'keepTools', label: 'Keep operands', type: 'boolean', default: false },
      ],
      submitLabel: 'Union',
    },
    run: ({ store, params }) => {
      const picks = pickedBodyIds(store);
      const ids = picks.length >= 2 ? picks : lastBodyIds(store, 2);
      v4.addUnion(ids, { keepTools: !!params.keepTools });
    },
  },
  {
    id: 'bool.cut',
    title: 'Cut Selected (first − rest)',
    group: 'Boolean',
    keywords: 'subtract difference',
    enabled: ({ store }) => pickedBodyIds(store).length >= 2 || lastBodyIds(store, 2).length === 2,
    run: ({ store }) => {
      const picks = pickedBodyIds(store);
      const [a, ...rest] = picks.length >= 2 ? picks : lastBodyIds(store, 2);
      v4.addCut(a, rest);
    },
  },
  {
    id: 'bool.cut.form',
    title: 'Cut Selected…',
    group: 'Boolean',
    keywords: 'subtract difference keep tools',
    enabled: ({ store }) => pickedBodyIds(store).length >= 2 || lastBodyIds(store, 2).length === 2,
    form: {
      title: 'Cut',
      description: 'Subtract picked tools from the first body. Keep tools when their originals are still needed.',
      fields: [
        { key: 'keepTools', label: 'Keep tools', type: 'boolean', default: false },
      ],
      submitLabel: 'Cut',
    },
    run: ({ store, params }) => {
      const picks = pickedBodyIds(store);
      const [a, ...rest] = picks.length >= 2 ? picks : lastBodyIds(store, 2);
      v4.addCut(a, rest, { keepTools: !!params.keepTools });
    },
  },
  {
    id: 'bool.intersect',
    title: 'Intersect Selected',
    group: 'Boolean',
    keywords: 'common',
    enabled: ({ store }) => pickedBodyIds(store).length >= 2 || lastBodyIds(store, 2).length === 2,
    run: ({ store }) => {
      const picks = pickedBodyIds(store);
      v4.addIntersect(picks.length >= 2 ? picks : lastBodyIds(store, 2));
    },
  },
  {
    id: 'bool.intersect.form',
    title: 'Intersect Selected…',
    group: 'Boolean',
    keywords: 'common keep tools',
    enabled: ({ store }) => pickedBodyIds(store).length >= 2 || lastBodyIds(store, 2).length === 2,
    form: {
      title: 'Intersect',
      fields: [
        { key: 'keepTools', label: 'Keep operands', type: 'boolean', default: false },
      ],
      submitLabel: 'Intersect',
    },
    run: ({ store, params }) => {
      const picks = pickedBodyIds(store);
      const ids = picks.length >= 2 ? picks : lastBodyIds(store, 2);
      v4.addIntersect(ids, { keepTools: !!params.keepTools });
    },
  },
  // E3.3 — Split Body (first picked = target, rest = tools).
  {
    id: 'bool.split',
    title: 'Split Body',
    group: 'Boolean',
    keywords: 'cut divide bisect',
    v1Hidden: true,
    enabled: ({ store }) => pickedBodyIds(store).length >= 2,
    run: ({ store }) => {
      const picks = pickedBodyIds(store);
      if (picks.length >= 2) v4.addSplit(picks[0], picks.slice(1));
    },
  },
  // E3.3 — Split Face (face descriptor + curve spec). v1 form-driven only;
  // a face-pick UX is a v2 follow-up.
  {
    id: 'bool.splitFace',
    title: 'Split Face…',
    group: 'Boolean',
    keywords: 'divide face curve',
    v1Hidden: true,
    form: {
      title: 'Split Face',
      description: 'JS-side only in v1 — kernel impl pending; body passes through unchanged.',
      fields: [
        { key: 'faceJson', label: 'Face descriptor (JSON)', type: 'text' },
        { key: 'curveKind', label: 'Curve kind', type: 'select', default: 'sketch',
          options: [
            { value: 'sketch', label: 'Sketch projection' },
            { value: 'plane',  label: 'Plane intersection' },
            { value: 'edges',  label: 'Existing edges' },
          ] },
        { key: 'curveRef', label: 'Sketch / plane id', type: 'text' },
      ],
      submitLabel: 'Apply',
    },
    run: ({ params }) => {
      let face = null;
      try { face = params.faceJson ? JSON.parse(params.faceJson) : null; }
      catch { face = { raw: params.faceJson || '' }; }
      if (!face) return;
      const curve = { kind: params.curveKind || 'sketch' };
      if (params.curveRef) {
        if (curve.kind === 'sketch') curve.sketchId = params.curveRef;
        else if (curve.kind === 'plane') curve.planeId = params.curveRef;
        else if (curve.kind === 'edges') curve.edgeIds = String(params.curveRef).split(',').map(s => s.trim()).filter(Boolean);
      }
      v4.addSplitFace(face, curve);
    },
  },

  // ── Transforms (on selected body) ──────────────────────────────────────
  {
    id: 'xform.move',
    title: 'Move Selected…',
    group: 'Transform',
    keywords: 'translate position',
    enabled: ({ store }) => isBodySource(store, selectedId(store)),
    form: {
      title: 'Move',
      fields: [
        { key: 'x', label: 'X', type: 'number', default: 0, unit: 'mm' },
        { key: 'y', label: 'Y', type: 'number', default: 0, unit: 'mm' },
        { key: 'z', label: 'Z', type: 'number', default: 0, unit: 'mm' },
      ],
      submitLabel: 'Apply',
    },
    run: ({ store, params }) => v4.addMove(selectedId(store), [params.x, params.y, params.z]),
  },
  {
    id: 'xform.rotate',
    title: 'Rotate Selected…',
    group: 'Transform',
    keywords: 'spin orient',
    enabled: ({ store }) => isBodySource(store, selectedId(store)),
    form: {
      title: 'Rotate',
      fields: [
        { key: 'axis',  label: 'Axis', type: 'select', default: 'Z',
          options: [{ value: 'X', label: 'X' }, { value: 'Y', label: 'Y' }, { value: 'Z', label: 'Z' }] },
        { key: 'angle', label: 'Angle', type: 'number', default: 90, unit: 'deg' },
      ],
      submitLabel: 'Apply',
    },
    run: ({ store, params }) => v4.addRotate(selectedId(store), params.axis, params.angle),
  },
  {
    id: 'xform.scale',
    title: 'Scale Selected…',
    group: 'Transform',
    enabled: ({ store }) => isBodySource(store, selectedId(store)),
    form: {
      title: 'Scale',
      fields: [{ key: 'factor', label: 'Factor', type: 'number', default: 1.5, step: 0.1 }],
      submitLabel: 'Apply',
    },
    run: ({ store, params }) => v4.addScale(selectedId(store), params.factor),
  },
  // E3.4 — Align source body to target by named datums.
  {
    id: 'xform.align',
    title: 'Align Bodies…',
    group: 'Transform',
    keywords: 'snap mate position datum',
    v1Hidden: true,
    form: {
      title: 'Align Bodies',
      description: 'Align a source body to a target by named datums. Kernel datum resolver pending — translate-only fallback in effect.',
      fields: [
        { key: 'sourceId',    label: 'Source feature id', type: 'text' },
        { key: 'targetId',    label: 'Target feature id', type: 'text' },
        { key: 'sourceDatum', label: 'Source datum', type: 'select', default: 'corner-min-min-min',
          options: [
            { value: 'corner-min-min-min', label: 'Corner −X −Y −Z' },
            { value: 'corner-max-max-min', label: 'Corner +X +Y −Z' },
            { value: 'face-center-+Z',     label: 'Face center +Z' },
            { value: 'face-center--Z',     label: 'Face center −Z' },
            { value: 'face-center-+X',     label: 'Face center +X' },
            { value: 'face-center-+Y',     label: 'Face center +Y' },
          ] },
        { key: 'targetDatum', label: 'Target datum', type: 'select', default: 'corner-min-min-min',
          options: [
            { value: 'corner-min-min-min', label: 'Corner −X −Y −Z' },
            { value: 'corner-max-max-min', label: 'Corner +X +Y −Z' },
            { value: 'face-center-+Z',     label: 'Face center +Z' },
            { value: 'face-center--Z',     label: 'Face center −Z' },
            { value: 'face-center-+X',     label: 'Face center +X' },
            { value: 'face-center-+Y',     label: 'Face center +Y' },
          ] },
        { key: 'ox', label: 'Offset X', type: 'number', default: 0, unit: 'mm' },
        { key: 'oy', label: 'Offset Y', type: 'number', default: 0, unit: 'mm' },
        { key: 'oz', label: 'Offset Z', type: 'number', default: 0, unit: 'mm' },
      ],
      submitLabel: 'Align',
    },
    run: ({ params }) => v4.addAlign(params.sourceId, params.targetId, {
      sourceDatum: params.sourceDatum, targetDatum: params.targetDatum,
      offset: [params.ox || 0, params.oy || 0, params.oz || 0],
    }),
  },
  // E3.5 — Cosmetic thread (metadata-only; no geometry change).
  {
    id: 'modifier.thread',
    title: 'Cosmetic Thread…',
    group: 'Modifiers',
    keywords: 'thread tapped m3 m4 m5 m6 m8 m10 bom',
    v1Hidden: true,
    form: {
      title: 'Cosmetic Thread',
      description: 'Tag a face as threaded. Metadata only — no geometry change; renders as a hatched overlay.',
      fields: [
        { key: 'faceJson', label: 'Face descriptor (JSON)', type: 'text' },
        { key: 'standard', label: 'Thread standard', type: 'select', default: 'M3 × 0.5',
          options: [
            { value: 'M2 × 0.4',   label: 'M2 × 0.4' },
            { value: 'M2.5 × 0.45', label: 'M2.5 × 0.45' },
            { value: 'M3 × 0.5',   label: 'M3 × 0.5' },
            { value: 'M4 × 0.7',   label: 'M4 × 0.7' },
            { value: 'M5 × 0.8',   label: 'M5 × 0.8' },
            { value: 'M6 × 1.0',   label: 'M6 × 1.0' },
            { value: 'M8 × 1.25',  label: 'M8 × 1.25' },
            { value: 'M10 × 1.5',  label: 'M10 × 1.5' },
            { value: 'M12 × 1.75', label: 'M12 × 1.75' },
            { value: 'M16 × 2.0',  label: 'M16 × 2.0' },
          ] },
        { key: 'length',    label: 'Thread length', type: 'number', default: 10, unit: 'mm' },
        { key: 'direction', label: 'Direction', type: 'select', default: 'right-hand',
          options: [
            { value: 'right-hand', label: 'Right-hand' },
            { value: 'left-hand',  label: 'Left-hand' },
          ] },
      ],
      submitLabel: 'Add',
    },
    run: ({ params }) => {
      let face = null;
      try { face = params.faceJson ? JSON.parse(params.faceJson) : null; }
      catch { face = { raw: params.faceJson || '' }; }
      if (!face) return;
      // Pull nominal diameter + pitch out of the catalog label "Mx × y".
      const match = String(params.standard || '').match(/^M([\d.]+)\s*[×x]\s*([\d.]+)/);
      const nominalDiameter = match ? Number(match[1]) : 3;
      const pitch = match ? Number(match[2]) : 0.5;
      v4.addCosmeticThread(face, {
        standard: params.standard,
        pitch, nominalDiameter,
        length: params.length || 10,
        direction: params.direction || 'right-hand',
      });
    },
  },

  // ── View ───────────────────────────────────────────────────────────────
  { id: 'view.fit',   title: 'Fit to Body',     group: 'View', hint: 'F',      enabled: () => !!studio.views, run: () => studio.views.fit() },
  { id: 'view.iso',   title: 'View: Isometric', group: 'View', hint: 'Ctrl+7', enabled: () => !!studio.views, run: () => studio.views.iso() },
  { id: 'view.top',   title: 'View: Top',       group: 'View', hint: 'Ctrl+5', enabled: () => !!studio.views, run: () => studio.views.top() },
  { id: 'view.front', title: 'View: Front',     group: 'View', hint: 'Ctrl+1', enabled: () => !!studio.views, run: () => studio.views.front() },
  { id: 'view.right', title: 'View: Right',     group: 'View', hint: 'Ctrl+4', enabled: () => !!studio.views, run: () => studio.views.right() },

  // ── Display ────────────────────────────────────────────────────────────
  // Gate on bridge: the display-mode effect is a no-op until the bridge boots,
  // so firing a command before viewport mounts silently drops the toggle.
  { id: 'display.shaded',          title: 'Display: Shaded',            group: 'Display',           enabled: () => !!studio.bridge, run: () => { studio.displayMode = 'shaded'; } },
  { id: 'display.shaded-edges',    title: 'Display: Shaded + Edges',    group: 'Display',           enabled: () => !!studio.bridge, run: () => { studio.displayMode = 'shaded-edges'; } },
  { id: 'display.wireframe',       title: 'Display: Wireframe',         group: 'Display', hint: 'W', enabled: () => !!studio.bridge, run: () => { studio.displayMode = 'wireframe'; } },
  { id: 'display.wireframe-edges', title: 'Display: Wireframe + Edges', group: 'Display',           enabled: () => !!studio.bridge, run: () => { studio.displayMode = 'wireframe-edges'; } },
  { id: 'display.technical',       title: 'Display: Technical (Blueprint)', group: 'Display', keywords: 'line drawing blueprint black white plan engineering', enabled: () => !!studio.bridge, run: () => { studio.displayMode = 'technical'; } },
  // E6.1 — overlay toggles (compose with the four base modes).
  { id: 'display.hiddenEdges',     title: 'Toggle Hidden Edges',        group: 'Display', keywords: 'occluded dashed lines', enabled: () => !!studio.bridge, run: () => { studio.hiddenEdges = !studio.hiddenEdges; } },
  { id: 'display.xray',            title: 'Toggle X-Ray',               group: 'Display', keywords: 'transparent see through ghost', enabled: () => !!studio.bridge, run: () => { studio.xray = !studio.xray; } },

  // ── E6.2 — View bookmarks ─────────────────────────────────────────────
  {
    id: 'view.bookmark.save',
    title: 'Save Current View as Bookmark…',
    group: 'View',
    keywords: 'camera snapshot saved view',
    enabled: () => !!studio.viewport,
    run: () => {
      try {
        const cam = studio.viewport?.camera; const ctrls = studio.viewport?.controls;
        if (!cam) return;
        const snap = snapshotCamera(cam, ctrls);
        const name = (typeof window !== 'undefined' && window.prompt) ? window.prompt('Bookmark name', 'View') : 'View';
        if (!name) return;
        let docId = 'default';
        try { docId = _getDocStore().doc?.metadata?.id || 'default'; } catch {}
        addBookmark({ docId, name, ...snap });
      } catch (err) { console.warn('[view.bookmark.save] failed:', err); }
    },
  },
  // E6.5 — timeline rollback control.
  {
    id: 'timeline.clearRollback',
    title: 'Clear Rollback (show all)',
    group: 'View',
    keywords: 'rollback head timeline scrub clear',
    enabled: () => !!studio.rollbackHead,
    run: () => { studio.rollbackHead = null; try { studio.applyRollback?.(); } catch {} },
  },

  // ── Edit ───────────────────────────────────────────────────────────────
  { id: 'edit.undo',   title: 'Undo',                    group: 'Edit', hint: 'Ctrl+Z', enabled: ({ store }) => store.canUndo(), run: ({ store }) => store.undo() },
  { id: 'edit.redo',   title: 'Redo',                    group: 'Edit', hint: 'Ctrl+Y', enabled: ({ store }) => store.canRedo(), run: ({ store }) => store.redo() },
  { id: 'edit.delete', title: 'Delete Selected', group: 'Edit', hint: 'Del',
    enabled: ({ store }) => pickedFeatureIds(store).length > 0,
    run: ({ store }) => {
      const ids = pickedFeatureIds(store);
      // Cascade so deleting a placed part's body also removes its component
      // husk (child components survive via first-child promotion).
      for (const id of ids) { try { v4.deleteFeatureCascade(id); } catch {} }
    } },
  // Removed duplicate "New Document" (edit.reset) — doc.new is the single
  // entry, and it confirms before discarding unsaved changes.
  { id: 'edit.clearSaved', title: 'Clear Saved State',   group: 'Edit', keywords: 'forget storage reload', run: () => clearSavedDocument() },

  // ── Document file persistence (E5.1 / E5.4) ───────────────────────────
  // Save / Save As download a `.paraform.json` blob; Open round-trips the
  // file back through store.fromJSON (v4 + v5 both load).
  {
    id: 'doc.new',
    title: 'New Document',
    group: 'Document',
    hint: 'Ctrl+N',
    keywords: 'reset clear fresh start',
    run: () => {
      if (hasUnsavedChanges()) {
        dialogs.open('newDocConfirm');
      } else {
        try { v4.resetDocument(); }
        catch (err) { console.warn('[doc.new] reset failed:', err); }
      }
    },
  },
  {
    id: 'doc.open',
    title: 'Open…',
    group: 'Document',
    keywords: 'load file paraform json import',
    run: () => {
      try {
        const p = openDocumentFromFile();
        if (p && typeof p.catch === 'function') p.catch((e) => console.warn('[doc.open]', e));
      } catch (err) { console.warn('[doc.open] failed:', err); }
    },
  },
  {
    id: 'doc.save',
    title: 'Save',
    group: 'Document',
    hint: 'Ctrl+S',
    keywords: 'download paraform json file',
    run: () => {
      try { saveDocumentToFile(); }
      catch (err) { console.warn('[doc.save] failed:', err); }
    },
  },
  {
    id: 'doc.saveAs',
    title: 'Save As…',
    group: 'Document',
    keywords: 'download rename paraform json',
    run: () => {
      try { saveDocumentAs(); }
      catch (err) { console.warn('[doc.saveAs] failed:', err); }
    },
  },
  {
    id: 'doc.shareBundle',
    title: 'Share…',
    group: 'Document',
    keywords: 'bundle download zip readme screenshot export',
    run: () => {
      try { shareDocumentBundle(); }
      catch (err) { console.warn('[doc.shareBundle] failed:', err); }
    },
  },

  // ── Visibility ─────────────────────────────────────────────────────────
  {
    id: 'visibility.hideSelected',
    title: 'Hide Selected',
    group: 'Visibility',
    hint: 'H',
    enabled: ({ store }) => pickedFeatureIds(store).length > 0 || !!selectedId(store),
    run: ({ store }) => {
      const ids = pickedFeatureIds(store);
      for (const id of ids) v4.setFeatureEnabled(id, false);
    },
  },
  {
    id: 'visibility.isolateSelected',
    title: 'Isolate Selection',
    group: 'Visibility',
    hint: 'Ctrl+I',
    keywords: 'solo hide others fade ghost',
    enabled: ({ store }) => pickedFeatureIds(store).length > 0 || !!selectedId(store),
    run: ({ store }) => {
      // Soft, non-destructive isolation: fade the OTHER bodies' opacity to
      // ~0.08 + depthWrite=false. Toggle off when the same set is already
      // isolated (Ctrl+I press cycles like Fusion).
      const ids = pickedFeatureIds(store);
      const cur = studio.isolatedFeatureIds;
      const same = cur && cur.size === ids.length && ids.every((i) => cur.has(i));
      if (same) studio.clearIsolation();
      else studio.isolate(ids);
    },
  },
  {
    id: 'visibility.showAll',
    title: 'Show All Features',
    group: 'Visibility',
    keywords: 'unhide reveal',
    run: ({ store }) => {
      studio.clearIsolation();
      for (const id of store.doc.featureOrder || []) {
        v4.setFeatureEnabled(id, true);
      }
    },
  },

  // ── App ────────────────────────────────────────────────────────────────
  { id: 'app.export',   title: 'Export…',   group: 'App', keywords: 'save stl step brep download', run: () => dialogs.open('export') },
  { id: 'app.parameters', title: 'Parameters…', group: 'App', keywords: 'variables vars equations expressions', v1Hidden: true, run: () => dialogs.open('parameters') },
  { id: 'app.settings', title: 'Settings…', group: 'App', keywords: 'preferences tessellation units', run: () => dialogs.open('settings') },
  { id: 'app.library', title: 'Open Studio Library…', group: 'App', keywords: 'assets parts insert', run: () => openLibrary() },
  { id: 'app.diff', title: 'Show Document Diff…', group: 'App', keywords: 'changes saved compare', v1Hidden: true, run: () => openDiff() },
  { id: 'app.customModel', title: 'Add Custom Model…', group: 'App', keywords: 'import step iges obj gltf glb', v1Hidden: true, run: () => openCustomModel() },

  // ── Scripted features (BuildScript) ────────────────────────────────────
  {
    id: 'script.create',
    title: 'New Script…',
    group: 'App',
    keywords: 'code build123d python custom buildscript',
    v1Hidden: true,
    run: () => dialogs.openScript(null),
  },
  {
    id: 'script.edit',
    title: 'Edit Selected Script',
    group: 'App',
    keywords: 'code build123d python buildscript',
    v1Hidden: true,
    enabled: ({ store }) => {
      const id = store.selectedFeatureId();
      return !!id && store.doc.features[id]?.type === 'BuildScript';
    },
    run: ({ store }) => dialogs.openScript(store.selectedFeatureId()),
  },

  // ── Components (Foundation 6 / commit 3) ───────────────────────────────
  {
    id: 'component.create',
    title: 'New Component…',
    group: 'App',
    keywords: 'add subassembly child',
    run: () => {
      const name = window.prompt('Component name');
      if (name) v4.addComponent({ name: name.trim(), parentId: studio.activeComponentId });
    },
  },
  {
    id: 'component.activate',
    title: 'Activate Root Component',
    group: 'App',
    keywords: 'select parent',
    run: () => studio.setActiveComponent('root'),
  },
  {
    id: 'component.delete',
    title: 'Delete Active Component',
    group: 'App',
    keywords: 'remove subassembly',
    enabled: () => studio.activeComponentId !== 'root',
    run: ({ store }) => {
      const id = studio.activeComponentId;
      studio.setActiveComponent('root');
      // Groups delete their whole contents; anything else orphans child
      // components (first child is promoted into the deleted node's place).
      if (store.doc.components?.[id]?.kind === 'group') v4.removeComponent(id);
      else v4.removeComponentPromote(id);
    },
  },
  {
    id: 'feature.moveToActiveComponent',
    title: 'Move Selected Feature to Active Component',
    group: 'App',
    keywords: 'reassign',
    enabled: ({ store }) => {
      const fid = store.selectedFeatureId();
      if (!fid) return false;
      const f = store.doc.features[fid];
      return !!f && studio.activeComponentId !== f.componentId;
    },
    run: ({ store }) => v4.setFeatureComponent(store.selectedFeatureId(), studio.activeComponentId),
  },

  // Foundation 6 / commit 2 — quick sanity check while the browser UI lands.
  { id: 'debug.activeComponent', title: 'Show Active Component', group: 'App', keywords: 'component debug active', v1Hidden: true, run: () => console.info('[component] active:', studio.activeComponentId) },

  // ── E1.1 Sketch → Solid stubs ─────────────────────────────────────────
  // Profile + path are feature-id text fields for now; v2 polish is a real
  // feature-ref picker that lists Sketch / Helix features inline.
  {
    id: 'sketch.sweep',
    title: 'Sweep Sketch Along Path…',
    group: 'Sketches',
    keywords: 'profile path extrude curve',
    v1Hidden: true,
    form: {
      title: 'Sweep',
      description: 'Sweep a profile sketch along a path feature (sketch or helix). Enter feature ids until the picker lands.',
      fields: [
        { key: 'profileSketchId', label: 'Profile sketch (feature id)', type: 'text' },
        { key: 'pathFeatureId',   label: 'Path feature (feature id)',   type: 'text' },
      ],
      submitLabel: 'Sweep',
    },
    run: ({ params }) => v4.addSweep(params.profileSketchId, params.pathFeatureId),
  },
  {
    id: 'sketch.loft',
    title: 'Loft Sketches…',
    group: 'Sketches',
    keywords: 'blend sections',
    v1Hidden: true,
    form: {
      title: 'Loft',
      description: 'Loft between two or more sketches. Enter comma-separated feature ids.',
      fields: [
        { key: 'sketchIds', label: 'Sketch ids (comma-separated)', type: 'text' },
        { key: 'ruled',    label: 'Ruled (linear) surface',         type: 'boolean', default: false },
      ],
      submitLabel: 'Loft',
    },
    run: ({ params }) => v4.addLoft(
      String(params.sketchIds || '').split(',').map(s => s.trim()).filter(Boolean),
      { ruled: params.ruled === true || params.ruled === 'true' },
    ),
  },
  {
    id: 'geom.helix',
    title: 'Add Helix…',
    group: 'Reference geometry',
    keywords: 'spring coil thread spiral path',
    v1Hidden: true,
    form: {
      title: 'Helix',
      description: 'Helical curve — useful on its own or as a sweep path for threads/springs.',
      fields: [
        { key: 'pitch',     label: 'Pitch',      type: 'number',  default: 5,  unit: 'mm' },
        { key: 'height',    label: 'Height',     type: 'number',  default: 20, unit: 'mm' },
        { key: 'radius',    label: 'Radius',     type: 'number',  default: 5,  unit: 'mm' },
        { key: 'coneAngle', label: 'Cone angle', type: 'number',  default: 0,  unit: 'deg' },
        { key: 'lefthand',  label: 'Left-hand',  type: 'boolean', default: false },
      ],
      submitLabel: 'Add',
    },
    run: ({ params }) => v4.addHelix(params),
  },

  // ── E1.2 Modifier stubs ────────────────────────────────────────────────
  {
    id: 'modifier.hole',
    title: 'Hole on Selected…',
    group: 'Modifiers',
    keywords: 'drill bore countersink counterbore',
    enabled: ({ store }) => isBodySource(store, selectedId(store)),
    form: {
      title: 'Hole',
      description: 'Drill a hole into the selected body.',
      fields: [
        { key: 'diameter',     label: 'Diameter',         type: 'number',  default: 4,  unit: 'mm' },
        { key: 'depth',        label: 'Depth',            type: 'number',  default: 10, unit: 'mm' },
        { key: 'through',      label: 'Through all',      type: 'boolean', default: true },
        { key: 'type',         label: 'Type',             type: 'select',  default: 'simple',
          options: [
            { value: 'simple',      label: 'Simple' },
            { value: 'counterbore', label: 'Counterbore' },
            { value: 'countersink', label: 'Countersink' },
          ] },
        { key: 'counterDia',   label: 'Counter diameter (cbore/csink)', type: 'number', default: 6, unit: 'mm' },
        { key: 'counterDepth', label: 'Counter depth (cbore)',          type: 'number', default: 2, unit: 'mm' },
      ],
      submitLabel: 'Apply',
    },
    run: ({ store, params }) => v4.addHole(selectedId(store), params),
  },
  {
    id: 'modifier.draft',
    title: 'Draft Selected…',
    group: 'Modifiers',
    keywords: 'taper mold pull angle',
    v1Hidden: true,
    enabled: ({ store }) => isBodySource(store, selectedId(store)),
    form: {
      title: 'Draft',
      description: 'Coming via kernel impl — currently a no-op stub. UI is wired so the surface stays consistent.',
      fields: [
        { key: 'angle',         label: 'Angle',         type: 'number', default: 3, unit: 'deg' },
        { key: 'pullDirection', label: 'Pull direction', type: 'select', default: '+Z',
          options: [
            { value: '+Z', label: '+Z' }, { value: '-Z', label: '-Z' },
            { value: '+Y', label: '+Y' }, { value: '-Y', label: '-Y' },
            { value: '+X', label: '+X' }, { value: '-X', label: '-X' },
          ] },
      ],
      submitLabel: 'Apply',
    },
    run: ({ store, params }) => v4.addDraft(selectedId(store), params),
  },

  // ── E3.1 Press-Pull (direct-edit headline) ────────────────────────────
  // Two entry points:
  //   modifier.pressPull       — face-pick gesture → form with distance prompt
  //   modifier.pressPull.form  — keyboard/scriptable; full form with face JSON
  {
    id: 'modifier.pressPull',
    title: 'Press-Pull Face',
    group: 'Modifiers',
    keywords: 'extrude face direct edit push pull',
    run: () => {
      // Arm a face-pick gesture; on commit, open the distance form with the
      // descriptor pre-baked. Drag-handle UX is a v2 follow-up (tracked).
      const ok = studio.startFacePick({
        purpose: 'press-pull',
        accept: ['face'],
        onPick: (descriptor) => {
          const distStr = typeof window !== 'undefined'
            ? window.prompt('Press-pull distance (mm). Positive pushes out, negative pulls in.', '5')
            : '5';
          if (distStr == null) return;
          const distance = Number(distStr);
          if (!Number.isFinite(distance)) return;
          try { v4.addPushPullFace(descriptor, distance); }
          catch (err) { console.error('[press-pull] failed', err); }
        },
        onCancel: () => {},
      });
      if (!ok) console.warn('[press-pull] viewport not ready');
    },
  },
  {
    id: 'modifier.pressPull.form',
    title: 'Press-Pull Face…',
    group: 'Modifiers',
    keywords: 'extrude face direct edit push pull form',
    form: {
      title: 'Press-Pull Face',
      description: 'Translate a face along its outward normal. Positive pushes out, negative pulls in. Non-planar faces are not yet supported and pass through unchanged.',
      fields: [
        { key: 'faceJson', label: 'Face descriptor (JSON)', type: 'text' },
        { key: 'distance', label: 'Distance',               type: 'number', default: 5, unit: 'mm' },
      ],
      submitLabel: 'Apply',
    },
    run: ({ params }) => {
      let face = null;
      try { face = params.faceJson ? JSON.parse(params.faceJson) : null; }
      catch { face = null; }
      if (!face) {
        console.warn('[press-pull] bad face descriptor JSON');
        return;
      }
      const d = Number(params.distance);
      if (!Number.isFinite(d)) return;
      try { v4.addPushPullFace(face, d); }
      catch (err) { console.error('[press-pull] failed', err); }
    },
  },

  // ── E3.2 Face-edit ops (Move / Delete / Offset Face) ─────────────────
  // Each pairs a face-pick palette command with a form-driven sibling so
  // power users / scripted callers can drive them by descriptor JSON.
  {
    id: 'modifier.moveFace',
    title: 'Move Face',
    group: 'Modifiers',
    keywords: 'translate face direct edit slide',
    v1Hidden: true,
    run: () => {
      const ok = studio.startFacePick({
        purpose: 'move-face',
        accept: ['face'],
        onPick: (descriptor) => {
          const vecStr = typeof window !== 'undefined'
            ? window.prompt('Move Face vector (vx, vy, vz mm). Only the normal component is honored in v1.', '0, 0, 5')
            : '0, 0, 5';
          if (vecStr == null) return;
          const parts = String(vecStr).split(',').map(s => Number(s.trim()));
          if (parts.length !== 3 || !parts.every(Number.isFinite)) return;
          try { v4.addMoveFace(descriptor, parts); }
          catch (err) { console.error('[move-face] failed', err); }
        },
        onCancel: () => {},
      });
      if (!ok) console.warn('[move-face] viewport not ready');
    },
  },
  {
    id: 'modifier.moveFace.form',
    title: 'Move Face…',
    group: 'Modifiers',
    keywords: 'translate face direct edit form',
    v1Hidden: true,
    form: {
      title: 'Move Face',
      description: 'Translate a face along an arbitrary vector. v1 honours the normal component only — tangent slide is not yet supported.',
      fields: [
        { key: 'faceJson', label: 'Face descriptor (JSON)', type: 'text' },
        { key: 'vx', label: 'Vector X', type: 'number', default: 0, unit: 'mm' },
        { key: 'vy', label: 'Vector Y', type: 'number', default: 0, unit: 'mm' },
        { key: 'vz', label: 'Vector Z', type: 'number', default: 5, unit: 'mm' },
      ],
      submitLabel: 'Apply',
    },
    run: ({ params }) => {
      let face = null;
      try { face = params.faceJson ? JSON.parse(params.faceJson) : null; }
      catch { face = null; }
      if (!face) { console.warn('[move-face] bad face descriptor JSON'); return; }
      const v = [Number(params.vx) || 0, Number(params.vy) || 0, Number(params.vz) || 0];
      try { v4.addMoveFace(face, v); }
      catch (err) { console.error('[move-face] failed', err); }
    },
  },

  {
    id: 'modifier.deleteFace',
    title: 'Delete Face',
    group: 'Modifiers',
    keywords: 'remove face hole patch heal',
    v1Hidden: true,
    run: () => {
      const ok = studio.startFacePick({
        purpose: 'delete-face',
        accept: ['face'],
        onPick: (descriptor) => {
          try { v4.addDeleteFace(descriptor); }
          catch (err) { console.error('[delete-face] failed', err); }
        },
        onCancel: () => {},
      });
      if (!ok) console.warn('[delete-face] viewport not ready');
    },
  },
  {
    id: 'modifier.deleteFace.form',
    title: 'Delete Face…',
    group: 'Modifiers',
    keywords: 'remove face hole patch form',
    v1Hidden: true,
    form: {
      title: 'Delete Face',
      description: 'Remove a face and heal the body. Best-effort kernel heal; open boundaries may pass through unchanged.',
      fields: [
        { key: 'faceJson', label: 'Face descriptor (JSON)', type: 'text' },
      ],
      submitLabel: 'Apply',
    },
    run: ({ params }) => {
      let face = null;
      try { face = params.faceJson ? JSON.parse(params.faceJson) : null; }
      catch { face = null; }
      if (!face) { console.warn('[delete-face] bad face descriptor JSON'); return; }
      try { v4.addDeleteFace(face); }
      catch (err) { console.error('[delete-face] failed', err); }
    },
  },

  {
    id: 'modifier.offsetFace',
    title: 'Offset Face',
    group: 'Modifiers',
    keywords: 'thicken thin face parametric',
    v1Hidden: true,
    run: () => {
      const ok = studio.startFacePick({
        purpose: 'offset-face',
        accept: ['face'],
        onPick: (descriptor) => {
          const distStr = typeof window !== 'undefined'
            ? window.prompt('Offset distance (mm). Positive pushes the face outward.', '1')
            : '1';
          if (distStr == null) return;
          const distance = Number(distStr);
          if (!Number.isFinite(distance)) return;
          try { v4.addOffsetFace(descriptor, distance); }
          catch (err) { console.error('[offset-face] failed', err); }
        },
        onCancel: () => {},
      });
      if (!ok) console.warn('[offset-face] viewport not ready');
    },
  },
  {
    id: 'modifier.offsetFace.form',
    title: 'Offset Face…',
    group: 'Modifiers',
    keywords: 'thicken thin face parametric form',
    v1Hidden: true,
    form: {
      title: 'Offset Face',
      description: 'Single-face thicken/thin along the face normal. v1 routes through the Press-Pull kernel path.',
      fields: [
        { key: 'faceJson', label: 'Face descriptor (JSON)', type: 'text' },
        { key: 'distance', label: 'Distance',               type: 'number', default: 1, unit: 'mm' },
      ],
      submitLabel: 'Apply',
    },
    run: ({ params }) => {
      let face = null;
      try { face = params.faceJson ? JSON.parse(params.faceJson) : null; }
      catch { face = null; }
      if (!face) { console.warn('[offset-face] bad face descriptor JSON'); return; }
      const d = Number(params.distance);
      if (!Number.isFinite(d)) return;
      try { v4.addOffsetFace(face, d); }
      catch (err) { console.error('[offset-face] failed', err); }
    },
  },

  // ── E1.3 Pattern commands ─────────────────────────────────────────────
  // Note: addLinearPattern's helper signature takes `direction` as an axis ref
  // (string 'X'/'Y'/'Z'), not a vec3. v2 polish: extend the helper + kernel
  // to accept a vec3 and switch this form to dx/dy/dz numbers.
  {
    id: 'pattern.linear',
    title: 'Linear Pattern Selected…',
    group: 'Pattern',
    keywords: 'array row',
    v1Hidden: true,
    enabled: ({ store }) => isBodySource(store, selectedId(store)),
    form: {
      title: 'Linear Pattern',
      fields: [
        { key: 'direction', label: 'Direction', type: 'select', default: 'X',
          options: [{ value: 'X', label: 'X' }, { value: 'Y', label: 'Y' }, { value: 'Z', label: 'Z' }] },
        { key: 'count',     label: 'Count',     type: 'number', default: 3 },
        { key: 'spacing',   label: 'Spacing',   type: 'number', default: 20, unit: 'mm' },
      ],
      submitLabel: 'Apply',
    },
    run: ({ store, params }) => v4.addLinearPattern(selectedId(store), {
      direction: params.direction, count: params.count, spacing: params.spacing,
    }),
  },
  {
    id: 'pattern.circular',
    title: 'Circular Pattern Selected…',
    group: 'Pattern',
    keywords: 'array ring polar',
    v1Hidden: true,
    enabled: ({ store }) => isBodySource(store, selectedId(store)),
    form: {
      title: 'Circular Pattern',
      fields: [
        { key: 'axis',  label: 'Axis',  type: 'select', default: 'Z',
          options: [{ value: 'X', label: 'X' }, { value: 'Y', label: 'Y' }, { value: 'Z', label: 'Z' }] },
        { key: 'count', label: 'Count', type: 'number', default: 4 },
        { key: 'angle', label: 'Angle', type: 'number', default: 360, unit: 'deg' },
      ],
      submitLabel: 'Apply',
    },
    run: ({ store, params }) => v4.addCircularPattern(selectedId(store), params),
  },
  {
    id: 'pattern.mirror',
    title: 'Mirror Selected…',
    group: 'Pattern',
    keywords: 'reflect symmetric',
    v1Hidden: true,
    enabled: ({ store }) => isBodySource(store, selectedId(store)),
    form: {
      title: 'Mirror',
      fields: [
        { key: 'plane', label: 'Plane', type: 'select', default: 'XY',
          options: [{ value: 'XY', label: 'XY' }, { value: 'XZ', label: 'XZ' }, { value: 'YZ', label: 'YZ' }] },
      ],
      submitLabel: 'Apply',
    },
    run: ({ store, params }) => v4.addMirror(selectedId(store), params.plane),
  },
  {
    id: 'pattern.path',
    title: 'Path Pattern Selected…',
    group: 'Pattern',
    keywords: 'array curve along',
    v1Hidden: true,
    enabled: ({ store }) => isBodySource(store, selectedId(store)),
    form: {
      title: 'Path Pattern',
      description: 'Distribute copies of the selected body along a path sketch. Enter the path sketch feature id.',
      fields: [
        { key: 'pathFeatureId', label: 'Path sketch (feature id)', type: 'text' },
        { key: 'count',         label: 'Count',                    type: 'number', default: 3 },
      ],
      submitLabel: 'Apply',
    },
    run: ({ store, params }) => v4.addPathPattern(selectedId(store), params.pathFeatureId, { count: params.count }),
  },

  // ── E1.4 Reference geometry ───────────────────────────────────────────
  {
    id: 'ref.plane',
    title: 'New Plane…',
    group: 'Reference geometry',
    keywords: 'datum construction sketch surface',
    v1Hidden: true,
    form: {
      title: 'Reference Plane',
      description: 'Only "offset" mode is wired in v1; other modes commit a placeholder + warning chip.',
      fields: [
        { key: 'type', label: 'Type', type: 'select', default: 'offset',
          options: [
            { value: 'offset',             label: 'Offset from base plane' },
            { value: 'three-point',        label: 'Through three points (coming soon)' },
            { value: 'through-face-edge',  label: 'Through face + edge (coming soon)' },
            { value: 'mid-plane',          label: 'Mid-plane between two (coming soon)' },
          ] },
        { key: 'basePlane', label: 'Base plane', type: 'select', default: 'XY',
          options: [{ value: 'XY', label: 'XY' }, { value: 'XZ', label: 'XZ' }, { value: 'YZ', label: 'YZ' }] },
        { key: 'offset',    label: 'Offset',     type: 'number', default: 10, unit: 'mm' },
      ],
      submitLabel: 'Add',
    },
    run: ({ params }) => v4.addPlane(params),
  },
  {
    id: 'ref.axis',
    title: 'New Axis…',
    group: 'Reference geometry',
    keywords: 'datum construction line direction',
    v1Hidden: true,
    form: {
      title: 'Reference Axis',
      fields: [
        { key: 'x', label: 'Origin X', type: 'number', default: 0, unit: 'mm' },
        { key: 'y', label: 'Origin Y', type: 'number', default: 0, unit: 'mm' },
        { key: 'z', label: 'Origin Z', type: 'number', default: 0, unit: 'mm' },
        { key: 'direction', label: 'Direction', type: 'select', default: '+Z',
          options: [
            { value: '+X', label: '+X' }, { value: '+Y', label: '+Y' }, { value: '+Z', label: '+Z' },
          ] },
      ],
      submitLabel: 'Add',
    },
    run: ({ params }) => v4.addAxis({
      origin: [params.x, params.y, params.z],
      direction: params.direction,
    }),
  },
  {
    id: 'ref.point',
    title: 'New Point…',
    group: 'Reference geometry',
    keywords: 'datum construction vertex',
    v1Hidden: true,
    form: {
      title: 'Reference Point',
      fields: [
        { key: 'x', label: 'X', type: 'number', default: 0, unit: 'mm' },
        { key: 'y', label: 'Y', type: 'number', default: 0, unit: 'mm' },
        { key: 'z', label: 'Z', type: 'number', default: 0, unit: 'mm' },
      ],
      submitLabel: 'Add',
    },
    run: ({ params }) => v4.addPoint({ position: [params.x, params.y, params.z] }),
  },

  // ── E4 — Selection + measurement + section ─────────────────────────────
  // The viewport owns the actual state machines (measure overlay,
  // clip-plane gizmo, interference highlight). These palette commands are
  // simple `studio.<flag> = ...` toggles the viewport's effects react to.
  {
    id: 'tools.measure',
    title: 'Measure',
    group: 'Tools',
    hint: 'M',
    keywords: 'distance length area dimension ruler',
    enabled: () => !!studio.viewport,
    run: () => { studio.startMeasure?.(); },
  },
  {
    id: 'view.referencePlanes.toggle',
    title: 'Toggle Reference Planes',
    group: 'View',
    keywords: 'show hide xy xz yz origin sketch planes helpers',
    run: () => { studio.referencePlanesVisible = !studio.referencePlanesVisible; },
  },
  {
    id: 'view.sketches.toggle',
    title: 'Toggle Sketch Visibility',
    group: 'View',
    keywords: 'show hide sketches overlay lines',
    run: () => { studio.sketchOverlayVisible = !studio.sketchOverlayVisible; },
  },
  {
    id: 'view.section.activate',
    title: 'Section View',
    group: 'Tools',
    keywords: 'clip plane slice cutaway cross section',
    enabled: () => !!studio.viewport,
    run: () => { studio.startSection?.(); },
  },
  {
    id: 'view.section.flip',
    title: 'Section: Flip Normal',
    group: 'Tools',
    keywords: 'section clip reverse invert',
    enabled: () => !!studio.sectionFlip,
    run: () => { studio.sectionFlip?.(); },
  },
  {
    id: 'view.section.reset',
    title: 'Section: Reset',
    group: 'Tools',
    keywords: 'section clip default origin',
    enabled: () => !!studio.sectionReset,
    run: () => { studio.sectionReset?.(); },
  },
  {
    id: 'view.section.alignToFace',
    title: 'Section: Align to Selected Face',
    group: 'Tools',
    keywords: 'section clip plane face align snap',
    enabled: () => !!studio.sectionAlignToSelectedFace,
    run: () => { studio.sectionAlignToSelectedFace?.(); },
  },
  {
    id: 'analyze.interference',
    title: 'Check Interference',
    group: 'Tools',
    keywords: 'collision intersect overlap analyze',
    v1Hidden: true,
    enabled: ({ store }) => pickedBodyIds(store).length >= 2,
    run: ({ store }) => { studio.runInterference?.(pickedBodyIds(store)); },
  },
];

/** Cheap substring filter — upgradeable to fzf-style later. */
export function filterCommands(query, ctx) {
  const q = query.trim().toLowerCase();
  return COMMANDS.filter((c) => {
    if (V1 && c.v1Hidden) return false;
    if (c.enabled && !c.enabled(ctx)) return false;
    if (!q) return true;
    const hay = `${c.title} ${c.group} ${c.keywords || ''}`.toLowerCase();
    return hay.includes(q);
  });
}
