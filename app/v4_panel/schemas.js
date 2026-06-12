/**
 * Inspector field schemas — per feature-type descriptions of what's editable.
 *
 * Each entry is a `FieldSpec[]` describing the controls the Inspector renders
 * when the user clicks a feature. The Inspector emits `setFeatureParams`
 * changes to the DocumentStore on every edit — the bridge handles regen.
 *
 * FieldSpec
 * ─────────
 *   {
 *     key:         string,        // params[key]
 *     label:       string,        // display label
 *     kind:        'number' | 'int' | 'bool' | 'enum' | 'vec3' | 'text' | 'expr',
 *     unit?:       'mm' | 'deg' | '',
 *     min?:        number,
 *     max?:        number,
 *     step?:       number,
 *     default?:    any,
 *     options?:    Array<{value, label}>,  // for kind='enum'
 *     readOnly?:   boolean,
 *     hidden?:     (params) => boolean,    // conditionally hide based on sibling values
 *   }
 *
 * `kind: 'expr'` accepts a literal number OR a string expression beginning
 * with `=` (e.g. `"=wall * 2 + 1"`) — same convention as the rest of the
 * v4 document model.
 *
 * Sketch features get an empty schema (sketches are edited via the builder
 * or the future sketch UI; the inspector just shows a read-only summary).
 */

const numField = (key, label, extras = {}) => ({
    key, label, kind: 'number', unit: 'mm', step: 0.5, ...extras,
});

const intField = (key, label, extras = {}) => ({
    key, label, kind: 'int', step: 1, min: 1, ...extras,
});

const angleField = (key, label, extras = {}) => ({
    key, label, kind: 'number', unit: 'deg', step: 5, ...extras,
});

const boolField = (key, label, extras = {}) => ({ key, label, kind: 'bool', ...extras });
const vec3Field = (key, label, extras = {}) => ({ key, label, kind: 'vec3', unit: 'mm', ...extras });
const textField = (key, label, extras = {}) => ({ key, label, kind: 'text', ...extras });
const enumField = (key, label, options, extras = {}) => ({ key, label, kind: 'enum', options, ...extras });

export const SCHEMAS = {
    // ── Primitives ─────────────────────────────────────────────────────────
    Box: [
        numField('length', 'Length', { min: 0.001 }),
        numField('width',  'Width',  { min: 0.001 }),
        numField('height', 'Height', { min: 0.001 }),
        boolField('centered', 'Centered'),
    ],
    Cylinder: [
        numField('radius', 'Radius', { min: 0.001 }),
        numField('height', 'Height', { min: 0.001 }),
        boolField('centered', 'Centered'),
    ],
    Sphere: [
        numField('radius', 'Radius', { min: 0.001 }),
    ],
    Torus: [
        numField('majorRadius', 'Major Radius', { min: 0.001 }),
        numField('minorRadius', 'Minor Radius', { min: 0.001 }),
    ],

    Helix: [
        numField('pitch',  'Pitch',  { min: 0.001 }),
        numField('height', 'Height', { min: 0.001 }),
        numField('radius', 'Radius', { min: 0.001 }),
        angleField('coneAngle', 'Cone Angle', { min: 0, max: 89 }),
        boolField('lefthand', 'Left-handed'),
    ],

    // ── Sketch-based ───────────────────────────────────────────────────────
    Extrude: [
        numField('amount', 'Distance', { min: 0.001 }),
        boolField('both', 'Both directions'),
        angleField('taper', 'Taper', { min: -45, max: 45, step: 1 }),
    ],
    Revolve: [
        angleField('angle', 'Angle', { min: 1, max: 360 }),
    ],
    // Sweep has no scalar params — the path is wired via inputs.
    Loft: [
        boolField('ruled', 'Ruled (linear)'),
    ],
    ImportSTEP: [
        textField('path', 'File path'),
    ],

    // ── Modify ─────────────────────────────────────────────────────────────
    Fillet: [
        numField('radius', 'Radius', { min: 0.001 }),
    ],
    Chamfer: [
        numField('length',  'Length',  { min: 0.001 }),
        numField('length2', 'Length 2 (asym)', { min: 0.001 }),
    ],
    Shell: [
        numField('thickness', 'Thickness', { min: 0.001 }),
    ],
    Draft: [
        angleField('angle', 'Angle', { min: 0, max: 89 }),
    ],
    Hole: [
        numField('diameter', 'Diameter', { min: 0.001 }),
        numField('depth',    'Depth',    { min: 0.001 }),
        boolField('through', 'Through'),
        enumField('type', 'Type', [
            { value: 'simple',       label: 'Simple' },
            { value: 'counterbore',  label: 'Counterbore' },
            { value: 'countersink',  label: 'Countersink' },
        ]),
        // Conditional: counter-bore + countersink need a head diameter
        numField('counterDia',   'Head Diameter', {
            min: 0.001,
            hidden: (params) => params.type === 'simple' || params.type == null,
        }),
        // Counterbore needs an explicit head depth; countersink derives it from angle
        numField('counterDepth', 'Head Depth', {
            min: 0.001,
            hidden: (params) => params.type !== 'counterbore',
        }),
    ],
    Thread: [
        enumField('spec', 'Size', [
            { value: 'M2',   label: 'M2'   },
            { value: 'M2.5', label: 'M2.5' },
            { value: 'M3',   label: 'M3'   },
            { value: 'M4',   label: 'M4'   },
            { value: 'M5',   label: 'M5'   },
            { value: 'M6',   label: 'M6'   },
            { value: 'M8',   label: 'M8'   },
            { value: 'M10',  label: 'M10'  },
            { value: 'M12',  label: 'M12'  },
            { value: 'M16',  label: 'M16'  },
            { value: 'M20',  label: 'M20'  },
        ]),
        numField('length', 'Length', { min: 0.001 }),
    ],
    Offset3D: [
        numField('amount', 'Amount'),
    ],

    // ── Patterns ───────────────────────────────────────────────────────────
    LinearPattern: [
        intField('count', 'Count'),
        numField('spacing', 'Spacing'),
    ],
    CircularPattern: [
        intField('count', 'Count'),
        angleField('angle', 'Angle', { min: 1, max: 360 }),
    ],
    PathPattern: [
        intField('count', 'Count'),
    ],
    // Mirror has no scalar params (plane lives in inputs)

    // ── Booleans — typically have no scalar params ─────────────────────────

    // ── Transforms ─────────────────────────────────────────────────────────
    Move: [
        vec3Field('vector', 'Translation'),
    ],
    Rotate: [
        angleField('angle', 'Angle', { min: -360, max: 360 }),
    ],
    Scale: [
        { key: 'factor', label: 'Factor', kind: 'number', step: 0.1, min: 0.001 },
    ],

    // ── Reference geometry ─────────────────────────────────────────────────
    Plane: [
        vec3Field('origin', 'Origin'),
        vec3Field('normal', 'Normal'),
    ],
    Axis: [
        vec3Field('origin',   'Origin'),
        vec3Field('direction','Direction'),
    ],
    Point: [
        vec3Field('position', 'Position'),
    ],

    // ── Sketch / Variable / Scripted ────────────────────────────────────────
    Sketch:       [],   // edited via the builder; future sketch UI takes over
    SketchOnFace: [],
    Parameter: [
        textField('name', 'Name', { readOnly: true }),
        { key: 'value', label: 'Value', kind: 'number', step: 1 },
    ],
    Equation: [
        textField('name',       'Name', { readOnly: true }),
        textField('expression', 'Expression'),
    ],
};

/**
 * Return the schema for `featureType`, or an empty array if no editable
 * params are defined.
 */
export function schemaFor(featureType) {
    return SCHEMAS[featureType] || [];
}

/**
 * Validate a candidate value against a field spec. Returns the coerced
 * value on success (string→number, expression strings passed through),
 * or throws an Error explaining what's wrong.
 *
 *   coerceField(field, '12')   → 12
 *   coerceField(field, '=w*2') → '=w*2'    (expression)
 *   coerceField(field, 'abc')  → throws
 */
export function coerceField(field, raw) {
    if (field.readOnly) throw new Error(`field "${field.key}" is read-only`);
    switch (field.kind) {
        case 'number': {
            if (typeof raw === 'string' && raw.trim().startsWith('=')) return raw.trim();
            const n = Number(raw);
            if (!Number.isFinite(n)) throw new Error(`field "${field.key}" expects a number, got "${raw}"`);
            if (field.min != null && n < field.min) throw new Error(`field "${field.key}" must be ≥ ${field.min}`);
            if (field.max != null && n > field.max) throw new Error(`field "${field.key}" must be ≤ ${field.max}`);
            return n;
        }
        case 'int': {
            const n = Math.round(Number(raw));
            if (!Number.isFinite(n)) throw new Error(`field "${field.key}" expects an integer, got "${raw}"`);
            if (field.min != null && n < field.min) throw new Error(`field "${field.key}" must be ≥ ${field.min}`);
            if (field.max != null && n > field.max) throw new Error(`field "${field.key}" must be ≤ ${field.max}`);
            return n;
        }
        case 'bool': {
            if (typeof raw === 'boolean') return raw;
            if (raw === 'true' || raw === 1 || raw === '1') return true;
            if (raw === 'false' || raw === 0 || raw === '0' || raw === '') return false;
            throw new Error(`field "${field.key}" expects a boolean`);
        }
        case 'enum': {
            const values = (field.options || []).map(o => o.value);
            if (!values.includes(raw)) throw new Error(`field "${field.key}" must be one of ${values.join(',')}`);
            return raw;
        }
        case 'vec3': {
            if (Array.isArray(raw) && raw.length === 3) {
                const [x, y, z] = raw.map(Number);
                if ([x, y, z].some(v => !Number.isFinite(v))) {
                    throw new Error(`field "${field.key}" vec3 components must be numbers`);
                }
                return [x, y, z];
            }
            throw new Error(`field "${field.key}" expects a [x, y, z] tuple`);
        }
        case 'text':
        case 'expr':
            return String(raw);
        default:
            throw new Error(`field "${field.key}" has unknown kind "${field.kind}"`);
    }
}

/**
 * Build a default-value `params` map for a feature type, useful when the
 * caller doesn't supply complete params.
 */
export function defaultParamsFor(featureType) {
    const schema = schemaFor(featureType);
    const out = {};
    for (const f of schema) {
        if (f.default !== undefined) { out[f.key] = f.default; continue; }
        switch (f.kind) {
            case 'number':
            case 'int':    out[f.key] = f.min ?? 0; break;
            case 'bool':   out[f.key] = false;     break;
            case 'enum':   out[f.key] = f.options?.[0]?.value; break;
            case 'vec3':   out[f.key] = [0, 0, 0]; break;
            case 'text':
            case 'expr':   out[f.key] = '';        break;
        }
    }
    return out;
}

/**
 * For UI labelling: friendly type names ("Box" → "Box", "LinearPattern" →
 * "Linear Pattern", "CircularPattern" → "Circ Pattern", …). Falls back to
 * the raw type when nothing better is known.
 */
const TYPE_LABELS = {
    Box: 'Box', Cylinder: 'Cylinder', Sphere: 'Sphere', Torus: 'Torus',
    Sketch: 'Sketch', SketchOnFace: 'Sketch on Face', ProjectEdges: 'Project Edges',
    Extrude: 'Extrude', Revolve: 'Revolve', Sweep: 'Sweep', Loft: 'Loft',
    ImportSTEP: 'Import STEP',
    Fillet: 'Fillet', Chamfer: 'Chamfer', Shell: 'Shell', Draft: 'Draft',
    Hole: 'Hole', Thread: 'Thread', Offset3D: 'Offset Body',
    LinearPattern: 'Linear Pattern', CircularPattern: 'Circ Pattern',
    PathPattern: 'Path Pattern', Mirror: 'Mirror',
    Union: 'Union', Cut: 'Cut', Intersect: 'Intersect', Split: 'Split',
    MoveFace: 'Move Face', PushPullFace: 'Push/Pull Face',
    DeleteFace: 'Delete Face', ReplaceFace: 'Replace Face',
    Move: 'Move', Rotate: 'Rotate', Scale: 'Scale', Align: 'Align',
    Plane: 'Plane', Axis: 'Axis', Point: 'Point',
    InsertComponent: 'Insert Component',
    Parameter: 'Parameter', Equation: 'Equation', BuildScript: 'Build Script',
};
export function typeLabel(featureType) {
    return TYPE_LABELS[featureType] || featureType;
}
