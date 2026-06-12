/**
 * Per-feature visual identity — color + small SVG glyph.
 *
 * Centralises the icon-and-color choice used by:
 *   - the feature tree (left side of every row)
 *   - the timeline (chip glyph + chip accent)
 *   - the inspector head (type chip)
 *
 * Colors follow a Fusion-360-style palette where each *category* gets a
 * distinct hue, so a glance at the tree tells you the broad shape of the
 * history without reading names.
 */

import { categoryForType, iconForType as _smallIcon } from '../timeline/icons.js';

const CATEGORY_COLORS = {
    box:       '#3b9eff',  // primitives — cool blue
    cylinder:  '#3b9eff',
    sphere:    '#3b9eff',
    sketch:    '#c084fc',  // sketches — violet
    extrude:   '#22c55e',  // additive ops — green
    revolve:   '#22c55e',
    fillet:    '#f59e0b',  // modify — amber
    chamfer:   '#f59e0b',
    shell:     '#f59e0b',
    hole:      '#fb7185',  // subtractive — rose
    pattern:   '#a3e635',  // pattern/mirror — lime
    mirror:    '#a3e635',
    boolean:   '#fb923c',  // booleans — saffron (matches brand)
    transform: '#94a3b8',  // direct edit — slate
    plane:     '#64d2ff',  // construction — sky
    axis:      '#64d2ff',
    point:     '#64d2ff',
    parameter: '#e5e7eb',  // metadata — neutral
    feature:   '#a8a29e',  // fallback
};

/**
 * Same glyphs as the timeline, but exported behind a stable name so the
 * tree can adopt them without reaching across modules.
 */
export function glyphForType(featureType) {
    return _smallIcon(featureType);
}

/**
 * Hex color for the feature's category. Use to tint a left accent stripe,
 * a chip border, or the inspector header.
 */
export function colorForType(featureType) {
    const cat = categoryForType(featureType);
    return CATEGORY_COLORS[cat] || CATEGORY_COLORS.feature;
}

/**
 * Build a self-contained badge: a colored square that wraps the type glyph.
 * Returns an HTML string suitable for `innerHTML`. The badge inherits its
 * size from font-size unless overridden.
 *
 *   <span class="pf4-fv-badge" style="--fv-color: …">{glyph}</span>
 *
 * The host stylesheet provides `.pf4-fv-badge` layout.
 */
export function typeBadgeHtml(featureType, opts = {}) {
    const color = colorForType(featureType);
    const glyph = glyphForType(featureType);
    const size  = opts.size || 18;
    return (
        `<span class="pf4-fv-badge" style="--fv-color:${color};width:${size}px;height:${size}px;">${glyph}</span>`
    );
}

export { categoryForType };
