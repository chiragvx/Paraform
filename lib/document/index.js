/**
 * lib/document — v4 document model public surface.
 *
 * The v4 document is an append-only changelog-backed DAG. It is the foundation
 * for Phase 1B (TNP), 1C (sketcher integration), and 1D (worker pool). v1 of
 * the app still uses the v3 TreeStore (lib/tree/store.js); the v4 system lives
 * alongside until the migration is wired into main.js.
 *
 *   Document  — folded live state (features, parameters, bodies, sketches)
 *   Change    — one atomic edit (ADD_FEATURE, SET_PARAMS, …)
 *   DocumentStore — pub/sub façade with commit/undo/redo/setHead
 *   migrateV3TreeToV4 — one-shot migration of existing project files
 */

export {
    CATEGORIES, FEATURE_TYPES, REF_KINDS,
    emptyDocument, makeFeature, makeParameter, makeComponent, makeAssumption, makeJoint, makeConnector, makeMate, identityTransform,
    componentPathFor,
    bodyRef, faceRef, edgeRef, planeRef, axisRef, sketchRef,
    refFeatureId, featureById, paramById, paramByName, authoredOrder,
    newFeatureId, newChangeId, newParamId, newAssumptionId, newJointId, newConnectorId, newMateId,
} from './types.js';

export {
    CHANGE_KIND, makeChange,
    addFeatureChange, removeFeatureChange, updateFeatureChange, renameFeatureChange,
    setEnabledChange, setParamsChange, setInputsChange, reorderFeatureChange,
    addParameterChange, updateParameterChange, removeParameterChange,
    upsertBodyChange, upsertSketchChange, setMetadataChange, setUnitsChange,
    addComponentChange, removeComponentChange, renameComponentChange,
    setFeatureComponentChange, setComponentParentChange, setComponentOriginChange,
    addAssumptionChange, acknowledgeAssumptionChange,
    removeAssumptionChange, clearAssumptionsChange,
    addJointChange, updateJointChange, removeJointChange,
    addConnectorChange, updateConnectorChange, removeConnectorChange,
    addMateChange, updateMateChange, removeMateChange,
} from './changelog.js';

export { applyChange, foldChangelog, foldIncremental } from './fold.js';

export {
    edges, dependenciesOf, dependentsOf,
    topoOrder, parallelGroups,
    downstream, upstream, cycles,
} from './dag.js';

export { DocumentStore, getDocumentStore, resetDocumentStore, setInsertIndexResolver } from './store.js';

// Component tree helpers — UI consumers read these to render the browser
// panel + walk the tree. Pure reads off `doc.components`.
export { componentChildren, componentDescendants } from './store.js';

export { migrateV3TreeToV4, migrateV4ToV5, isV3Tree, isV4Document, isV5Document, ensureV4, ensureV5 } from './migrate.js';

// Phase G4 — incremental recompile engine (per-feature dependency hashing).
export { featureDepHashes, incrementalPlan, affectedFeatures, hashesToObject } from './dep_hash.js';

// Phase 1B — topological naming / entity queries
export {
    ENTITY_KIND, OP_TAGS,
    descriptor, face, edge, vertex,
    stringify as descriptorString,
    parse as parseDescriptor,
    equals as descriptorEquals,
    hash as descriptorHash,
    rootAncestor, descendsFrom, lineageFeatures,
} from './descriptor.js';

export {
    qDescriptor, qFeatureFaces, qFeatureEdges, qFeatureVertices,
    qOp, qUnion, qSubtract, qNth, qFilter, qByDirection, qDescendsFrom,
    qDatum,
    isQuery, describeQuery,
    validate as validateQuery,
    validateStrict as validateQueryStrict,
    containsOrdinalRef,
    EXPECT,
    PRED,
} from './queries.js';

export {
    buildIndex, entriesForFeature,
    resolve as resolveQuery,
    resolveKeys as resolveQueryKeys,
    QueryResolutionError,
} from './resolver.js';

// Phase 1 closing — emitter + executor that drive the kernel
export { emitDocument, emitCasingPython } from './emit.js';

// Phase 5 — casing connector→geometry helpers (exported for tooling/tests)
export {
    CONNECTOR_GEOMETRY_MAP, geometryOpFor, cutoutDimsFor, bossDimsFor,
    resolveTargets, connectorsForTargets,
} from './casing.js';
export { DocumentExecutor, getDocumentExecutor, resetDocumentExecutor } from './executor.js';
export { HttpKernelClient, makeMockKernelClient } from './kernel_client.js';
export { exportDocumentAs, downloadDocumentAs } from './exporter.js';

// Live-app integration surface
export {
    addBox, addCylinder, addSphere, addTorus,
    addFillet, addChamfer, addShell,
    addExtrude, addRevolve, extrudeSketch, revolveSketch,
    addSweep, addLoft, addHole, addHelix,
    addBuildScript, updateBuildScript,
    addStandardPart, updateStandardPart,
    addImportedMesh,
    addReferenceImage, updateReferenceImage,
    addUnion, addCut, addIntersect,
    addSplit, addSplitFace,
    addCasing,
    addGear,
    addPulley, addSprocket, addTSlotExtrusion, addScrewBoss, addStandoff, addFan,
    addMountingPlate, addBracket, addThreadedInsertBoss, addNutTrap, addSnapHook,
    addBearingPocket, addMotorMount, addShaftCoupler, addWheel, addTimingPulley,
    addHinge, addProjectBox, addPCBTray, addKnob,
    addMove, addRotate, addScale, addAlign,
    addCosmeticThread,
    addLinearPattern, addCircularPattern, addPathPattern, addMirror,
    addDraft,
    addPlane, addAxis, addPoint,
    addSketchOnFace,
    addPushPullFace,
    addMoveFace, addDeleteFace, addOffsetFace,
    addDocumentParameter, setDocumentParameter, removeDocumentParameter,
    deleteFeature, deleteFeatureCascade, setFeatureEnabled, setFeatureParams,
    resetDocument,
    setActiveComponentProvider,
    addComponent, removeComponent, removeComponentPromote, ungroupComponent, groupComponents,
    renameComponent, setFeatureComponent, setComponentParent, setComponentOrigin,
    addAssumption, acknowledgeAssumption, removeAssumption, clearAssumptions,
    ingestExtractorAmbiguities,
    recordStandardPartGradeDefaults, auditDocumentForAssumptions,
    STANDARD_PART_DEFAULT_GRADES, STANDARD_PART_ALTERNATIVES,
    addJoint, updateJoint, removeJoint,
    addConnector, updateConnector, removeConnector,
    addMate, updateMate, removeMate, matesForComponent,
} from './operations.js';

// Sketch surface — quick helpers + fluent builder, all routing through the
// singleton DocumentStore. See lib/document/sketch_ops.js for usage.
export {
    rectangleSketch, circleSketch, polygonSketch, slotSketch, ellipseSketch,
    newSketch, SketchBuilder,
} from './sketch_ops.js';

// Viewport bridge is the only file in here that imports three.js — callers
// that don't need a renderer (tests, headless tools) can ignore it.
export { DocumentViewportBridge, getViewportBridge, disposeViewportBridge } from './bridge.js';
