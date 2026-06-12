/**
 * Selection-driven constraint application.
 *
 * Pure helpers that take a selection (an array of entity ids) plus the
 * sketch and either:
 *   - return a Constraint record ready for `addConstraint`, OR
 *   - return null with a reason string explaining why the signature didn't
 *     match (used by the UI to disable the corresponding button).
 *
 * The selection is *unordered* — every helper tries the necessary permutations
 * (e.g. `tangent` accepts {line, circle} in either order).
 *
 * No DOM, no Three.js — fully testable in isolation.
 */

import { ENTITY_KIND } from './entities.js';
import {
    coincident, horizontal, vertical, parallel, perpendicular, tangent,
    equalLength, equalRadius, midpoint, pointOnLine, pointOnCircle, symmetric,
} from './constraints.js';

/** @typedef {{ ok: true, constraint: object } | { ok: false, reason: string }} ApplyResult */

const ent = (sketch, id) => sketch && sketch.entities ? sketch.entities[id] : null;
const isKind = (e, kind) => e && e.kind === kind;

function partition(selection, sketch) {
    const points    = [];
    const lines     = [];
    const circles   = [];   // includes arcs
    const other     = [];
    for (const id of selection) {
        const e = ent(sketch, id);
        if (!e) continue;
        if (e.kind === ENTITY_KIND.POINT)    points.push(e);
        else if (e.kind === ENTITY_KIND.LINE) lines.push(e);
        else if (e.kind === ENTITY_KIND.CIRCLE || e.kind === ENTITY_KIND.ARC) circles.push(e);
        else other.push(e);
    }
    return { points, lines, circles, other };
}

// ── Geometric ──────────────────────────────────────────────────────────────

export function tryHorizontal(selection, sketch) {
    const { lines } = partition(selection, sketch);
    if (lines.length !== 1) return { ok: false, reason: 'Select one line.' };
    return { ok: true, constraint: horizontal(lines[0].id) };
}

export function tryVertical(selection, sketch) {
    const { lines } = partition(selection, sketch);
    if (lines.length !== 1) return { ok: false, reason: 'Select one line.' };
    return { ok: true, constraint: vertical(lines[0].id) };
}

export function tryParallel(selection, sketch) {
    const { lines } = partition(selection, sketch);
    if (lines.length !== 2) return { ok: false, reason: 'Select two lines.' };
    return { ok: true, constraint: parallel(lines[0].id, lines[1].id) };
}

export function tryPerpendicular(selection, sketch) {
    const { lines } = partition(selection, sketch);
    if (lines.length !== 2) return { ok: false, reason: 'Select two lines.' };
    return { ok: true, constraint: perpendicular(lines[0].id, lines[1].id) };
}

export function tryTangent(selection, sketch) {
    const { lines, circles } = partition(selection, sketch);
    if (lines.length === 1 && circles.length === 1) {
        return { ok: true, constraint: tangent(lines[0].id, circles[0].id) };
    }
    if (circles.length === 2 && lines.length === 0) {
        return { ok: true, constraint: tangent(circles[0].id, circles[1].id) };
    }
    return { ok: false, reason: 'Select a line + a circle (or two circles).' };
}

export function tryCoincident(selection, sketch) {
    const { points } = partition(selection, sketch);
    if (points.length !== 2) return { ok: false, reason: 'Select two points.' };
    return { ok: true, constraint: coincident(points[0].id, points[1].id) };
}

export function tryEqualLength(selection, sketch) {
    const { lines } = partition(selection, sketch);
    if (lines.length !== 2) return { ok: false, reason: 'Select two lines.' };
    return { ok: true, constraint: equalLength(lines[0].id, lines[1].id) };
}

export function tryEqualRadius(selection, sketch) {
    const { circles, lines } = partition(selection, sketch);
    if (circles.length !== 2 || lines.length) return { ok: false, reason: 'Select two circles/arcs.' };
    return { ok: true, constraint: equalRadius(circles[0].id, circles[1].id) };
}

export function tryMidpoint(selection, sketch) {
    const { points, lines } = partition(selection, sketch);
    if (points.length !== 1 || lines.length !== 1) return { ok: false, reason: 'Select one point + one line.' };
    return { ok: true, constraint: midpoint(points[0].id, lines[0].id) };
}

export function tryPointOnLine(selection, sketch) {
    const { points, lines } = partition(selection, sketch);
    if (points.length !== 1 || lines.length !== 1) return { ok: false, reason: 'Select one point + one line.' };
    return { ok: true, constraint: pointOnLine(points[0].id, lines[0].id) };
}

export function tryPointOnCircle(selection, sketch) {
    const { points, circles } = partition(selection, sketch);
    if (points.length !== 1 || circles.length !== 1) return { ok: false, reason: 'Select one point + one circle/arc.' };
    return { ok: true, constraint: pointOnCircle(points[0].id, circles[0].id) };
}

export function trySymmetric(selection, sketch) {
    const { points, lines } = partition(selection, sketch);
    if (points.length !== 2 || lines.length !== 1) return { ok: false, reason: 'Select two points + one mirror line.' };
    return { ok: true, constraint: symmetric(points[0].id, points[1].id, lines[0].id) };
}

// ── Registry — UI iterates over this for button rendering ──────────────────

/**
 * Per-button metadata. `try` is the validation+build helper above; the UI
 * runs it on every selection change to decide whether the button is active.
 */
export const CONSTRAINT_TOOLS = Object.freeze([
    { key: 'horizontal',    label: 'Horizontal',    symbol: 'H',  try: tryHorizontal },
    { key: 'vertical',      label: 'Vertical',      symbol: 'V',  try: tryVertical },
    { key: 'parallel',      label: 'Parallel',      symbol: '∥',  try: tryParallel },
    { key: 'perpendicular', label: 'Perpendicular', symbol: '⊥',  try: tryPerpendicular },
    { key: 'tangent',       label: 'Tangent',       symbol: 'T',  try: tryTangent },
    { key: 'coincident',    label: 'Coincident',    symbol: '◉',  try: tryCoincident },
    { key: 'equal-length',  label: 'Equal Length',  symbol: '=',  try: tryEqualLength },
    { key: 'equal-radius',  label: 'Equal Radius',  symbol: 'R=', try: tryEqualRadius },
    { key: 'midpoint',      label: 'Midpoint',      symbol: '▸',  try: tryMidpoint },
    { key: 'on-line',       label: 'On Line',       symbol: '•—', try: tryPointOnLine },
    { key: 'on-circle',     label: 'On Circle',     symbol: '•○', try: tryPointOnCircle },
    { key: 'symmetric',     label: 'Symmetric',     symbol: '⇋',  try: trySymmetric },
]);

/**
 * Convenience: build a snapshot {key → ApplyResult} for the current selection.
 * The UI uses this to render each button's enabled state in one pass.
 */
export function evaluateAll(selection, sketch) {
    const out = {};
    for (const tool of CONSTRAINT_TOOLS) {
        out[tool.key] = tool.try(selection, sketch);
    }
    return out;
}
