<script>
  /**
   * Phase 6 — Kinematics / articulation panel.
   *
   * Read-only over the document EXCEPT for the per-joint sliders, which call
   * `driveJoint(jointId, value)` live. Driving clamps to the joint limits,
   * persists the value as the joint's `drive`, and rewrites the driven child's
   * `component.origin` through the ops pipeline — so the viewport (which renders
   * component origins directly) shows the chain articulate as you drag.
   *
   * Shows:
   *   - Whole-assembly DOF summary + over-constrained warnings.
   *   - Each movable (revolute / prismatic) joint: name, kind, current value,
   *     min/max, and a slider bound to driveJoint.
   *
   * Units: degrees for revolute, mm for prismatic (CLAUDE.md).
   */
  import { onMount } from 'svelte';
  import { getDocumentStore, updateJoint, setComponentOrigin } from '../../../../lib/document/index.js';
  import { driveJoint, computeDof, movableJoints, clampJointValue } from '$lib/kinematics/limits.js';

  let doc = $state(null);

  onMount(() => {
    const store = getDocumentStore();
    doc = store.doc;
    const unsub = store.subscribe((d) => { doc = d; });
    return unsub;
  });

  const deps = { getStore: getDocumentStore, updateJoint, setComponentOrigin };

  const dof = $derived.by(() => (doc ? computeDof(doc) : { totalDof: 0, components: [], overConstrained: [], joints: [] }));
  const joints = $derived.by(() => (doc ? movableJoints(doc) : []));

  function currentValue(j) {
    return (j.drive && Number.isFinite(j.drive.value)) ? Number(j.drive.value) : 0;
  }
  function unitOf(j) { return j.kind === 'revolute' ? '°' : 'mm'; }

  async function onDrive(j, raw) {
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    await driveJoint(j.id, v, deps);
    // Refresh local view of the doc (subscribe also fires, this is belt-and-braces).
    doc = getDocumentStore().doc;
  }

  // Slider drags fire `input` per pixel; committing+recompiling on every one
  // is a recompute storm. Debounce so the chain articulates smoothly but the
  // ops pipeline only sees ~20 commits/sec. The number-field still commits
  // immediately on `change` (release / blur) via onDrive.
  let _driveTimer = null;
  let _pendingDrive = null;
  function onDriveDebounced(j, raw) {
    _pendingDrive = { j, raw };
    if (_driveTimer) return;
    _driveTimer = setTimeout(() => {
      _driveTimer = null;
      const p = _pendingDrive;
      _pendingDrive = null;
      if (p) onDrive(p.j, p.raw);
    }, 50);
  }

  function statusColor(status) {
    if (status === 'over-constrained') return 'text-destructive';
    if (status === 'mobile') return 'text-emerald-500';
    return 'text-muted-foreground';
  }
</script>

<div class="flex flex-col gap-2 text-xs text-foreground">
  <!-- DOF summary -->
  <div class="rounded border border-border bg-background p-2">
    <div class="flex items-center justify-between">
      <span class="font-medium uppercase tracking-wide text-muted-foreground">Assembly DOF</span>
      <span class="font-mono text-sm font-semibold">{dof.totalDof}</span>
    </div>
    {#if dof.overConstrained.length > 0}
      <div class="mt-1 rounded bg-destructive/10 px-1.5 py-1 text-destructive">
        ⚠ Over-constrained: {dof.overConstrained.join(', ')}
        <div class="text-[10px] text-destructive/80">More than one joint drives these components — the tree solver can't satisfy the loop.</div>
      </div>
    {/if}
  </div>

  <!-- Per-component classification -->
  {#if dof.components.length > 0}
    <ul class="flex flex-col gap-0.5">
      {#each dof.components as c (c.componentId)}
        <li class="flex items-center justify-between rounded px-1.5 py-0.5">
          <span class="truncate">{c.name}</span>
          <span class="font-mono text-[10px] {statusColor(c.status)}">{c.status}{c.dof ? ` (${c.dof})` : ''}</span>
        </li>
      {/each}
    </ul>
  {/if}

  <!-- Movable joint sliders -->
  <div class="mt-1 font-medium uppercase tracking-wide text-muted-foreground">Joints</div>
  {#if joints.length === 0}
    <div class="px-1.5 py-2 text-muted-foreground/60">No movable joints. Add a revolute or prismatic joint to articulate.</div>
  {:else}
    <ul class="flex flex-col gap-2">
      {#each joints as j (j.id)}
        {@const val = currentValue(j)}
        <li class="rounded border border-border bg-background p-2">
          <div class="mb-1 flex items-center justify-between">
            <span class="truncate font-medium">{j.kind} · {j.child ?? '—'}</span>
            <span class="font-mono text-[10px] text-muted-foreground">{val.toFixed(1)}{unitOf(j)}</span>
          </div>
          <input
            type="range"
            class="w-full accent-primary"
            min={j.limits?.min ?? -180}
            max={j.limits?.max ?? 180}
            step={j.kind === 'revolute' ? 1 : 0.5}
            value={val}
            oninput={(e) => onDriveDebounced(j, e.currentTarget.value)}
            onchange={(e) => onDrive(j, e.currentTarget.value)}
          />
          <div class="mt-0.5 flex items-center justify-between text-[10px] text-muted-foreground">
            <span>{j.limits?.min ?? -180}{unitOf(j)}</span>
            <input
              type="number"
              class="w-16 rounded border border-border bg-card px-1 py-0.5 text-center text-[10px]"
              value={val}
              onchange={(e) => onDrive(j, e.currentTarget.value)}
            />
            <span>{j.limits?.max ?? 180}{unitOf(j)}</span>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>
