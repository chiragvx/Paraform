/**
 * Aggregate entry point — runs every test file in this directory.
 * Used by `npm test`.
 */

console.log('\n── lib/document core (types, fold, dag, store, migrate) ──');
await import('./run.mjs');

console.log('\n── lib/document naming (descriptor, queries, resolver) ──');
await import('./naming.mjs');

console.log('\n── lib/document strict queries (Phase 2a: expect + qDatum + ordinal-ref ban) ──');
await import('./strict_queries.mjs');

console.log('\n── lib/sketch (entities, constraints, sketch-data, feature, emit) ──');
await import('../../sketch/__tests__/run.mjs');

console.log('\n── lib/document emit + executor (the kernel-call path) ──');
await import('./emit.mjs');

console.log('\n── lib/document component-placement emit (Phase 3) ──');
await import('./emit_component_transform.mjs');

console.log('\n── lib/document casing generator (Phase 5) ──');
await import('./casing.mjs');

console.log('\n── lib/document parametric generators (pulley/sprocket/t-slot/boss/standoff) ──');
await import('./generators.mjs');

console.log('\n── lib/document integration (kernel client + operations) ──');
await import('./integration.mjs');

console.log('\n── lib/document executor cache (content-addressed compile skip) ──');
await import('./executor_cache.mjs');

console.log('\n── src/lib/ai code tools (writeBuildScript/editBuildScript + script guard) ──');
await import('../../../src/lib/ai/__tests__/code_tools.test.mjs');

console.log('\n── src/lib/ai timeline step-editing (get_timeline + edit-in-place, Phase C3) ──');
await import('../../../src/lib/ai/__tests__/timeline_tool.test.mjs');

console.log('\n── src/lib/ai plan-graph foundation (versioned design-intent source of truth, Phase 0) ──');
await import('../../../src/lib/ai/__tests__/plan_graph.test.mjs');

console.log('\n── src/lib/ai plan-graph persistence (round-trip through .paraform.json) ──');
await import('../../../src/lib/ai/__tests__/plan_persist.test.mjs');

console.log('\n── src/lib/ai decomposition + physics closure (torque/mass/COM gate) ──');
await import('../../../src/lib/ai/__tests__/plan_closure.test.mjs');

console.log('\n── src/lib/ai plan-graph tools (dispatchTool: decompose → closure → BOM) ──');
await import('../../../src/lib/ai/__tests__/plan_tools.test.mjs');

console.log('\n── src/lib/ai plan checkpoints (coherent chat+document+plan revert) ──');
await import('../../../src/lib/ai/__tests__/plan_checkpoints.test.mjs');

console.log('\n── src/lib/ai vision critic (blind-builder eyes) ──');
await import('../../../src/lib/ai/__tests__/vision_critic.test.mjs');

console.log('\n── src/lib/ai build gate (clarify→plan→approve→build) ──');
await import('../../../src/lib/ai/__tests__/build_gate.test.mjs');

console.log('\n── lib/sketch solver (facade + Newton) ──');
await import('../../sketch/__tests__/solver.mjs');

console.log('\n── app/settings (Phase 1E starter) ──');
await import('../../../app/__tests__/settings.mjs');

console.log('\n── app/viewport (CAD camera controls + view animator + rubber-band) ──');
await import('../../../app/__tests__/viewport.mjs');

console.log('\n── app/viewport actions (registry + fuzzy + marking-menu math) ──');
await import('../../../app/__tests__/viewport_actions.mjs');

console.log('\n── app/viewport command-stack (preview channel + inline schemas) ──');
await import('../../../app/__tests__/viewport_command.mjs');

console.log('\n── app/viewport body-select (highlight layer + selection→objects) ──');
await import('../../../app/__tests__/viewport_body_select.mjs');

console.log('\n── app/viewport edit-modifier (params/inputs spec + modifier actions) ──');
await import('../../../app/__tests__/viewport_edit_modifier.mjs');

console.log('\n── app/viewport face-overlay (Fusion-style face/edge conforming tint) ──');
await import('../../../app/__tests__/viewport_face_overlay.mjs');

console.log('\n── lib/document sketch ops (sketch builder + extrude/revolve) ──');
await import('./sketch_integration.mjs');

console.log('\n── lib/document advanced ops (sweep + loft + hole + path-pattern) ──');
await import('./advanced_ops.mjs');

console.log('\n── lib/document exporter (STEP/STL/BREP via kernel) ──');
await import('./exporter.mjs');

console.log('\n── lib/picking face_picker (raycast + nearest-face) ──');
await import('../../picking/__tests__/face_picker.mjs');

console.log('\n── lib/picking selection (subscribable selection set) ──');
await import('../../picking/__tests__/selection.mjs');

console.log('\n── lib/picking refs (payload → fingerprint conversion) ──');
await import('../../picking/__tests__/refs.mjs');

console.log('\n── app/v4_panel picking section (Selection widget) ──');
await import('../../../app/__tests__/v4_picking_section.mjs');

console.log('\n── app/v4_panel (schemas + persistence) ──');
await import('../../../app/__tests__/v4_panel.mjs');

console.log('\n── app/v4_panel feature-menu (Add Feature popup) ──');
await import('../../../app/__tests__/v4_feature_menu.mjs');

console.log('\n── app/v4_panel parameters (doc.parameters CRUD) ──');
await import('../../../app/__tests__/v4_parameters.mjs');

console.log('\n── app/sketch_3d (plane + snap + tools) ──');
await import('../../../app/__tests__/sketch_3d.mjs');

console.log('\n── app/sketch_3d interactions (picker + select + dim + re-edit) ──');
await import('../../../app/__tests__/sketch_3d_interact.mjs');

console.log('\n── app/sketch_3d drag + badges ──');
await import('../../../app/__tests__/sketch_3d_drag_badges.mjs');

console.log('\n── app/sketch_3d constraint panel + tangent inference ──');
await import('../../../app/__tests__/sketch_3d_constraints.mjs');

console.log('\n── app/sketch_3d edits (fillet + offset + construction) ──');
await import('../../../app/__tests__/sketch_3d_edits.mjs');

console.log('\n── app/sketch_3d trim (intersect + segments + tool) ──');
await import('../../../app/__tests__/sketch_3d_trim.mjs');

console.log('\n── app/sketch_3d mirror (reflect + bulk + tool) ──');
await import('../../../app/__tests__/sketch_3d_mirror.mjs');

console.log('\n── app/sketch_3d chamfer (corner cut + tool) ──');
await import('../../../app/__tests__/sketch_3d_chamfer.mjs');

console.log('\n── app/sketch_3d pattern (linear + circular + tools) ──');
await import('../../../app/__tests__/sketch_3d_pattern.mjs');

console.log('\n── app/sketch_3d slot (outline + hit-test + tool) ──');
await import('../../../app/__tests__/sketch_3d_slot.mjs');

console.log('\n── app/sketch_3d spline (path + hit-test + tool) ──');
await import('../../../app/__tests__/sketch_3d_spline.mjs');

console.log('\n── app/sketch_3d extend (line + arc + tool) ──');
await import('../../../app/__tests__/sketch_3d_extend.mjs');

await import('./component_groups.mjs');

console.log('\n── lib/document reference-image canvas + insert-at-marker (Phase A1/B2) ──');
await import('./reference_image.mjs');

console.log('\n── lib/document BuildScript parameter hoisting (Phase C2) ──');
await import('./script_params.mjs');

console.log('\n── lib/document incremental recompile (dep-hash + emit checkpoints, Phase G4) ──');
await import('./incremental.mjs');
