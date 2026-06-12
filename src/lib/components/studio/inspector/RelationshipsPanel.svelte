<script>
  /**
   * RelationshipsPanel — Foundation 4 user-visible side.
   *
   * Renders the upstream constraint graph for the currently-selected feature:
   *   - Body/Face/Edge inputs: classified as Query / Descriptor / Fingerprint /
   *     Body-of-feature / opaque, in that priority order.
   *   - Parameter inputs: any feature param whose value is a string is treated
   *     as an expression; we parse it via extractDeps() and list every
   *     referenced parameter name that exists in the document parameter table.
   *
   * Re-derives on every document-store notify and on every parameter-store
   * update, mirroring the pattern used by PropertiesPanel / TransformPanel.
   */
  import { onMount } from 'svelte';
  import { getDocumentStore } from '../../../../../lib/document/index.js';
  import { setFeatureParams } from '../../../../../lib/document/operations.js';
  import { describeQuery, isQuery } from '../../../../../lib/document/queries.js';
  import { stringify as descriptorString } from '../../../../../lib/document/descriptor.js';
  import { parameters } from '$lib/parameters/store.svelte.js';
  import { extractDeps } from '$lib/parameters/expression.js';
  import { fetchCatalog, filterEntries } from '$lib/library/standard.js';
  import Select from '$lib/components/ui/select.svelte';

  // ── Spec 13: standard-parts catalog (lazy, single-flight) ─────────────────
  // Mounting the panel doesn't kick the fetch — we only call fetchCatalog
  // once the user opens the edit form *or* a Cylinder might auto-suggest.
  // The standard.js client caches the result module-scope, so this stays
  // a single network round-trip per session.
  let catalogEntries = $state(null);   // null = not loaded yet; [] = loaded empty
  let catalogLoading = $state(false);
  let catalogError = $state(null);

  async function ensureCatalog() {
    if (catalogEntries !== null || catalogLoading) return;
    catalogLoading = true;
    try {
      const all = await fetchCatalog();
      catalogEntries = filterEntries(all, { category: null }).filter(
        (e) => e && (e.category === 'Bearing' || e.category === 'Fastener')
      );
    } catch (e) {
      catalogError = e && e.message ? e.message : String(e);
      catalogEntries = [];
    } finally {
      catalogLoading = false;
    }
  }

  // ── partRef edit state ────────────────────────────────────────────────────
  let editing = $state(false);
  let draftEntryId = $state('');
  let draftRole = $state('bore');
  let draftFitClass = $state('');   // '' sentinel for null (profile default)

  const ROLE_OPTIONS = [
    { value: 'bore',        label: 'bore' },
    { value: 'shaft',       label: 'shaft' },
    { value: 'clearance',   label: 'clearance' },
    { value: 'tap',         label: 'tap' },
    { value: 'seat-width',  label: 'seat-width' },
  ];
  const FITCLASS_OPTIONS = [
    { value: '',       label: '(profile default)' },
    { value: 'H7/g6',  label: 'H7/g6' },
    { value: 'H7/h6',  label: 'H7/h6' },
    { value: 'H7/k6',  label: 'H7/k6' },
  ];

  let feature = $state(null);

  function readFromStore(store) {
    feature = store.selectedFeature();
  }

  onMount(() => {
    const store = getDocumentStore();
    readFromStore(store);
    const unsub = store.subscribe((_doc, _evt, s) => readFromStore(s));
    return unsub;
  });

  // ── Discrimination ────────────────────────────────────────────────────────
  // Priority: query → descriptor → fingerprint → body-of-feature → opaque.
  // A single input slot may carry any combination of these fields; we render
  // the most informative one available.
  function classifyRef(value) {
    if (value == null || typeof value !== 'object') return null;

    // 1. Query — structural DSL expression. Prefer over a baked descriptor
    //    because the query expresses *intent* ("all +Z faces of box_x").
    if (value.query && isQuery(value.query)) {
      return { type: 'query', label: describeQuery(value.query) };
    }
    // Tolerate bare query objects (no wrapping `query` key) — F4 emit-side
    // may attach the query directly when the input slot *is* a query.
    if (isQuery(value)) {
      return { type: 'query', label: describeQuery(value) };
    }

    // 2. Descriptor — pinned, exact entity.
    if (value.descriptor && value.descriptor.kind) {
      return { type: 'descriptor', label: descriptorString(value.descriptor) };
    }

    // 3. Fingerprint — pre-F4 spatial hash; falls back to bbox centre.
    if (value.fingerprint) {
      const fp = value.fingerprint;
      const c = fp.centerRounded || fp.center || null;
      if (Array.isArray(c) && c.length >= 3) {
        return { type: 'fingerprint', label: `fingerprint @ (${c[0]}, ${c[1]}, ${c[2]})` };
      }
      const src = fp.sourceNodeId ? ` from ${fp.sourceNodeId}` : '';
      return { type: 'fingerprint', label: `fingerprint${src}` };
    }

    // 4. Body-of-feature — no query/descriptor/fingerprint, but does name a
    //    producing feature. Covers the post-migrate bodyRef shape.
    if (value.kind === 'body' && value.featureId) {
      const key = value.bodyKey && value.bodyKey !== 'main' ? `:${value.bodyKey}` : '';
      return { type: 'body', label: `body of ${value.featureId}${key}` };
    }

    // 5. Last-ditch: still references *something* — show its kind.
    if (value.featureId) {
      return { type: 'opaque', label: `${value.kind || 'ref'} of ${value.featureId}` };
    }

    return { type: 'opaque', label: '(opaque ref)' };
  }

  function refKind(value) {
    // Coarse bucket for grouping into Bodies / Faces / Edges sections.
    // Prefer the value's own `kind`; fall back to the inner descriptor /
    // query's kind so a body-query input still sorts under Bodies.
    if (!value || typeof value !== 'object') return null;
    if (value.kind === 'body' || value.kind === 'face' || value.kind === 'edge') return value.kind;
    if (value.descriptor?.kind) return value.descriptor.kind;
    if (isQuery(value)) return value.kind;
    if (value.query && isQuery(value.query)) return value.query.kind;
    return null;
  }

  // ── Parameter dep detection ────────────────────────────────────────────────
  // A feature param qualifies as an expression iff it's a string (numeric
  // params are stored as numbers; the dialog converts a typed expression to
  // string-on-blur). We then parse it through extractDeps() and only keep
  // names that resolve to a known document parameter — function names,
  // typos, and the `pi` constant get filtered out.
  function paramDeps(f, paramRows) {
    if (!f || !f.params) return [];
    const known = new Set(paramRows.map((r) => r.name));
    const out = [];
    for (const [key, value] of Object.entries(f.params)) {
      let expr = null;
      if (typeof value === 'string' && value.trim() !== '') {
        expr = value;
      } else if (value && typeof value === 'object' && typeof value.__expr === 'string') {
        // Tolerate a wrapped shape if the form layer ever adopts one.
        expr = value.__expr;
      }
      if (!expr) continue;

      let deps;
      try { deps = extractDeps(expr); }
      catch { continue; }
      const refs = deps.filter((d) => known.has(d));
      if (refs.length) out.push({ key, expr, refs });
    }
    return out;
  }

  // ── Derived view ──────────────────────────────────────────────────────────
  // `parameters.items` is reactive; reading it inside $derived re-runs this
  // block whenever the parameter table notifies.
  const refs = $derived.by(() => {
    const f = feature;
    if (!f) return { bodies: [], faces: [], edges: [], params: [] };
    const bodies = [];
    const faces = [];
    const edges = [];
    const inputs = f.inputs || {};
    for (const [role, value] of Object.entries(inputs)) {
      const cls = classifyRef(value);
      if (!cls) continue;
      const row = { role, label: cls.label, type: cls.type };
      const k = refKind(value);
      if (k === 'body') bodies.push(row);
      else if (k === 'face') faces.push(row);
      else if (k === 'edge') edges.push(row);
      else bodies.push(row); // unknown bucket → Bodies, as the catch-all section
    }
    const params = paramDeps(f, parameters.items);
    return { bodies, faces, edges, params };
  });

  const isEmpty = $derived(
    refs.bodies.length === 0 &&
    refs.faces.length === 0 &&
    refs.edges.length === 0 &&
    refs.params.length === 0
  );

  // ── partRef extraction + catalog lookup ───────────────────────────────────
  // Read defensively — params is a loose object; partRef may be missing,
  // malformed, or null.
  const partRef = $derived.by(() => {
    const p = feature?.params?.partRef;
    if (!p || typeof p !== 'object') return null;
    if (typeof p.entryId !== 'string' || !p.entryId) return null;
    return p;
  });

  const partRefEntry = $derived.by(() => {
    if (!partRef || !catalogEntries) return null;
    return catalogEntries.find((e) => e.id === partRef.entryId) || null;
  });

  // Auto-suggest: a Cylinder with no partRef whose diameter (= 2 × radius)
  // sits within ±0.1 mm of any bearing's outerDiameter. Pure heuristic —
  // clicking the affordance writes a default `{role: 'bore', fitClass: null}`.
  const autoSuggestBearing = $derived.by(() => {
    if (!feature || partRef) return null;
    if (feature.type !== 'Cylinder') return null;
    if (!catalogEntries) return null;
    const r = Number(feature.params?.radius);
    if (!Number.isFinite(r) || r <= 0) return null;
    const dia = 2 * r;
    for (const e of catalogEntries) {
      if (e.category !== 'Bearing') continue;
      const od = Number(e.dims?.outerDiameter);
      if (!Number.isFinite(od)) continue;
      if (Math.abs(od - dia) <= 0.1) return e;
    }
    return null;
  });

  // Trigger catalog fetch as soon as a feature with potential partRef is
  // selected — this fills `partRefEntry` for the read-only view, and
  // populates `autoSuggestBearing` for plain Cylinders.
  $effect(() => {
    if (!feature) return;
    if (feature.type === 'Cylinder' || feature.type === 'Hole' || feature.type === 'Box') {
      ensureCatalog();
    }
  });

  // ── partRef edit handlers ─────────────────────────────────────────────────
  function beginEdit() {
    ensureCatalog();
    draftEntryId = partRef?.entryId || '';
    draftRole = partRef?.role || 'bore';
    draftFitClass = partRef?.fitClass || '';
    editing = true;
  }

  function cancelEdit() {
    editing = false;
  }

  function saveEdit() {
    if (!feature) return;
    if (!draftEntryId) { editing = false; return; }
    const next = {
      entryId:  draftEntryId,
      role:     draftRole,
      fitClass: draftFitClass === '' ? null : draftFitClass,
    };
    setFeatureParams(feature.id, { partRef: next });
    editing = false;
  }

  function clearPartRef() {
    if (!feature) return;
    setFeatureParams(feature.id, { partRef: null });
    editing = false;
  }

  function acceptAutoSuggest(entry) {
    if (!feature || !entry) return;
    setFeatureParams(feature.id, {
      partRef: { entryId: entry.id, role: 'bore', fitClass: null },
    });
  }

  const catalogOptions = $derived.by(() => {
    if (!catalogEntries) return [];
    return catalogEntries.map((e) => ({
      value: e.id,
      label: `${e.name || e.id}${e.standard ? ` (${e.standard})` : ''}`,
    }));
  });
</script>

{#if !feature}
  <div class="text-xs text-muted-foreground/60">Select a feature.</div>
{:else}
  <div class="space-y-2 text-xs">
    <!-- Spec 13: standard-parts mate (partRef) ─────────────────────────── -->
    {#if partRef || editing || autoSuggestBearing}
      <div class="space-y-1">
        <div class="text-[10px] uppercase tracking-wider text-muted-foreground">
          Standard-part mate
        </div>

        {#if editing}
          <div class="space-y-1.5 rounded border border-border bg-card/40 px-2 py-1.5">
            {#if catalogLoading && !catalogEntries}
              <div class="text-[10px] text-muted-foreground">Loading catalog…</div>
            {:else if catalogError}
              <div class="text-[10px] text-destructive">Catalog: {catalogError}</div>
            {:else}
              <label class="block space-y-0.5">
                <span class="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                  Catalog entry
                </span>
                <Select
                  bind:value={draftEntryId}
                  options={[{ value: '', label: '— select —' }, ...catalogOptions]}
                />
              </label>
            {/if}

            <label class="block space-y-0.5">
              <span class="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                Role
              </span>
              <Select bind:value={draftRole} options={ROLE_OPTIONS} />
            </label>

            <label class="block space-y-0.5">
              <span class="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                Fit class
              </span>
              <Select bind:value={draftFitClass} options={FITCLASS_OPTIONS} />
            </label>

            <div class="flex items-center gap-2 pt-0.5">
              <button
                class="rounded border border-border bg-secondary px-2 py-0.5 text-[10px] hover:bg-secondary/80 disabled:opacity-50"
                disabled={!draftEntryId}
                onclick={saveEdit}>
                Save
              </button>
              <button
                class="rounded border border-border px-2 py-0.5 text-[10px] hover:bg-secondary/40"
                onclick={cancelEdit}>
                Cancel
              </button>
              {#if partRef}
                <button
                  class="ml-auto text-[10px] text-muted-foreground hover:text-destructive"
                  onclick={clearPartRef}>
                  Clear
                </button>
              {/if}
            </div>
          </div>
        {:else if partRef}
          <div class="rounded border border-border bg-card/40 px-2 py-1.5 font-mono text-xs">
            {#if partRefEntry}
              <div class="truncate">{partRefEntry.name}{#if partRefEntry.standard} ({partRefEntry.standard}){/if}</div>
            {:else if catalogLoading}
              <div class="truncate text-muted-foreground/70">{partRef.entryId} <span class="text-[10px]">(loading…)</span></div>
            {:else}
              <div class="truncate">{partRef.entryId}</div>
            {/if}
            <div class="mt-0.5 text-[10px] text-muted-foreground">
              Role: {partRef.role} · Fit: {partRef.fitClass || '(profile default)'}
            </div>
          </div>
          <button
            class="text-[10px] text-muted-foreground hover:text-foreground"
            onclick={beginEdit}>
            Edit
          </button>
        {:else if autoSuggestBearing}
          <div class="rounded border border-dashed border-border bg-card/20 px-2 py-1.5 text-[11px]">
            Looks like a {autoSuggestBearing.nominalSize || autoSuggestBearing.name} bearing seat.
            <button
              class="ml-1 text-[10px] text-primary hover:underline"
              onclick={() => acceptAutoSuggest(autoSuggestBearing)}>
              Set partRef →
            </button>
          </div>
        {/if}
      </div>
    {:else if feature.type === 'Cylinder' || feature.type === 'Hole'}
      <!-- Always offer the affordance to add a partRef even when no suggestion. -->
      <div>
        <button
          class="text-[10px] text-muted-foreground hover:text-foreground"
          onclick={beginEdit}>
          + Standard-part mate
        </button>
      </div>
    {/if}

    <div class="text-xs font-medium text-muted-foreground">Upstream references</div>

    {#if isEmpty}
      <div class="text-xs text-muted-foreground/60">(no upstream references)</div>
    {:else}
      {#if refs.bodies.length}
        <div class="space-y-1">
          <div class="text-[10px] uppercase tracking-wider text-muted-foreground">Bodies</div>
          {#each refs.bodies as r (r.role)}
            <div class="rounded border border-border bg-card/40 px-2 py-1">
              <div class="text-[10px] uppercase tracking-wider text-muted-foreground/70">{r.role}</div>
              <div class="truncate font-mono">{r.label}</div>
            </div>
          {/each}
        </div>
      {/if}

      {#if refs.faces.length}
        <div class="space-y-1">
          <div class="text-[10px] uppercase tracking-wider text-muted-foreground">Faces</div>
          {#each refs.faces as r (r.role)}
            <div class="rounded border border-border bg-card/40 px-2 py-1">
              <div class="text-[10px] uppercase tracking-wider text-muted-foreground/70">{r.role}</div>
              <div class="truncate font-mono">{r.label}</div>
            </div>
          {/each}
        </div>
      {/if}

      {#if refs.edges.length}
        <div class="space-y-1">
          <div class="text-[10px] uppercase tracking-wider text-muted-foreground">Edges</div>
          {#each refs.edges as r (r.role)}
            <div class="rounded border border-border bg-card/40 px-2 py-1">
              <div class="text-[10px] uppercase tracking-wider text-muted-foreground/70">{r.role}</div>
              <div class="truncate font-mono">{r.label}</div>
            </div>
          {/each}
        </div>
      {/if}

      {#if refs.params.length}
        <div class="space-y-1">
          <div class="text-[10px] uppercase tracking-wider text-muted-foreground">Parameters</div>
          {#each refs.params as p (p.key)}
            <div class="rounded border border-border bg-card/40 px-2 py-1">
              <div class="flex items-center justify-between gap-2">
                <span class="text-[10px] uppercase tracking-wider text-muted-foreground/70">{p.key}</span>
                <span class="truncate font-mono text-muted-foreground/80">{p.expr}</span>
              </div>
              <div class="mt-0.5 flex flex-wrap gap-1">
                {#each p.refs as name}
                  <span class="rounded bg-secondary px-1 py-0.5 font-mono text-[10px]">{name}</span>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
{/if}
