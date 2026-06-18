/**
 * Document model (v4) — type definitions and factories.
 *
 * The v4 document differs from the v3 tree:
 *   - Features live in a Map keyed by id (was: linear nodes array)
 *   - Dependencies are explicit via `inputs[role] = ref` (was: implicit via array order)
 *   - Edits become append-only Change records in `changelog` (was: in-place mutation)
 *   - The live state is a *fold* of the changelog up to `head`
 *   - Rollback = move `head` earlier. Branching = multiple changes share a parent.
 *
 * For UI display we keep `featureOrder` (an authored order separate from dep order).
 * For execution we derive a topological order from `inputs` — see `dag.js`.
 *
 * Pure data. No DOM, no THREE.
 */

// ── Categories & feature types (mirror lib/tree/types.js so v3 → v4 migrates cleanly) ──
export const CATEGORIES = {
    SKETCH:    'sketch',
    CREATE:    'create',
    MODIFY:    'modify',
    PATTERN:   'pattern',
    COMBINE:   'combine',
    DIRECT:    'direct',
    TRANSFORM: 'transform',
    REFERENCE: 'reference',
    ASSEMBLY:  'assembly',
    VARIABLE:  'variable',
    SCRIPTED:  'scripted',
};

/**
 * partRef (optional) — links a host feature to a standard-parts catalog entry
 * for relational DFM checks (spec 13). Lives on `feature.params.partRef`.
 *
 *   {
 *     entryId:  string,                      // catalog id, e.g. 'bearing-608'
 *     role:     'bore' | 'shaft' | 'clearance' | 'tap' | 'seat-width',
 *     fitClass: 'H7/g6' | 'H7/h6' | 'H7/k6' | null  // null → profile default
 *   }
 *
 * Recognised on feature types that can host a mating standard part:
 *   - Cylinder (bore for a bearing OD, shaft for a bearing ID, seat-width host)
 *   - Hole     (clearance hole for a fastener, tap for a threaded fastener)
 *   - Box      (slot-shaped bore — out of scope for v1 but the field is tolerated)
 *
 * Only the fit check (src/lib/dfm/checks.js) consumes this; emit / kernel /
 * dag are agnostic. Setting partRef does **not** change geometry — it
 * declares mating intent so the DFM runner can verify dimensions against
 * the catalog. Params remain loose objects (no runtime schema validation);
 * the consumer is defensive on missing / malformed fields.
 */
export const FEATURE_TYPES = {
    Sketch:               { category: CATEGORIES.SKETCH,    label: 'Sketch' },
    SketchOnFace:         { category: CATEGORIES.SKETCH,    label: 'Sketch on Face' },
    ProjectEdges:         { category: CATEGORIES.SKETCH,    label: 'Project Edges' },
    Box:                  { category: CATEGORIES.CREATE,    label: 'Box' },
    Cylinder:             { category: CATEGORIES.CREATE,    label: 'Cylinder' },
    Sphere:               { category: CATEGORIES.CREATE,    label: 'Sphere' },
    Torus:                { category: CATEGORIES.CREATE,    label: 'Torus' },
    Extrude:              { category: CATEGORIES.CREATE,    label: 'Extrude' },
    Revolve:              { category: CATEGORIES.CREATE,    label: 'Revolve' },
    Sweep:                { category: CATEGORIES.CREATE,    label: 'Sweep' },
    Loft:                 { category: CATEGORIES.CREATE,    label: 'Loft' },
    Helix:                { category: CATEGORIES.CREATE,    label: 'Helix' },
    Gear:                 { category: CATEGORIES.CREATE,    label: 'Gear' },
    Pulley:               { category: CATEGORIES.CREATE,    label: 'Pulley' },
    Sprocket:             { category: CATEGORIES.CREATE,    label: 'Sprocket' },
    TSlotExtrusion:       { category: CATEGORIES.CREATE,    label: 'T-Slot Extrusion' },
    ScrewBoss:            { category: CATEGORIES.CREATE,    label: 'Screw Boss' },
    Standoff:             { category: CATEGORIES.CREATE,    label: 'Standoff' },
    Fan:                  { category: CATEGORIES.CREATE,    label: 'Fan' },
    MountingPlate:        { category: CATEGORIES.CREATE,    label: 'Mounting Plate' },
    Bracket:              { category: CATEGORIES.CREATE,    label: 'Bracket' },
    ThreadedInsertBoss:   { category: CATEGORIES.CREATE,    label: 'Insert Boss' },
    NutTrap:              { category: CATEGORIES.CREATE,    label: 'Nut Trap' },
    SnapHook:             { category: CATEGORIES.CREATE,    label: 'Snap Hook' },
    BearingPocket:        { category: CATEGORIES.CREATE,    label: 'Bearing Pocket' },
    MotorMount:           { category: CATEGORIES.CREATE,    label: 'Motor Mount' },
    ShaftCoupler:         { category: CATEGORIES.CREATE,    label: 'Shaft Coupler' },
    Wheel:                { category: CATEGORIES.CREATE,    label: 'Wheel' },
    TimingPulley:         { category: CATEGORIES.CREATE,    label: 'Timing Pulley' },
    Hinge:                { category: CATEGORIES.CREATE,    label: 'Hinge' },
    ProjectBox:           { category: CATEGORIES.CREATE,    label: 'Project Box' },
    PCBTray:              { category: CATEGORIES.CREATE,    label: 'PCB Tray' },
    Knob:                 { category: CATEGORIES.CREATE,    label: 'Knob' },
    ImportSTEP:           { category: CATEGORIES.CREATE,    label: 'Import STEP' },
    Fillet:               { category: CATEGORIES.MODIFY,    label: 'Fillet' },
    Chamfer:              { category: CATEGORIES.MODIFY,    label: 'Chamfer' },
    Shell:                { category: CATEGORIES.MODIFY,    label: 'Shell' },
    Draft:                { category: CATEGORIES.MODIFY,    label: 'Draft' },
    Hole:                 { category: CATEGORIES.MODIFY,    label: 'Hole' },
    Thread:               { category: CATEGORIES.MODIFY,    label: 'Thread' },
    CosmeticThread:       { category: CATEGORIES.MODIFY,    label: 'Cosmetic Thread' },
    Offset3D:             { category: CATEGORIES.MODIFY,    label: 'Offset Body' },
    Casing:               { category: CATEGORIES.MODIFY,    label: 'Casing' },
    LinearPattern:        { category: CATEGORIES.PATTERN,   label: 'Linear Pattern' },
    CircularPattern:      { category: CATEGORIES.PATTERN,   label: 'Circ Pattern' },
    PathPattern:          { category: CATEGORIES.PATTERN,   label: 'Path Pattern' },
    Mirror:               { category: CATEGORIES.PATTERN,   label: 'Mirror' },
    Union:                { category: CATEGORIES.COMBINE,   label: 'Union' },
    Cut:                  { category: CATEGORIES.COMBINE,   label: 'Cut' },
    Intersect:            { category: CATEGORIES.COMBINE,   label: 'Intersect' },
    Split:                { category: CATEGORIES.COMBINE,   label: 'Split' },
    SplitFace:            { category: CATEGORIES.COMBINE,   label: 'Split Face' },
    MoveFace:             { category: CATEGORIES.DIRECT,    label: 'Move Face' },
    PushPullFace:         { category: CATEGORIES.DIRECT,    label: 'Push/Pull Face' },
    DeleteFace:           { category: CATEGORIES.DIRECT,    label: 'Delete Face' },
    OffsetFace:           { category: CATEGORIES.DIRECT,    label: 'Offset Face' },
    ReplaceFace:          { category: CATEGORIES.DIRECT,    label: 'Replace Face' },
    Move:                 { category: CATEGORIES.TRANSFORM, label: 'Move' },
    Rotate:               { category: CATEGORIES.TRANSFORM, label: 'Rotate' },
    Scale:                { category: CATEGORIES.TRANSFORM, label: 'Scale' },
    Align:                { category: CATEGORIES.TRANSFORM, label: 'Align' },
    Plane:                { category: CATEGORIES.REFERENCE, label: 'Plane' },
    Axis:                 { category: CATEGORIES.REFERENCE, label: 'Axis' },
    Point:                { category: CATEGORIES.REFERENCE, label: 'Point' },
    ReferenceImage:       { category: CATEGORIES.REFERENCE, label: 'Reference Image' },
    InsertComponent:      { category: CATEGORIES.ASSEMBLY,  label: 'Insert Component' },
    JointRigid:           { category: CATEGORIES.ASSEMBLY,  label: 'Rigid Joint' },
    JointRevolute:        { category: CATEGORIES.ASSEMBLY,  label: 'Revolute Joint' },
    JointSlider:          { category: CATEGORIES.ASSEMBLY,  label: 'Slider Joint' },
    JointCylindrical:     { category: CATEGORIES.ASSEMBLY,  label: 'Cyl Joint' },
    JointPlanar:          { category: CATEGORIES.ASSEMBLY,  label: 'Planar Joint' },
    Parameter:            { category: CATEGORIES.VARIABLE,  label: 'Parameter' },
    Equation:             { category: CATEGORIES.VARIABLE,  label: 'Equation' },
    BuildScript:          { category: CATEGORIES.SCRIPTED,  label: 'Build Script' },
    StandardPart:         { category: CATEGORIES.SCRIPTED,  label: 'Standard Part' },
    ImportedMesh:         { category: CATEGORIES.SCRIPTED,  label: 'Imported Mesh' },
};

// ── Reference kinds (entity queries) ──────────────────────────────────────────
export const REF_KINDS = {
    BODY:   'body',
    FACE:   'face',
    EDGE:   'edge',
    VERTEX: 'vertex',
    PLANE:  'plane',
    AXIS:   'axis',
    SKETCH: 'sketch',
};

// ── ID generation ─────────────────────────────────────────────────────────────
let _featureCounter = 0;
let _changeCounter = 0;
let _paramCounter = 0;
let _assumptionCounter = 0;
let _jointCounter = 0;
let _connectorCounter = 0;
let _mateCounter = 0;
const _now36 = () => Date.now().toString(36);

/** Generate a unique feature id. */
export function newFeatureId(typeHint = 'feat') {
    return `${typeHint.toLowerCase().slice(0, 4)}_${_now36()}_${(++_featureCounter).toString(36)}`;
}

/** Generate a unique change id. Monotonic within a session. */
export function newChangeId() {
    return `ch_${_now36()}_${(++_changeCounter).toString(36)}`;
}

/** Generate a unique parameter id. */
export function newParamId(nameHint = 'p') {
    return `prm_${nameHint.replace(/[^a-zA-Z0-9_]/g, '')}_${(++_paramCounter).toString(36)}`;
}

/** Generate a unique assumption id. */
export function newAssumptionId(sourceHint = 'a') {
    return `asm_${String(sourceHint).slice(0, 4)}_${_now36()}_${(++_assumptionCounter).toString(36)}`;
}

/** Generate a unique joint id (spec 17 v1). */
export function newJointId(kindHint = 'j') {
    return `jnt_${String(kindHint).slice(0, 4)}_${_now36()}_${(++_jointCounter).toString(36)}`;
}

/** Generate a unique connector id (spec 18 v1 — component library). */
export function newConnectorId(kindHint = 'c') {
    return `con_${String(kindHint).slice(0, 4)}_${_now36()}_${(++_connectorCounter).toString(36)}`;
}

/** Generate a unique mate id (Phase 2 — persistent mate records). */
export function newMateId(kindHint = 'm') {
    return `mate_${String(kindHint).slice(0, 4)}_${_now36()}_${(++_mateCounter).toString(36)}`;
}

// ── Assumption record (spec 09 — assumptions manifest) ────────────────────────
/**
 * An AssumptionRecord captures a hidden choice the system (or a model)
 * made while building the document. The user can see them, acknowledge
 * them, or use them as edit handles. Per spec 09 they survive
 * serialize/reload as a top-level `doc.assumptions` array.
 *
 * Field shape:
 *   id            string  — auto if not supplied
 *   source        'extractor' | 'invariant' | 'standard-parts' | 'kernel' | 'user'
 *   kind          string  — short slug, e.g. 'material-grade', 'fastener-length'
 *   detail        string  — human-readable note
 *   defaultUsed   any|null — the value the system applied (e.g. '6061')
 *   alternatives  any[]|null — viable substitutes the consumer may surface
 *   severity      'info' | 'warning'
 *   citation      string|null — optional pointer (spec link, lexicon row)
 *   timestamp     number  — ms epoch
 *   acknowledged  boolean
 *   relatedFeatureId  string|null — Inspector "jump to" hook
 *
 * @param {object} fields
 * @returns {object}
 */
export function makeAssumption({
    id,
    source = 'user',
    kind = 'unspecified',
    detail = '',
    defaultUsed = null,
    alternatives = null,
    severity = 'info',
    citation = null,
    timestamp,
    acknowledged = false,
    relatedFeatureId = null,
} = {}) {
    const allowedSources = new Set(['extractor', 'invariant', 'standard-parts', 'kernel', 'user']);
    const allowedSeverities = new Set(['info', 'warning']);
    return {
        id:           id || newAssumptionId(source),
        source:       allowedSources.has(source) ? source : 'user',
        kind:         String(kind || 'unspecified'),
        detail:       String(detail || ''),
        defaultUsed:  defaultUsed === undefined ? null : defaultUsed,
        alternatives: Array.isArray(alternatives) ? alternatives.slice() : null,
        severity:     allowedSeverities.has(severity) ? severity : 'info',
        citation:     citation == null ? null : String(citation),
        timestamp:    typeof timestamp === 'number' ? timestamp : Date.now(),
        acknowledged: !!acknowledged,
        relatedFeatureId: relatedFeatureId == null ? null : String(relatedFeatureId),
    };
}

// ── Document factory ──────────────────────────────────────────────────────────
/**
 * Create a fresh empty v5 document.
 *
 * v5 adds a `components` map (ComponentId → Component) with a guaranteed
 * `root` entry. v0 of the component tree keeps the tree collapsed: every
 * feature implicitly belongs to `root`. Commits 2/3 will path-qualify
 * featureIds and grow per-component featureOrder lists.
 *
 * @returns {Document}
 */
export function emptyDocument() {
    const now = Date.now();
    return {
        version:       5,
        id:            `doc_${_now36()}`,
        units:         'mm',
        parameters:    {},            // ParamId → ParamDef
        features:      {},            // FeatureId → Feature
        featureOrder:  [],            // FeatureId[] — UI display order (flat in v0)
        bodies:        {},            // BodyId → BodyMetadata
        sketches:      {},            // SketchId → SketchData
        components:    { root: makeComponent({ id: 'root', name: 'Document' }) },
        joints:        {},            // JointId → Joint (spec 17 v1 — kinematics oracle)
        connectors:    {},            // ConnectorId → Connector (spec 18 v1 — component library)
        mates:         {},            // MateId → Mate (Phase 2 — persistent mate records)
        assumptions:   [],            // AssumptionRecord[] — spec 09 manifest
        constructionGeometry: [],
        changelog:     [],            // ChangeRecord[]
        head:          -1,            // index into changelog; -1 = empty
        metadata:      { createdAt: now, updatedAt: now, title: 'Untitled' },
    };
}

// ── Component factory ─────────────────────────────────────────────────────────
/**
 * @typedef {object} Transform
 * @property {[number,number,number]} position
 * @property {[number,number,number]} rotation   — Euler XYZ in radians
 * @property {[number,number,number]} scale
 */

/**
 * @typedef {object} Component
 * @property {string} id
 * @property {string} name
 * @property {string|null} parentId
 * @property {Transform} origin
 */

/** Identity transform (no translation/rotation/uniform scale 1). */
export function identityTransform() {
    return {
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale:    [1, 1, 1],
    };
}

/**
 * Component — a node in the document's component tree. v0 keeps the tree
 * collapsed: every document has a single 'root' component, every feature
 * implicitly belongs to it. Future commits wire path-qualified featureId,
 * per-component origin frames, sub-assemblies, etc.
 *
 * @param {{ id?: string, name?: string, parentId?: string|null, origin?: Transform, kind?: 'component'|'group' }} [opts]
 * @returns {Component}
 */
export function makeComponent({ id, name, parentId = null, origin, kind } = {}) {
    return {
        id:       id || newChangeId('cmp'),   // reuse existing id factory
        name:     name || 'Component',
        parentId,
        // 'group' marks an organisational folder (no body of its own) created
        // when a raw part is first made a parent. Documents saved before this
        // field existed simply lack it — treat missing as 'component'.
        kind:     kind === 'group' ? 'group' : 'component',
        origin:   origin || identityTransform(),
        // Component tree v0 doesn't yet hold per-component featureOrder —
        // every feature is in the flat doc.featureOrder. That moves in
        // commit 2.
    };
}

// ── Feature factory ───────────────────────────────────────────────────────────
/**
 * Build a feature skeleton. Caller supplies params and (optionally) explicit inputs.
 *
 * Foundation 6 / commit 2: every feature carries a `componentId` (defaults to
 * 'root'). The id stays a *flat* string — component membership lives on the
 * feature, the actual component-tree path is *derived* via `componentPathFor`.
 *
 * @param {string} type     — must be a key of FEATURE_TYPES
 * @param {object} params   — feature-specific scalar params
 * @param {object} [inputs] — { roleName: Ref } map of entity queries
 * @param {object} [opts]   — extra feature-level fields (componentId, …)
 * @returns {Feature}
 */
export function makeFeature(type, params = {}, inputs = {}, opts = {}) {
    if (!FEATURE_TYPES[type]) throw new Error(`Unknown feature type: ${type}`);
    let { componentId = 'root' } = opts || {};
    if (componentId == null) componentId = 'root';   // tolerate an explicit null (default sentinel)
    return {
        id:       newFeatureId(type),
        type,
        name:     FEATURE_TYPES[type].label,
        enabled:  true,
        componentId,            // owning component (flat string; path is derived)
        inputs,                 // { roleName: Ref } — explicit dependencies
        params,                 // typed per feature type
        outputs:  { bodies: [], sketches: [], faces: [], edges: [] }, // populated post-eval
        warnings: [],
        notes:    '',
        createdAt: Date.now(),
    };
}

/**
 * Walk the component tree from `componentId` back up to `root`, returning
 * the path as an array of component ids ordered root-first. If the requested
 * id doesn't exist in `doc.components`, falls back to `['root']` so callers
 * never have to null-check.
 *
 * Defensive against parentId cycles (caps walk at the number of components).
 *
 * @param {Document} doc
 * @param {string} componentId
 * @returns {string[]}  e.g. ['root', 'leftPlate']
 */
export function componentPathFor(doc, componentId) {
    const components = doc && doc.components;
    if (!components || typeof components !== 'object' || Array.isArray(components)) {
        return ['root'];
    }
    if (!componentId || !components[componentId]) return ['root'];
    const path = [];
    const max = Object.keys(components).length + 1;
    let cur = componentId;
    let guard = 0;
    while (cur && guard < max) {
        path.unshift(cur);
        const node = components[cur];
        if (!node || !node.parentId) break;
        if (node.parentId === cur) break;       // self-loop guard
        cur = node.parentId;
        guard++;
    }
    if (path[0] !== 'root') path.unshift('root');
    return path;
}

// ── Joint factory (spec 17 v1 — kinematics oracle) ───────────────────────────
/**
 * @typedef {object} Joint
 * @property {string} id
 * @property {'revolute'|'prismatic'|'fixed'} kind
 * @property {string} parent      — parent componentId
 * @property {string} child       — child componentId
 * @property {[number,number,number]} origin   — joint frame origin in parent component coords (mm)
 * @property {[number,number,number]} axis     — unit-ish axis vector; revolute rotates about it, prismatic translates along it
 * @property {{min:number, max:number}} limits — degrees for revolute; mm for prismatic; ignored for fixed
 * @property {{type:string, value:number}|null} [drive] — optional driven pose
 */

const _JOINT_KINDS = new Set(['revolute', 'prismatic', 'fixed']);

/**
 * Build a Joint record (does not persist — caller must `commit(addJointChange(...))`).
 *
 * @param {object} fields
 * @returns {Joint}
 */
export function makeJoint({
    id,
    kind = 'fixed',
    parent = 'root',
    child = null,
    origin = [0, 0, 0],
    axis = [0, 0, 1],
    limits,
    drive = null,
} = {}) {
    const safeKind = _JOINT_KINDS.has(kind) ? kind : 'fixed';
    const safeLimits = limits && typeof limits === 'object'
        ? { min: Number(limits.min), max: Number(limits.max) }
        : (safeKind === 'revolute' ? { min: -180, max: 180 }
           : safeKind === 'prismatic' ? { min: -100, max: 100 }
           : { min: 0, max: 0 });
    return {
        id:    id || newJointId(safeKind),
        kind:  safeKind,
        parent: String(parent || 'root'),
        child: child == null ? null : String(child),
        origin: Array.isArray(origin) && origin.length === 3 ? origin.slice() : [0, 0, 0],
        axis:   Array.isArray(axis) && axis.length === 3 ? axis.slice() : [0, 0, 1],
        limits: safeLimits,
        drive:  drive && typeof drive === 'object'
            ? { type: String(drive.type || 'position'), value: Number(drive.value) || 0 }
            : null,
    };
}

// ── Connector factory (spec 18 v1 — component library + KSP-style mates) ─────
/**
 * The nine-rule connector contract (see CLAUDE.md "The connector contract"):
 *   1. Anchored — part-local mm Z-up, rides the part.
 *   2. Contact — origin is the physical touch point, not the body center.
 *   3. Outward — axis points out toward the mate, not the part's "up."
 *   4. Compatibility explicit — profile > interfaceId > kind+gender+size+mates_with.
 *   5. Gender enforces fit direction — never default to neutral.
 *   6. Size declared — numeric+unit or 'unspecified' sentinel.
 *   7. Atomic — one mating site = one connector, no packed alternatives.
 *   8. Joint declared — fixed | revolute | prismatic.
 *   9. Channels — line/slot: axis = slide dir, normal = seating face out.
 *
 * Immutability: a connector with `locked: true` cannot be patched or removed
 * via the public ops (`updateConnector` / `removeConnector` reject unless the
 * caller passes `{ force: true }`). Library-stamped, profile-generated, and
 * AI-emitted connectors are all locked at creation. System-internal cleanup
 * (replaceComponent, cascade-on-remove) passes `force` explicitly.
 *
 * @typedef {object} Connector
 * @property {string} id
 * @property {string} parent          — owning partId|componentId
 * @property {'thread'|'bore'|'planar'|'shaft'|'tab'|'slot'|'rail'} kind
 * @property {'male'|'female'|'neutral'} gender
 * @property {{ nominal: (string|number), unit: string }} size
 * @property {[number,number,number]} axis    — direction (will be normalised at use-site)
 * @property {[number,number,number]} origin  — connector frame origin in parent-local mm
 * @property {string[]} mates_with  — kinds that this connector accepts as a partner
 * @property {'fixed'|'revolute'|'prismatic'|null} inducedJoint
 * @property {string|null} role         — Phase 2 interface contract: stable role name (e.g. "mount-pattern")
 * @property {string|null} interfaceId  — Phase 2 interface contract: standardized compat id (e.g. "servo-mount-9g")
 * @property {boolean} locked        — true = immutable contract; ops refuse to patch/remove without force.
 * @property {{ description?: string }} metadata
 */

const _CONNECTOR_KINDS = new Set(['thread', 'bore', 'planar', 'shaft', 'tab', 'slot', 'rail']);
const _CONNECTOR_GENDERS = new Set(['male', 'female', 'neutral']);
const _INDUCED_JOINT_KINDS = new Set(['fixed', 'revolute', 'prismatic']);
// Port model v2 — closed sets for the optional richer-mating fields.
const _CONNECTOR_TOPOLOGIES = new Set(['point', 'axis', 'line', 'plane', 'grid']);
const _CONNECTOR_FITS = new Set(['clearance', 'transition', 'press', 'detent', 'thread']);

/**
 * Build a Connector record (does not persist — caller must commit via
 * `addConnector(...)` op or an `addConnectorChange`).
 *
 * @param {Partial<Connector>} fields
 * @returns {Connector}
 */
export function makeConnector({
    id,
    parent = null,
    kind = 'planar',
    gender = 'neutral',
    size = { nominal: 'unspecified', unit: 'mm' },
    axis = [0, 0, 1],
    origin = [0, 0, 0],
    mates_with = [],
    inducedJoint = null,
    role = null,
    interfaceId = null,
    // Port model v2 — richer mating-site description (all optional; legacy
    // point connectors omit them and behave exactly as before).
    topology = null,    // 'point'|'axis'|'line'|'plane'|'grid'
    normal = null,      // [x,y,z] surface/seating normal for line/plane ports
    extent = null,      // { from, to } slide range along `axis` (line ports)
    profile = null,     // cross-section family id, e.g. 'tslot-2020'
    fit = null,         // 'clearance'|'transition'|'press'|'detent'|'thread'
    // Immutability flag — see the contract above. Defaults to false so legacy
    // hand-authored connectors still work; library/profile/AI paths pass true.
    locked = false,
    metadata = {},
} = {}) {
    const safeKind   = _CONNECTOR_KINDS.has(kind)     ? kind   : 'planar';
    const safeGender = _CONNECTOR_GENDERS.has(gender) ? gender : 'neutral';
    const safeInduced = inducedJoint == null
        ? null
        : (_INDUCED_JOINT_KINDS.has(inducedJoint) ? inducedJoint : null);
    const safeSize = (size && typeof size === 'object')
        ? { nominal: size.nominal ?? 'unspecified', unit: size.unit || 'mm' }
        : { nominal: 'unspecified', unit: 'mm' };
    const mates = Array.isArray(mates_with)
        ? mates_with.filter((k) => _CONNECTOR_KINDS.has(k))
        : [];
    return {
        id:      id || newConnectorId(safeKind),
        parent:  parent == null ? null : String(parent),
        kind:    safeKind,
        gender:  safeGender,
        size:    safeSize,
        axis:    Array.isArray(axis) && axis.length === 3 ? axis.slice() : [0, 0, 1],
        origin:  Array.isArray(origin) && origin.length === 3 ? origin.slice() : [0, 0, 0],
        mates_with: mates,
        inducedJoint: safeInduced,
        // Interface contracts (Phase 2) — optional, kept only when supplied.
        role:        (typeof role === 'string' && role.length) ? role : null,
        interfaceId: (typeof interfaceId === 'string' && interfaceId.length) ? interfaceId : null,
        // Port model v2 — optional richer-mating fields, kept only when supplied.
        topology:    _CONNECTOR_TOPOLOGIES.has(topology) ? topology : null,
        normal:      (Array.isArray(normal) && normal.length === 3) ? normal.slice() : null,
        extent:      (extent && typeof extent === 'object' &&
                       Number.isFinite(extent.from) && Number.isFinite(extent.to))
            ? { from: extent.from, to: extent.to } : null,
        profile:     (typeof profile === 'string' && profile.length) ? profile : null,
        fit:         _CONNECTOR_FITS.has(fit) ? fit : null,
        locked:      locked === true,
        metadata: (metadata && typeof metadata === 'object') ? { ...metadata } : {},
    };
}

// ── Mate factory (Phase 2 — persistent mate records) ─────────────────────────
/**
 * A Mate records *why* a part is placed, so a placement can be re-solved when
 * the part is swapped (`replaceComponent`). Where the older path collapsed the
 * solve into an opaque Component.origin transform, the Mate keeps the semantic
 * binding: which host connector, which part connector, the placed component,
 * an optional offset, and the induced joint id/kind.
 *
 * @typedef {object} Mate
 * @property {string} id
 * @property {{ connectorId?: string|null, world?: object|null }} hostConnectorRef
 *           — the host side of the mate. Either an existing host connector id
 *           or a free-placement world frame `{ kind, axis, origin }`.
 * @property {{ connectorId?: string|null, sourceConnectorId?: string|null }} partConnectorRef
 *           — the part side. `connectorId` is the stamped connector id on the
 *           placed component; `sourceConnectorId` is the original connector id
 *           from the PartRecord (stable across re-placement, used by re-bind).
 * @property {string} componentId — the placed component this mate positions.
 * @property {{ position?: number[], rotation?: number[], roll?: number, slide?: number }|null} offset
 *           — optional additional offset applied after the solve (mm / radians).
 *           `roll` (radians about the mate axis / face normal) and `slide`
 *           (mm along a channel run) are the user-driven fitting controls;
 *           the re-solve paths (rotate-to-fit, replaceComponent) feed them
 *           back into solveMateTransform so the orientation/seat survives.
 * @property {{ id?: string|null, kind?: 'fixed'|'revolute'|'prismatic'|null }} inducedJoint
 *           — the joint this mate produced (if any).
 *
 * @param {Partial<Mate>} fields
 * @returns {Mate}
 */
export function makeMate({
    id,
    hostConnectorRef = null,
    partConnectorRef = null,
    componentId = null,
    offset = null,
    inducedJoint = null,
} = {}) {
    const safeHost = (hostConnectorRef && typeof hostConnectorRef === 'object')
        ? {
            connectorId: hostConnectorRef.connectorId != null ? String(hostConnectorRef.connectorId) : null,
            world: (hostConnectorRef.world && typeof hostConnectorRef.world === 'object')
                ? { ...hostConnectorRef.world }
                : null,
        }
        : { connectorId: null, world: null };
    const safePart = (partConnectorRef && typeof partConnectorRef === 'object')
        ? {
            connectorId: partConnectorRef.connectorId != null ? String(partConnectorRef.connectorId) : null,
            sourceConnectorId: partConnectorRef.sourceConnectorId != null
                ? String(partConnectorRef.sourceConnectorId) : null,
        }
        : { connectorId: null, sourceConnectorId: null };
    const safeOffset = (offset && typeof offset === 'object')
        ? {
            position: Array.isArray(offset.position) && offset.position.length === 3
                ? offset.position.slice() : null,
            rotation: Array.isArray(offset.rotation) && offset.rotation.length === 3
                ? offset.rotation.slice() : null,
            ...(Number.isFinite(offset.roll)  ? { roll:  offset.roll }  : {}),
            ...(Number.isFinite(offset.slide) ? { slide: offset.slide } : {}),
        }
        : null;
    const safeInduced = (inducedJoint && typeof inducedJoint === 'object')
        ? {
            id: inducedJoint.id != null ? String(inducedJoint.id) : null,
            kind: _INDUCED_JOINT_KINDS.has(inducedJoint.kind) ? inducedJoint.kind : null,
        }
        : { id: null, kind: null };
    return {
        id: id || newMateId(),
        hostConnectorRef: safeHost,
        partConnectorRef: safePart,
        componentId: componentId != null ? String(componentId) : null,
        offset: safeOffset,
        inducedJoint: safeInduced,
    };
}

// ── Parameter factory ─────────────────────────────────────────────────────────
/**
 * @param {string} name       — variable name (used in expressions)
 * @param {number} value
 * @param {string} [unit]
 * @param {string|null} [equation] — optional expression string
 * @returns {ParamDef}
 */
export function makeParameter(name, value = 0, unit = 'mm', equation = null) {
    return {
        id:    newParamId(name),
        name,
        value,
        unit,
        equation,
        createdAt: Date.now(),
    };
}

// ── Reference builders ────────────────────────────────────────────────────────
/** Reference a body produced by another feature. */
export function bodyRef(featureId, bodyKey = 'main') {
    return { kind: REF_KINDS.BODY, featureId, bodyKey };
}

/** Reference a face (by fingerprint — to be replaced by NameEmitter descriptor in 1B). */
export function faceRef(fingerprint) {
    return { kind: REF_KINDS.FACE, fingerprint };
}

/** Reference an edge. */
export function edgeRef(fingerprint) {
    return { kind: REF_KINDS.EDGE, fingerprint };
}

/** Reference a stock or construction plane. */
export function planeRef(ref) {
    return { kind: REF_KINDS.PLANE, ref };
}

/** Reference a stock or construction axis. */
export function axisRef(ref) {
    return { kind: REF_KINDS.AXIS, ref };
}

/** Reference a sketch produced by another feature. */
export function sketchRef(sketchId) {
    return { kind: REF_KINDS.SKETCH, sketchId };
}

// ── Ref traversal — extract upstream feature ids from a Ref ──────────────────
/**
 * If a Ref points to an upstream feature (by featureId or fingerprint.sourceNodeId),
 * return the feature id. Used to build the dependency graph in dag.js.
 * Returns null for stock plane/axis refs that don't depend on a feature.
 *
 * @param {Ref|null|undefined} ref
 * @returns {string|null}
 */
export function refFeatureId(ref) {
    if (!ref) return null;
    if (ref.featureId) return ref.featureId;
    if (ref.sketchId)  return ref.sketchId;   // sketch refs carry the feature id under `sketchId`
    if (ref.fingerprint && ref.fingerprint.sourceNodeId) return ref.fingerprint.sourceNodeId;
    if (ref.kind === REF_KINDS.PLANE && ref.ref && ref.ref.construction) return ref.ref.construction;
    if (ref.kind === REF_KINDS.AXIS  && ref.ref && ref.ref.construction) return ref.ref.construction;
    return null;
}

// ── Lookup helpers ────────────────────────────────────────────────────────────
export function featureById(doc, id)   { return doc.features[id] || null; }
export function paramById(doc, id)     { return doc.parameters[id] || null; }
export function paramByName(doc, name) {
    for (const p of Object.values(doc.parameters)) if (p.name === name) return p;
    return null;
}

/**
 * Iterate features in their authored (UI) order, filtered to enabled ones.
 * For execution use `topoOrder` from dag.js instead.
 */
export function authoredOrder(doc, { enabledOnly = false } = {}) {
    const out = [];
    for (const id of doc.featureOrder) {
        const f = doc.features[id];
        if (!f) continue;
        if (enabledOnly && !f.enabled) continue;
        out.push(f);
    }
    return out;
}
