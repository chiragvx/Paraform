/**
 * BodyHighlightLayer — Fusion-style full-body tint for the picking pipeline.
 *
 * Renders two states on top of the bridge's rendered body group:
 *
 *   - HOVER:    warm orange (#FF8C28) — used during rubber-band drag to
 *               preview what would be selected if the user released now.
 *               Also used for single-cursor hover on a body (optional).
 *
 *   - SELECTED: saturated blue (#3F8DFF) — applied after a commit.
 *               Replaces the body's base material until cleared.
 *
 * The layer caches each mesh's original material the first time it tints
 * it, and restores from cache when the tint is removed. Hover and selected
 * tints don't stack — selection always wins.
 *
 *   layer.setSelected([objA, objB])   // commits blue tint
 *   layer.setHovered([objC])          // overlays orange (if not selected)
 *   layer.clearHover()                // restores hover meshes
 *   layer.clearAll()                  // restores everything
 *
 * The layer is dumb about descriptors — callers pass the Three.js objects.
 * `selectionToObjects(selection, root)` is a helper that walks `root` and
 * collects every mesh whose `userData.descriptor` is in the selection set.
 */

import * as THREE from 'three';

// Fusion-style: hover is a subtle warm lightening of the body, not a saturated
// recolor. Selection is a clearly distinct blue. Emissive is low so the body's
// own shading still reads under the tint.
const HOVER_COLOR     = 0xb89070;   // warm peach / desaturated copper
const SELECTED_COLOR  = 0x3f8dff;   // saturated blue (matches Fusion select)
const HOVER_EMISSIVE  = 0x4a2810;   // warm low-key glow
const SELECTED_EMISSIVE = 0x102648;
const TINT_OPACITY    = 1.0;        // fully opaque — preserves silhouette
const HOVER_EMISSIVE_INTENSITY    = 0.18;
const SELECTED_EMISSIVE_INTENSITY = 0.42;

const _origKey = '__pf4_origMaterial';
const _stateKey = '__pf4_highlightState';   // 'hover' | 'selected' | undefined

export class BodyHighlightLayer {
    constructor() {
        this._hovered  = new Set();
        this._selected = new Set();
        this._hoverMat = this._makeTintMaterial(HOVER_COLOR,    HOVER_EMISSIVE,    HOVER_EMISSIVE_INTENSITY);
        this._selMat   = this._makeTintMaterial(SELECTED_COLOR, SELECTED_EMISSIVE, SELECTED_EMISSIVE_INTENSITY);
    }

    /** Replace the selected set. Pass an array of Object3Ds. */
    setSelected(objects) {
        const next = new Set(objects);
        // Restore objects that are no longer selected (and not hovered either).
        for (const obj of this._selected) {
            if (!next.has(obj)) this._restore(obj);
        }
        // Apply blue to newcomers.
        for (const obj of next) {
            if (!this._selected.has(obj)) this._apply(obj, 'selected');
        }
        this._selected = next;
        // Selected wins — any hover-only mesh becomes orange again.
        this._reapplyHover();
    }

    /** Replace the hover set. Selected entries keep their blue. */
    setHovered(objects) {
        const next = new Set(objects);
        for (const obj of this._hovered) {
            if (next.has(obj)) continue;
            // No longer hovered — if also not selected, restore.
            if (!this._selected.has(obj)) this._restore(obj);
        }
        for (const obj of next) {
            if (!this._hovered.has(obj) && !this._selected.has(obj)) this._apply(obj, 'hover');
        }
        this._hovered = next;
    }

    clearHover() { this.setHovered([]); }
    clearSelection() { this.setSelected([]); }
    clearAll()  { this.setHovered([]); this.setSelected([]); }

    dispose() {
        this.clearAll();
        this._hoverMat.dispose();
        this._selMat.dispose();
    }

    // ── Internals ──────────────────────────────────────────────────────────

    _makeTintMaterial(color, emissive, emissiveIntensity = 0.25) {
        // PolygonOffset keeps the bridge's edge-overlay lines above the
        // tinted surface so edges remain visible when a body is hovered or
        // selected. Opacity stays at 1.0 so the silhouette reads cleanly;
        // tinting comes from a softened diffuse + low-key emissive.
        return new THREE.MeshStandardMaterial({
            color,
            emissive,
            emissiveIntensity,
            metalness: 0.18,
            roughness: 0.55,
            transparent: false,
            opacity: TINT_OPACITY,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits:  1,
        });
    }

    _apply(obj, kind) {
        obj.traverse?.((node) => {
            if (!node.isMesh) return;
            if (!node[_origKey]) node[_origKey] = node.material;
            node.material = (kind === 'selected') ? this._selMat : this._hoverMat;
            node[_stateKey] = kind;
        });
    }

    _restore(obj) {
        obj.traverse?.((node) => {
            if (!node.isMesh) return;
            if (node[_origKey]) {
                node.material = node[_origKey];
                delete node[_origKey];
            }
            delete node[_stateKey];
        });
    }

    _reapplyHover() {
        // After a selection set change, every previously-hovered mesh that's
        // still hovered but no longer selected should re-show orange.
        for (const obj of this._hovered) {
            if (this._selected.has(obj)) continue;
            this._apply(obj, 'hover');
        }
    }
}

/**
 * Walk `root` and return every top-level body group whose userData.descriptor
 * matches an entry in `selection`. Tag-on-render in lib/document/bridge.js
 * puts the descriptor on each Mesh; this helper collects the OWNING group
 * (one tint per body, not per face).
 *
 * For the v4 bridge today the "owning group" is just the `bodyTransform`
 * wrap — every mesh inherits one descriptor. We return the wrap itself if
 * any of its meshes match. Multi-body docs will return multiple groups
 * when each gets its own wrap-equivalent in a future refactor.
 *
 * @param {object} selection — PickingSelection
 * @param {THREE.Object3D} root — bridge.bodyTransform or scene
 * @returns {THREE.Object3D[]}
 */
export function selectionToObjects(selection, root) {
    if (!selection || !root) return [];
    const out = new Set();
    const ids = new Set();
    for (const desc of selection.descriptors()) {
        if (!desc) continue;
        // Body descriptors carry featureId; face/edge descriptors carry
        // .feature (legacy) or .featureId — accept both.
        const fid = desc.featureId || desc.feature;
        if (fid) ids.add(fid);
    }
    if (ids.size === 0) return [];
    // The bridge attaches descriptors on the wrap and every mesh under it.
    // If the root IS the wrap (bodyTransform), return [root] when its
    // featureId is in the set.
    if (root.userData && root.userData.featureId && ids.has(root.userData.featureId)) {
        out.add(root);
    }
    root.traverse?.((node) => {
        if (node.isMesh && node.userData.featureId && ids.has(node.userData.featureId)) {
            // Prefer the bodyTransform wrap (named `__v4_glb_wrap__`) to a
            // bare mesh — tint applies via traversal anyway, so picking the
            // wrap means the whole assembly retints as one.
            const wrap = findAncestor(node, (a) => a.name === '__v4_glb_wrap__');
            out.add(wrap || node);
        }
    });
    return [...out];
}

function findAncestor(node, predicate) {
    let p = node.parent;
    while (p) {
        if (predicate(p)) return p;
        p = p.parent;
    }
    return null;
}
