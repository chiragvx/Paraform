<script module>
  /**
   * Shared kinematics signal — the StatusBar / outer Inspector reads
   * the latest pose + interference health from this object.
   */
  export const kinematicsStatus = $state({
    interferenceHits: 0,
    poseCount: 0,
    lastUpdatedAt: 0,
  });
</script>

<script>
  /**
   * KinematicsPanel — spec 17 v1 inspector surface.
   *
   * Lists every joint on the document, exposes a slider per joint
   * (within its declared limits), runs interference at the live pose,
   * and lets the user snapshot the current configuration as a saved
   * pose. The "play trajectory" button walks between consecutive saved
   * poses and reports whether interference fires at any sampled step.
   *
   * v1 limitation: AABB stand-in for true OBB/triangle interference —
   * documented in tracker/17-kinematics-oracle.md.
   */
  import { onMount, onDestroy } from 'svelte';
  import * as v4 from '../../../../../lib/document/index.js';
  import { checkInterferenceAtPose } from '$lib/kinematics/interference.js';
  // Side-effect import: registers the mesh-detail hook into interference.js
  // so { detailed: true } can return triangle-pair detail. Lazy import is
  // unnecessary here — the panel ships in the bundle anyway.
  import * as meshIfx from '$lib/kinematics/interference_mesh.js';
  import {
    buildContactOverlay,
    disposeContactOverlay,
  } from '$lib/kinematics/interference_overlay.js';
  import { sampleTrajectory, PoseLibrary } from '$lib/kinematics/pose.js';
  import { solveIK } from '$lib/kinematics/ik.js';
  import { resolveChain, endEffectorPosition } from '$lib/kinematics/jacobian.js';

  // Live doc snapshot
  let doc = $state(null);
  let joints = $state([]);
  // Mutable pose: { jointId → value }
  let pose = $state({});
  // Pose library — UI-only (not in changelog for v1).
  const library = new PoseLibrary();
  let poses = $state([]);
  let trajectoryReport = $state(null);
  // v2 overlay state ────────────────────────────────────────────────────────
  // The viewport scene is sourced by querying the document store for the
  // active renderer (set up by main.js). The overlay is mounted directly
  // into that scene root so it inherits the Z-up world frame.
  let highlightContact = $state(false);
  let overlayGroup = null;          // current THREE.Group, or null
  let overlayHostScene = null;      // last seen scene root

  function readFromStore(store) {
    doc = store.doc;
    const j = (doc && doc.joints) || {};
    joints = Object.values(j);
    // Seed pose entries for any new joints
    const next = { ...pose };
    for (const jt of joints) {
      if (!(jt.id in next)) next[jt.id] = (jt.drive && Number(jt.drive.value)) || 0;
    }
    pose = next;
  }

  onMount(() => {
    const store = v4.getDocumentStore();
    readFromStore(store);
    const unsub = store.subscribe((_d, _evt, s) => readFromStore(s));
    return unsub;
  });

  /**
   * Pull per-component triangle data off the active bridge geometry, if
   * present. The bridge stamps `{ positions, index? }` per component in
   * `doc.geometry.componentMeshes` (or falls back to per-face meshes
   * concatenated by id). When this returns null the panel silently runs
   * AABB-only.
   */
  function getComponentMeshes(d) {
    if (!d || !d.geometry) return null;
    const cm = d.geometry.componentMeshes;
    if (cm && typeof cm === 'object' && Object.keys(cm).length > 0) {
      // Normalise shape — kernel emits {positions, index, bounds} per id;
      // BVH builder expects `positions` and optional `index`. Both flat
      // arrays are accepted (interference_mesh.buildComponentBVH wraps
      // them in typed arrays internally).
      return cm;
    }
    // Defensive fallback: per-face meshes keyed by descriptor. Triggered
    // only against legacy kernel responses that predate componentMeshes —
    // log so we notice if it fires in production.
    const faces = d.geometry.faces || d.geometry.perFaceMeshes;
    if (!faces) return null;
    const out = {};
    for (const f of (Array.isArray(faces) ? faces : Object.values(faces))) {
      if (!f || !f.componentId || !f.positions) continue;
      const slot = out[f.componentId] || (out[f.componentId] = { positions: [] });
      slot.positions.push(...f.positions);
    }
    for (const k of Object.keys(out)) {
      out[k].positions = new Float32Array(out[k].positions);
    }
    if (Object.keys(out).length) {
      console.warn('[kinematics] using per-face fallback for componentMeshes — kernel did not emit geometry.componentMeshes');
      return out;
    }
    return null;
  }

  // Live interference report derived from pose + doc.
  let interferenceReport = $derived.by(() => {
    if (!doc) return { ok: true, hits: [], pairsTested: 0 };
    try {
      const componentMeshes = highlightContact ? getComponentMeshes(doc) : null;
      return checkInterferenceAtPose(doc, pose, {
        detailed: !!(highlightContact && componentMeshes),
        componentMeshes,
      });
    } catch { return { ok: true, hits: [], pairsTested: 0 }; }
  });

  $effect(() => {
    kinematicsStatus.interferenceHits = interferenceReport.hits.length;
    kinematicsStatus.poseCount = poses.length;
    kinematicsStatus.lastUpdatedAt = Date.now();
  });

  // Overlay lifecycle — mount/dispose as the toggle flips or the report
  // changes. The scene is queried via the viewport adapter on the doc
  // store; if no scene is available we silently skip.
  $effect(() => {
    // Tear down old overlay first
    if (overlayGroup && overlayHostScene) {
      overlayHostScene.remove(overlayGroup);
      disposeContactOverlay(overlayGroup);
      overlayGroup = null;
    }
    if (!highlightContact) return;
    if (!interferenceReport.hits || interferenceReport.hits.length === 0) return;
    // Aggregate all triangle pairs across hits.
    const allPairs = [];
    for (const h of interferenceReport.hits) {
      if (Array.isArray(h.pairs)) allPairs.push(...h.pairs);
    }
    if (allPairs.length === 0) return;
    // Resolve the scene from the viewport. `window.__paraformViewport`
    // is the conventional handoff main.js publishes; if unavailable we
    // no-op (the report still shows the hits + count).
    const vp = typeof window !== 'undefined' ? window.__paraformViewport : null;
    const scene = vp?.scene || vp?.getScene?.() || null;
    if (!scene) return;
    overlayHostScene = scene;
    overlayGroup = buildContactOverlay(allPairs);
    scene.add(overlayGroup);
  });

  onDestroy(() => {
    if (overlayGroup && overlayHostScene) {
      overlayHostScene.remove(overlayGroup);
      disposeContactOverlay(overlayGroup);
      overlayGroup = null;
    }
  });

  function snapshotPose() {
    const p = library.add(`Pose ${poses.length + 1}`, pose);
    poses = library.list();
    return p;
  }

  function deletePose(id) {
    library.remove(id);
    poses = library.list();
  }

  function playTrajectory() {
    if (!doc || poses.length < 2) { trajectoryReport = null; return; }
    const reports = [];
    let anyHit = false;
    for (let i = 0; i < poses.length - 1; i++) {
      const r = sampleTrajectory(doc, poses[i], poses[i + 1], { samples: 10 });
      reports.push({ a: poses[i].name, b: poses[i + 1].name, ...r });
      if (!r.ok) anyHit = true;
    }
    trajectoryReport = { ok: !anyHit, segments: reports };
  }

  // ── IK mode ───────────────────────────────────────────────────────────────
  // Spec 17 v3: pick an end-effector component, type a world-space target,
  // run DLS IK, mirror solved joint parameters into the live pose so the
  // sliders + interference report react.
  let ikEnabled = $state(false);
  let ikEndEffector = $state('');
  let ikTarget = $state([0, 0, 0]);
  let ikStatus = $state(null); // { converged, iterations, residual, dofCount }

  // Components reachable as end-effectors = anything with at least one
  // joint above it in the chain. Computed from the live doc.
  let candidateEEs = $derived.by(() => {
    if (!doc) return [];
    const out = [];
    for (const cid of Object.keys(doc.components || {})) {
      const chain = resolveChain(doc, cid);
      if (chain.dofJoints.length > 0) out.push({ id: cid, dof: chain.dofJoints.length });
    }
    return out;
  });

  // Seed EE on first use and prime ikTarget to the current EE position.
  $effect(() => {
    if (!ikEnabled) return;
    if (!ikEndEffector && candidateEEs.length > 0) {
      ikEndEffector = candidateEEs[0].id;
    }
  });

  function syncIKTargetToCurrent() {
    if (!doc || !ikEndEffector) return;
    const p = endEffectorPosition(doc, pose, ikEndEffector);
    ikTarget = [
      Number(p[0].toFixed(3)),
      Number(p[1].toFixed(3)),
      Number(p[2].toFixed(3)),
    ];
  }

  function runIK() {
    if (!doc || !ikEndEffector) { ikStatus = null; return; }
    try {
      const r = solveIK({
        doc,
        endEffector: ikEndEffector,
        target: [Number(ikTarget[0]), Number(ikTarget[1]), Number(ikTarget[2])],
        initialPose: { ...pose },
        maxIter: 100,
        tol: 1e-3,
        lambda: 0.05,
      });
      // Mirror solved DOF values into the live pose.
      const next = { ...pose };
      for (const jid of r.dofJointIds) next[jid] = r.pose[jid];
      pose = next;
      ikStatus = {
        converged: r.converged,
        iterations: r.iterations,
        residual: r.residual,
        dofCount: r.dofJointIds.length,
      };
    } catch (e) {
      ikStatus = { error: e?.message || String(e) };
    }
  }

  function jointUnit(j) {
    if (j.kind === 'revolute') return '°';
    if (j.kind === 'prismatic') return 'mm';
    return '';
  }
</script>

<div class="space-y-3 text-xs">
  {#if joints.length === 0}
    <div class="text-muted-foreground/60">
      No joints yet. Use <code>addJoint(...)</code> from the console to
      define a kinematic chain.
    </div>
  {:else}
    <div class="space-y-2">
      {#each joints as j (j.id)}
        <div class="rounded border border-input p-2">
          <div class="mb-1 flex items-center justify-between">
            <div class="font-medium">
              {j.kind} <span class="text-muted-foreground/70">({j.parent} → {j.child || '?'})</span>
            </div>
            <div class="tabular-nums">{pose[j.id]?.toFixed?.(2) ?? 0}{jointUnit(j)}</div>
          </div>
          {#if j.kind !== 'fixed'}
            <input
              type="range"
              min={j.limits?.min ?? -180}
              max={j.limits?.max ?? 180}
              step="0.5"
              bind:value={pose[j.id]}
              class="w-full"
            />
            <div class="mt-0.5 flex justify-between text-[10px] text-muted-foreground/70">
              <span>{j.limits?.min ?? '?'}</span>
              <span>{j.limits?.max ?? '?'}</span>
            </div>
          {/if}
        </div>
      {/each}
    </div>

    <div class="rounded border border-input p-2">
      <div class="mb-1 flex items-center justify-between font-medium">
        <span>Inverse kinematics</span>
        <label class="flex items-center gap-1 text-[11px] font-normal text-muted-foreground/80">
          <input type="checkbox" bind:checked={ikEnabled} />
          IK mode
        </label>
      </div>
      {#if ikEnabled}
        {#if candidateEEs.length === 0}
          <div class="text-[11px] text-muted-foreground/70">
            Need at least one revolute/prismatic joint chain to solve IK.
          </div>
        {:else}
          <label class="block text-[11px] text-muted-foreground/80">End-effector</label>
          <select bind:value={ikEndEffector} class="mb-1.5 w-full rounded border border-input bg-background p-1 text-xs">
            {#each candidateEEs as ee (ee.id)}
              <option value={ee.id}>{ee.id} ({ee.dof} DOF)</option>
            {/each}
          </select>
          <label class="block text-[11px] text-muted-foreground/80">Target (X, Y, Z) mm</label>
          <div class="mb-1.5 grid grid-cols-3 gap-1">
            <input type="number" step="0.1" bind:value={ikTarget[0]}
              class="rounded border border-input bg-background p-1 text-xs tabular-nums" />
            <input type="number" step="0.1" bind:value={ikTarget[1]}
              class="rounded border border-input bg-background p-1 text-xs tabular-nums" />
            <input type="number" step="0.1" bind:value={ikTarget[2]}
              class="rounded border border-input bg-background p-1 text-xs tabular-nums" />
          </div>
          <div class="flex gap-1.5">
            <button class="rounded border px-2 py-1 text-xs" onclick={runIK}>Solve</button>
            <button class="rounded border px-2 py-1 text-xs" onclick={syncIKTargetToCurrent}>Use current</button>
          </div>
          {#if ikStatus}
            <div class="mt-1.5 text-[11px]">
              {#if ikStatus.error}
                <span class="text-red-600">⚠ {ikStatus.error}</span>
              {:else if ikStatus.converged}
                <span class="text-green-600">
                  ✓ converged in {ikStatus.iterations} iter(s),
                  residual {ikStatus.residual.toExponential(2)} mm
                </span>
              {:else}
                <span class="text-amber-600">
                  ⚠ no solution after {ikStatus.iterations} iter(s),
                  residual {ikStatus.residual.toFixed(3)} mm
                </span>
              {/if}
            </div>
          {/if}
        {/if}
      {/if}
    </div>

    <div class="rounded border border-input p-2">
      <div class="mb-1 font-medium">Interference at pose</div>
      {#if interferenceReport.ok}
        <div class="text-green-600">OK — {interferenceReport.pairsTested} pair(s) tested</div>
      {:else}
        <div class="text-red-600">
          {interferenceReport.hits.length} overlap(s):
          {interferenceReport.hits.map(h => `${h.a}↔${h.b}`).join(', ')}
        </div>
        <label class="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground/80">
          <input type="checkbox" bind:checked={highlightContact} />
          Highlight contact (triangle-mesh)
        </label>
        {#if highlightContact}
          {@const detailPairCount = interferenceReport.hits.reduce(
            (n, h) => n + (Array.isArray(h.pairs) ? h.pairs.length : 0), 0
          )}
          <div class="text-[10px] text-muted-foreground/70">
            {detailPairCount} triangle pair(s) in contact region
          </div>
        {/if}
      {/if}
    </div>

    <div class="flex gap-2">
      <button class="rounded border px-2 py-1" onclick={snapshotPose}>Add pose snapshot</button>
      <button class="rounded border px-2 py-1" onclick={playTrajectory} disabled={poses.length < 2}>
        Play trajectory
      </button>
    </div>

    {#if poses.length > 0}
      <div>
        <div class="mb-1 font-medium">Saved poses</div>
        <ul class="space-y-1">
          {#each poses as p (p.id)}
            <li class="flex items-center justify-between rounded border border-input p-1.5">
              <span>{p.name}</span>
              <button class="text-muted-foreground/70 hover:text-red-600" onclick={() => deletePose(p.id)}>×</button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if trajectoryReport}
      <div class="rounded border border-input p-2">
        <div class="mb-1 font-medium">Trajectory report</div>
        {#if trajectoryReport.ok}
          <div class="text-green-600">No interference along {trajectoryReport.segments.length} segment(s)</div>
        {:else}
          <div class="text-red-600 space-y-1">
            {#each trajectoryReport.segments as seg}
              {#if !seg.ok}
                {@const firstBad = seg.steps.find(s => !s.ok)}
                <div>{seg.a} → {seg.b}: collision at t={firstBad?.t?.toFixed?.(2) ?? '?'}</div>
              {/if}
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>
