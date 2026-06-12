<script>
  import { onMount, untrack } from 'svelte';
  import * as THREE from 'three';
  import { studio } from '$lib/studio/runtime.svelte.js';
  import { getDocumentStore } from '../../../../../lib/document/index.js';
  import { formatLength, formatNumber } from '$lib/units/units.svelte.js';
  import { measure } from '$lib/measure/api.js';

  // ── Selection / feature plumbing ────────────────────────────────────────────
  let selectedFeatureId = $state(null);
  let selectedFeatureName = $state(null);
  let hasSelection = $state(false);
  // E3.5 — surface the spec when a CosmeticThread feature is selected.
  let cosmeticThreadSpec = $state(null);

  // ── Mesh-derived (client-side, cheap) ───────────────────────────────────────
  let triCount = $state(null);
  let vertCount = $state(null);
  let lastRenderMs = $state(null);

  // ── Kernel-derived bbox/volume/area/manifold ────────────────────────────────
  // Each row tracks: value, loading, error (so the UI can render "—" + tooltip
  // when one query of the batched call fails while the others succeeded).
  let bboxRow = $state({ min: null, max: null, size: null, loading: false, error: null, estimated: false });
  let volumeRow = $state({ value: null, loading: false, error: null });
  let areaRow = $state({ value: null, loading: false, error: null });
  let manifoldRow = $state({ closed: null, loading: false, error: null });
  let massRow = $state({ value: null, loading: false, error: null });

  // ── Density selector for mass ───────────────────────────────────────────────
  // Inline select (no settings round-trip) — mass is a derived display, not a
  // persisted document property, and users typically scrub through materials to
  // sanity-check parts. Keep it next to the row.
  const DENSITY_PRESETS = [
    { id: 'water',    label: 'Water (1.00)',     density: 1.0 },
    { id: 'pla',      label: 'PLA (1.24)',       density: 1.24 },
    { id: 'aluminum', label: 'Aluminum (2.70)',  density: 2.70 },
    { id: 'steel',    label: 'Steel (7.85)',     density: 7.85 },
  ];
  let densityId = $state('water');
  const currentDensity = $derived(
    (DENSITY_PRESETS.find((p) => p.id === densityId) ?? DENSITY_PRESETS[0]).density,
  );

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  // ── Client-side fallback (bbox + tri/vert counts) ───────────────────────────
  // Tri/vert counts are *always* computed here — they're mesh stats, not
  // geometry truth. Bbox here is only used when the kernel/measure API is
  // unreachable; in that case `bboxRow.estimated = true` so we can show a
  // "(estimated)" suffix.
  function computeMeshStats(bodyTransform) {
    if (!bodyTransform) {
      triCount = null;
      vertCount = null;
      return null;
    }

    let tris = 0;
    let verts = 0;
    bodyTransform.traverse((obj) => {
      if (!obj.isMesh || !obj.geometry) return;
      const geom = obj.geometry;
      const posAttr = geom.attributes && geom.attributes.position;
      if (posAttr) verts += posAttr.count;
      if (geom.index) {
        tris += geom.index.count / 3;
      } else if (posAttr) {
        tris += posAttr.count / 3;
      }
    });
    triCount = Math.round(tris);
    vertCount = verts;

    try {
      const box = new THREE.Box3().setFromObject(bodyTransform);
      if (box.isEmpty()) return null;
      return {
        min: [round2(box.min.x), round2(box.min.y), round2(box.min.z)],
        max: [round2(box.max.x), round2(box.max.y), round2(box.max.z)],
        size: [
          round2(box.max.x - box.min.x),
          round2(box.max.y - box.min.y),
          round2(box.max.z - box.min.z),
        ],
      };
    } catch {
      return null;
    }
  }

  function clearKernelRows() {
    bboxRow = { min: null, max: null, size: null, loading: false, error: null, estimated: false };
    volumeRow = { value: null, loading: false, error: null };
    areaRow = { value: null, loading: false, error: null };
    manifoldRow = { closed: null, loading: false, error: null };
    massRow = { value: null, loading: false, error: null };
  }

  // ── Selection wiring (mirrors original behavior) ────────────────────────────
  onMount(() => {
    const store = getDocumentStore();
    const sync = () => {
      const id = store.selectedFeatureId();
      hasSelection = id != null;
      selectedFeatureId = id ?? null;
      const feat = id ? store.doc.features[id] : null;
      selectedFeatureName = feat?.name || null;
      if (feat && feat.type === 'CosmeticThread') {
        const p = feat.params || {};
        cosmeticThreadSpec = {
          standard: p.standard || '—',
          direction: p.direction || 'right-hand',
          length: p.length,
          pitch: p.pitch,
          nominalDiameter: p.nominalDiameter,
        };
      } else {
        cosmeticThreadSpec = null;
      }
    };
    sync();
    const unsub = store.subscribe(() => sync());
    return unsub;
  });

  // ── Mesh stats + fallback bbox: react to bridge renders ─────────────────────
  $effect(() => {
    const bridge = studio.bridge;
    if (!bridge) {
      triCount = null;
      vertCount = null;
      lastRenderMs = null;
      return;
    }

    // Seed. `untrack` so reading bboxRow here doesn't make it a dep of this
    // effect — otherwise any bboxRow write (including ours below) re-fires
    // the effect, which then re-installs `onRender` every render frame.
    const fallback = computeMeshStats(bridge.bodyTransform);
    if (typeof bridge.lastRenderMs === 'number') {
      lastRenderMs = Math.round(bridge.lastRenderMs);
    }
    const seedNeeded = untrack(() => bboxRow.size == null && !bboxRow.loading);
    if (fallback && seedNeeded) {
      bboxRow = { ...fallback, loading: false, error: null, estimated: true };
    }

    const arrEq = (a, b) => {
      if (a === b) return true;
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    };

    const unsub = bridge.onRender(() => {
      const fb = computeMeshStats(bridge.bodyTransform);
      if (typeof bridge.lastRenderMs === 'number') {
        lastRenderMs = Math.round(bridge.lastRenderMs);
      }
      // Refresh the estimated bbox only when we're currently showing one
      // (i.e. kernel path didn't land yet / failed) AND the fallback
      // numbers actually changed. Without the value-equality guard this
      // would write bboxRow on every render frame, churning every consumer
      // (including the kernel-measure effect) into a tight re-run loop.
      if (!fb) return;
      const cur = bboxRow;
      if (!cur.estimated) return;
      if (arrEq(cur.size, fb.size) && arrEq(cur.min, fb.min) && arrEq(cur.max, fb.max)) return;
      bboxRow = { ...fb, loading: false, error: null, estimated: true };
    });
    return unsub;
  });

  // ── Kernel measure batch: re-runs on selection or compile change ────────────
  $effect(() => {
    const fid = selectedFeatureId;
    const density = currentDensity;
    // Subscribe to compile-id so the effect re-runs after every recompile;
    // the api.js cache makes repeated calls free.
    const compileMs = studio.bridge?.lastCompileMs;
    void compileMs;

    if (!fid) {
      clearKernelRows();
      return;
    }

    // Mark all rows loading. Keep previous values visible while loading so the
    // UI doesn't flash "—" between recompiles — only the small spinner-style
    // loading flag flips.
    //
    // CRITICAL: wrap the spread reads in `untrack`. Without this, reading
    // these `$state` row objects inside the effect that *also* writes them
    // (here synchronously AND asynchronously after the await) makes them
    // self-dependencies — the post-await write triggers the effect to re-fire
    // and a new measure POST goes out every render frame, piling up hundreds
    // of pending requests behind the single-threaded kernel.
    untrack(() => {
      bboxRow = { ...bboxRow, loading: true, error: null, estimated: false };
      volumeRow = { ...volumeRow, loading: true, error: null };
      areaRow = { ...areaRow, loading: true, error: null };
      manifoldRow = { ...manifoldRow, loading: true, error: null };
      massRow = { ...massRow, loading: true, error: null };
    });

    let cancelled = false;

    (async () => {
      const queries = [
        { type: 'bbox',        featureId: fid },
        { type: 'volume',      featureId: fid },
        { type: 'surfaceArea', featureId: fid },
        { type: 'manifold',    featureId: fid },
        { type: 'mass',        featureId: fid, density },
      ];

      let results;
      try {
        results = await measure(queries);
      } catch (err) {
        if (cancelled) return;
        // Kernel/measure API unreachable → fall back to in-browser bbox
        // traversal so the panel is never blank for offline / no-server use.
        const fb = computeMeshStats(studio.bridge?.bodyTransform);
        if (fb) {
          bboxRow = { ...fb, loading: false, error: null, estimated: true };
        } else {
          bboxRow = { min: null, max: null, size: null, loading: false, error: String(err?.message || err), estimated: false };
        }
        volumeRow = { value: null, loading: false, error: String(err?.message || err) };
        areaRow = { value: null, loading: false, error: String(err?.message || err) };
        manifoldRow = { closed: null, loading: false, error: String(err?.message || err) };
        massRow = { value: null, loading: false, error: String(err?.message || err) };
        return;
      }
      if (cancelled) return;

      const [bbox, volume, area, manifoldR, mass] = Array.isArray(results) ? results : [results];

      // bbox
      if (bbox && bbox.ok) {
        bboxRow = {
          min: bbox.min ?? null,
          max: bbox.max ?? null,
          size: bbox.size ?? null,
          loading: false,
          error: null,
          estimated: false,
        };
      } else {
        // Per-query failure: try the in-browser fallback so we still show
        // *something* useful, marked estimated.
        const fb = computeMeshStats(studio.bridge?.bodyTransform);
        if (fb) {
          bboxRow = { ...fb, loading: false, error: bbox?.error ?? null, estimated: true };
        } else {
          bboxRow = { min: null, max: null, size: null, loading: false, error: bbox?.error ?? 'no result', estimated: false };
        }
      }

      // volume
      volumeRow = volume && volume.ok
        ? { value: volume.volume, loading: false, error: null }
        : { value: null, loading: false, error: volume?.error ?? 'no result' };

      // surface area
      areaRow = area && area.ok
        ? { value: area.surfaceArea ?? area.area ?? null, loading: false, error: null }
        : { value: null, loading: false, error: area?.error ?? 'no result' };

      // manifold (chip)
      manifoldRow = manifoldR && manifoldR.ok
        ? { closed: !!manifoldR.closed, loading: false, error: null }
        : { closed: null, loading: false, error: manifoldR?.error ?? 'no result' };

      // mass
      massRow = mass && mass.ok
        ? { value: mass.mass ?? mass.value ?? null, loading: false, error: null }
        : { value: null, loading: false, error: mass?.error ?? 'no result' };
    })();

    return () => { cancelled = true; };
  });

  // Display helpers — "—" while loading, value when present, "—" + tooltip on error.
  function cellText(row, key, fmt) {
    if (row.loading && row[key] == null) return '—';
    if (row.error && row[key] == null) return '—';
    if (row[key] == null) return '—';
    return fmt ? fmt(row[key]) : row[key];
  }
</script>

{#if !hasSelection || !studio.bridge}
  <div class="text-xs text-muted-foreground">Select a feature with a body.</div>
{:else}
  <div class="space-y-1.5 text-xs">
    {#if selectedFeatureName}
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground">Feature</span>
        <span class="truncate font-mono">{selectedFeatureName}</span>
      </div>
    {/if}

    {#if cosmeticThreadSpec}
      <div class="pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/70 border-t border-border/40 mt-1">
        Cosmetic Thread
      </div>
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground">Standard</span>
        <span class="font-mono">{cosmeticThreadSpec.standard}</span>
      </div>
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground">Direction</span>
        <span class="font-mono">{cosmeticThreadSpec.direction}</span>
      </div>
      {#if cosmeticThreadSpec.length != null}
        <div class="flex items-center justify-between">
          <span class="text-muted-foreground">Length</span>
          <span class="font-mono">{formatLength(cosmeticThreadSpec.length)}</span>
        </div>
      {/if}
      {#if cosmeticThreadSpec.pitch != null}
        <div class="flex items-center justify-between">
          <span class="text-muted-foreground">Pitch</span>
          <span class="font-mono">{cosmeticThreadSpec.pitch} mm</span>
        </div>
      {/if}
      {#if cosmeticThreadSpec.nominalDiameter != null}
        <div class="flex items-center justify-between">
          <span class="text-muted-foreground">Nominal Ø</span>
          <span class="font-mono">{cosmeticThreadSpec.nominalDiameter} mm</span>
        </div>
      {/if}
    {/if}

    <!-- ── Geometry (live, kernel-truth) ───────────────────────────────────── -->
    <div class="pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/70 border-t border-border/40 mt-1">
      Geometry (live)
    </div>

    <div class="flex items-center justify-between">
      <span class="text-muted-foreground">Bounds X</span>
      <span class="font-mono" title={bboxRow.error ?? ''}>
        {cellText(bboxRow, 'size', (s) => formatLength(s[0]))}{#if bboxRow.estimated && bboxRow.size}<span class="ml-1 text-muted-foreground/60">(est.)</span>{/if}
      </span>
    </div>
    <div class="flex items-center justify-between">
      <span class="text-muted-foreground">Bounds Y</span>
      <span class="font-mono" title={bboxRow.error ?? ''}>
        {cellText(bboxRow, 'size', (s) => formatLength(s[1]))}{#if bboxRow.estimated && bboxRow.size}<span class="ml-1 text-muted-foreground/60">(est.)</span>{/if}
      </span>
    </div>
    <div class="flex items-center justify-between">
      <span class="text-muted-foreground">Bounds Z</span>
      <span class="font-mono" title={bboxRow.error ?? ''}>
        {cellText(bboxRow, 'size', (s) => formatLength(s[2]))}{#if bboxRow.estimated && bboxRow.size}<span class="ml-1 text-muted-foreground/60">(est.)</span>{/if}
      </span>
    </div>
    <div class="flex items-center justify-between">
      <span class="text-muted-foreground">Min XYZ</span>
      <span class="font-mono" title={bboxRow.error ?? ''}>
        {bboxRow.min ? bboxRow.min.map((n) => formatLength(n)).join(', ') : '—'}
      </span>
    </div>
    <div class="flex items-center justify-between">
      <span class="text-muted-foreground">Max XYZ</span>
      <span class="font-mono" title={bboxRow.error ?? ''}>
        {bboxRow.max ? bboxRow.max.map((n) => formatLength(n)).join(', ') : '—'}
      </span>
    </div>

    <div class="flex items-center justify-between">
      <span class="text-muted-foreground">Volume</span>
      <span class="font-mono" title={volumeRow.error ?? ''}>
        {volumeRow.value != null ? `${formatNumber(volumeRow.value)} mm³` : '—'}
      </span>
    </div>
    <div class="flex items-center justify-between">
      <span class="text-muted-foreground">Surface area</span>
      <span class="font-mono" title={areaRow.error ?? ''}>
        {areaRow.value != null ? `${formatNumber(areaRow.value)} mm²` : '—'}
      </span>
    </div>

    <div class="flex items-center justify-between gap-2">
      <span class="text-muted-foreground">Mass</span>
      <div class="flex items-center gap-2 min-w-0">
        <select
          bind:value={densityId}
          class="bg-transparent border border-border/60 rounded px-1 py-0.5 text-[10px] font-mono text-foreground/80 focus:outline-none focus:border-border"
          title="Density (g/cm³)"
        >
          {#each DENSITY_PRESETS as p}
            <option value={p.id}>{p.label}</option>
          {/each}
        </select>
        <span class="font-mono truncate" title={massRow.error ?? ''}>
          {massRow.value != null ? `${formatNumber(massRow.value)} g` : '—'}
        </span>
      </div>
    </div>

    <div class="flex items-center justify-between">
      <span class="text-muted-foreground">Manifold</span>
      {#if manifoldRow.loading && manifoldRow.closed == null}
        <span class="font-mono text-muted-foreground">—</span>
      {:else if manifoldRow.closed === true}
        <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 text-[10px] font-mono">
          ✓ closed
        </span>
      {:else if manifoldRow.closed === false}
        <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 text-[10px] font-mono">
          ⚠ open edges
        </span>
      {:else}
        <span class="font-mono text-muted-foreground" title={manifoldRow.error ?? ''}>—</span>
      {/if}
    </div>

    <!-- ── Mesh (cached, client-side traversal) ────────────────────────────── -->
    <div class="pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/70 border-t border-border/40 mt-1">
      Mesh (cached)
    </div>

    <div class="flex items-center justify-between">
      <span class="text-muted-foreground">Triangles</span>
      <span class="font-mono">{triCount?.toLocaleString() ?? '—'}</span>
    </div>
    <div class="flex items-center justify-between">
      <span class="text-muted-foreground">Vertices</span>
      <span class="font-mono">{vertCount?.toLocaleString() ?? '—'}</span>
    </div>
    {#if lastRenderMs != null}
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground">Render time</span>
        <span class="font-mono">{lastRenderMs} ms</span>
      </div>
    {/if}
  </div>
{/if}
