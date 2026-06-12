/**
 * Tiny inline-SVG icons for the timeline strip.
 *
 * One per feature *category*; the timeline maps feature type → category →
 * icon. Returned as raw SVG strings so the timeline can shove them into
 * innerHTML without a framework.
 *
 * We deliberately stay minimal — these are 16×16 glyphs, not the polished
 * 24× icons in the v4 panel's "Add Feature" menu. The goal is at-a-glance
 * recognition along a tight horizontal strip.
 */

const SVG_ATTRS = `width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;

const ICONS = {
    box:        `<svg ${SVG_ATTRS}><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/></svg>`,
    cylinder:   `<svg ${SVG_ATTRS}><ellipse cx="12" cy="5" rx="7" ry="2.5"/><path d="M5 5v14a7 2.5 0 0 0 14 0V5"/></svg>`,
    sphere:     `<svg ${SVG_ATTRS}><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="9" ry="3.5"/></svg>`,
    sketch:     `<svg ${SVG_ATTRS}><path d="M4 20l4-2 11-11-2-2L6 16l-2 4z"/></svg>`,
    extrude:    `<svg ${SVG_ATTRS}><rect x="4" y="10" width="10" height="10"/><path d="M14 10l6-6M14 20l6-6M4 10l6-6"/></svg>`,
    revolve:    `<svg ${SVG_ATTRS}><path d="M12 3v18"/><path d="M16 6c0 2-1.8 4-4 4s-4-2-4-4"/><path d="M16 18c0-2-1.8-4-4-4s-4 2-4 4"/></svg>`,
    fillet:     `<svg ${SVG_ATTRS}><path d="M4 20V12a8 8 0 0 1 8-8h8"/></svg>`,
    chamfer:    `<svg ${SVG_ATTRS}><path d="M4 20V14L14 4h6"/></svg>`,
    shell:      `<svg ${SVG_ATTRS}><rect x="3" y="3" width="18" height="18" rx="1"/><rect x="7" y="7" width="10" height="10" rx="1"/></svg>`,
    hole:       `<svg ${SVG_ATTRS}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/></svg>`,
    pattern:    `<svg ${SVG_ATTRS}><rect x="3" y="3" width="6" height="6"/><rect x="15" y="3" width="6" height="6"/><rect x="3" y="15" width="6" height="6"/><rect x="15" y="15" width="6" height="6"/></svg>`,
    mirror:     `<svg ${SVG_ATTRS}><path d="M12 3v18"/><path d="M8 8L4 12l4 4"/><path d="M16 8l4 4-4 4"/></svg>`,
    boolean:    `<svg ${SVG_ATTRS}><circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/></svg>`,
    transform:  `<svg ${SVG_ATTRS}><path d="M4 12h16"/><path d="M12 4v16"/><path d="M8 8l-4 4 4 4M16 8l4 4-4 4M8 8l4-4 4 4M8 16l4 4 4-4"/></svg>`,
    plane:      `<svg ${SVG_ATTRS}><path d="M3 7l9-3 9 3v10l-9 3-9-3V7z"/></svg>`,
    axis:       `<svg ${SVG_ATTRS}><line x1="3" y1="21" x2="21" y2="3"/><circle cx="12" cy="12" r="1.5"/></svg>`,
    point:      `<svg ${SVG_ATTRS}><circle cx="12" cy="12" r="3"/></svg>`,
    parameter:  `<svg ${SVG_ATTRS}><path d="M4 9h16M4 15h16"/><path d="M10 4l-4 16M18 4l-4 16"/></svg>`,
    feature:    `<svg ${SVG_ATTRS}><circle cx="12" cy="12" r="9"/></svg>`,
};

const TYPE_TO_CATEGORY = {
    Box: 'box', Cylinder: 'cylinder', Sphere: 'sphere', Torus: 'sphere',
    Helix: 'sketch',
    Sketch: 'sketch', SketchOnFace: 'sketch', ProjectEdges: 'sketch',
    Extrude: 'extrude', Revolve: 'revolve', Sweep: 'extrude', Loft: 'extrude',
    ImportSTEP: 'box',
    Fillet: 'fillet', Chamfer: 'chamfer', Shell: 'shell', Draft: 'chamfer',
    Hole: 'hole', Thread: 'hole', Offset3D: 'shell',
    LinearPattern: 'pattern', CircularPattern: 'pattern', PathPattern: 'pattern',
    Mirror: 'mirror',
    Union: 'boolean', Cut: 'boolean', Intersect: 'boolean', Split: 'boolean',
    Move: 'transform', Rotate: 'transform', Scale: 'transform', Align: 'transform',
    MoveFace: 'transform', PushPullFace: 'transform',
    DeleteFace: 'transform', ReplaceFace: 'transform',
    Plane: 'plane', Axis: 'axis', Point: 'point',
    Parameter: 'parameter', Equation: 'parameter', BuildScript: 'parameter',
    InsertComponent: 'box',
};

/** Return an SVG string for the given feature type. Falls back to a circle. */
export function iconForType(featureType) {
    const cat = TYPE_TO_CATEGORY[featureType] || 'feature';
    return ICONS[cat] || ICONS.feature;
}

/** Return the human-readable category label, useful for tooltips. */
export function categoryForType(featureType) {
    return TYPE_TO_CATEGORY[featureType] || 'feature';
}
