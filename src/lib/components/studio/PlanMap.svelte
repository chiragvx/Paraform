<script>
  /**
   * Plan-map — the editable design-intent view (Phase 3 of
   * PLAN-deterministic-design.md). Renders the plan-graph (the SOURCE OF TRUTH)
   * as an interactive tree coloured by part class (buy/reuse/fabricate) and
   * build status, with a complete/pending rollup, the APPROVAL gate, the
   * physics-closure result, version history, and checkpoint revert. The graph is
   * mutated by the AI via plan_* tools; this panel is the human's window +
   * steering surface (clarify → plan → APPROVE → build → steer).
   *
   * Props:
   *   onEditPart(node) — called when the user clicks a part, so the composer can
   *                      prefill an isolated-edit reference to that node.
   */
  import { planState, refreshPlan, runPlanClosure, approvePlan } from '$lib/ai/plan/plan_store.svelte.js';
  import { checkpointList, revertToCheckpoint } from '$lib/ai/chat_store.svelte.js';

  let { onEditPart = null } = $props();

  let showClosure = $state(false);
  let selectedId = $state(null);
  const checkpoints = $derived(checkpointList());

  // Build a parent→children tree for rendering, from the flat node list.
  const byId = $derived(new Map(planState.nodes.map((n) => [n.id, n])));
  function childrenOf(id) { return planState.nodes.filter((n) => n.parentId === id); }
  const roots = $derived(planState.rootIds.map((id) => byId.get(id)).filter(Boolean));

  // Complete/pending rollup over buildable leaves (parts + instances).
  const leaves = $derived(planState.nodes.filter((n) => n.kind === 'part' || n.kind === 'instance'));
  const doneCount = $derived(leaves.filter((n) => n.status === 'verified').length);
  const pendingCount = $derived(leaves.length - doneCount);

  const clsColor = {
    buy: 'text-sky-400 border-sky-500/40',
    reuse: 'text-emerald-400 border-emerald-500/40',
    fabricate: 'text-amber-400 border-amber-500/40',
    unknown: 'text-muted-foreground border-border',
  };
  const statusDot = {
    pending: 'bg-muted-foreground/40',
    building: 'bg-amber-400',
    verified: 'bg-emerald-400',
    blocked: 'bg-destructive',
  };

  function onClosure() { runPlanClosure({}); showClosure = true; }
  function onRevert(id) { if (revertToCheckpoint(id)) refreshPlan(); }
  function onApprove() { approvePlan(); }
  function onPick(node) {
    selectedId = node.id;
    if (typeof onEditPart === 'function') onEditPart(node);
  }
  function fmtTime(t) { try { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } }
</script>

{#if planState.nodeCount > 0}
  <div class="border-b border-border bg-background/40">
    <div class="flex items-center justify-between px-3 py-1.5">
      <div class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Plan · {planState.nodeCount} nodes
        {#if leaves.length}<span class="ml-1 text-muted-foreground/70">· {doneCount}/{leaves.length} done</span>{/if}
        {#if planState.stale.length}<span class="ml-1 text-amber-400">· {planState.stale.length} stale</span>{/if}
      </div>
      <div class="flex items-center gap-1">
        <button class="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent" onclick={onClosure} title="Run physics closure (mass / torque / COM)">Closure</button>
        <button class="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent" onclick={refreshPlan} title="Refresh map" aria-label="Refresh">⟳</button>
      </div>
    </div>

    <!-- Approval gate: clarify → plan → APPROVE → build -->
    <div class="mx-2 mb-2 flex items-center justify-between gap-2 rounded border px-2 py-1.5 text-[11px] {planState.approved ? 'border-emerald-500/40 text-emerald-300' : 'border-amber-500/50 text-amber-300'}">
      {#if planState.approved}
        <span class="font-medium">✓ Plan approved — the AI may build{#if pendingCount} ({pendingCount} part{pendingCount === 1 ? '' : 's'} pending){/if}</span>
        <button class="shrink-0 rounded border border-border px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" onclick={onApprove} title="Re-approve the current plan as a new revert point">Re-approve</button>
      {:else}
        <span class="font-medium">Awaiting your approval — review the parts below</span>
        <button class="shrink-0 rounded bg-emerald-600 px-2 py-0.5 font-medium text-white hover:bg-emerald-500" onclick={onApprove} title="Approve this plan so the AI can start building">Approve plan ✓</button>
      {/if}
    </div>

    <!-- Closure result -->
    {#if showClosure && planState.closure}
      {@const c = planState.closure}
      <div class="mx-2 mb-2 rounded border px-2 py-1.5 text-[11px] {c.ok ? 'border-emerald-500/40 text-emerald-300' : 'border-destructive/50 text-destructive'}">
        <div class="font-medium">{c.ok ? '✓ Design closes' : '✗ Design does not close'} · ~{c.totalMassG} g</div>
        {#each c.issues as iss}
          <div class="mt-0.5 text-muted-foreground">• {iss.message}{#if iss.suggestedFix} <span class="opacity-70">→ {iss.suggestedFix}</span>{/if}</div>
        {/each}
      </div>
    {/if}

    <!-- Tree -->
    <div class="max-h-56 overflow-y-auto px-2 pb-2">
      {#each roots as root (root.id)}
        {@render nodeRow(root, 0)}
      {/each}
    </div>

    <!-- Versions + checkpoints -->
    {#if planState.versions.length || checkpoints.length}
      <div class="flex flex-wrap items-center gap-1 border-t border-border px-2 py-1.5">
        {#each planState.versions as v (v.id)}
          <span class="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground {v.id === planState.currentVersion ? 'bg-accent text-foreground' : ''}" title={v.label}>{v.label}</span>
        {/each}
        {#each checkpoints.slice(-4) as cp (cp.id)}
          <button class="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground" onclick={() => onRevert(cp.id)} title="Revert chat + geometry + plan to here">↶ {fmtTime(cp.createdAt)}</button>
        {/each}
      </div>
    {/if}
  </div>
{/if}

{#snippet nodeRow(node, depth)}
  {@const editable = node.kind === 'part' || node.kind === 'instance'}
  <button
    type="button"
    class="flex w-full items-center gap-1.5 rounded py-0.5 text-left text-xs hover:bg-accent/60 {selectedId === node.id ? 'bg-accent' : ''}"
    style="padding-left:{depth * 12 + 2}px"
    onclick={() => onPick(node)}
    title={editable ? `Click to edit ${node.label} (${node.id}) in isolation` : node.label}
  >
    <span class="inline-block h-1.5 w-1.5 shrink-0 rounded-full {statusDot[node.status] || statusDot.pending}"></span>
    <span class="truncate text-foreground">{node.label}</span>
    <span class="shrink-0 font-mono text-[9px] text-muted-foreground/50">{node.id}</span>
    {#if editable}
      <span class="shrink-0 rounded border px-1 text-[9px] uppercase {clsColor[node.cls] || clsColor.unknown}">{node.cls}</span>
    {/if}
    {#if node.chirality}<span class="text-[9px] text-muted-foreground/60">{node.chirality === 'left' ? 'L' : 'R'}</span>{/if}
    {#if node.stale}<span class="text-[9px] text-amber-400" title="needs rebuild">●</span>{/if}
  </button>
  {#each childrenOf(node.id) as child (child.id)}
    {@render nodeRow(child, depth + 1)}
  {/each}
{/snippet}
