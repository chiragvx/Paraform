<script>
  import Select from '$lib/components/ui/select.svelte';
  import Input from '$lib/components/ui/input.svelte';
  import { saveSetting } from '$lib/settings/schema.js';
  import { listProfiles, getProfile } from '$lib/dfm/profiles.js';

  let { values = $bindable({}) } = $props();

  // Resilient discovery: prefer the runner-provided list, fall back to the
  // three known process IDs so the panel renders even if dfm/profiles.js
  // hasn't landed yet.
  let profileOptions = $state([]);
  try {
    profileOptions = (listProfiles?.() ?? []).map((p) =>
      typeof p === 'string'
        ? { value: p, label: p }
        : { value: p.id, label: p.label ?? p.id },
    );
  } catch {
    profileOptions = [
      { value: '3d-print', label: '3D Print' },
      { value: 'cnc-mill', label: 'CNC Mill' },
      { value: 'injection-mold', label: 'Injection Mold' },
    ];
  }

  // Read the active profile's defaults so the override inputs have helpful
  // placeholders. Both are advisory — the runner already enforces the
  // profile's hard thresholds; these only act as user overrides.
  const activeProfile = $derived.by(() => {
    try { return getProfile?.(values.profile) ?? null; } catch { return null; }
  });
  const minWallDefault = $derived(activeProfile?.minWallMm ?? activeProfile?.thresholds?.minWallMm ?? null);
  const minHoleDefault = $derived(activeProfile?.minHoleMm ?? activeProfile?.thresholds?.minHoleMm ?? null);

  function updateProfile(v) {
    values.profile = v;
    saveSetting('manufacturing', 'profile', v);
  }

  function updateThreshold(key, raw) {
    const parsed = raw === '' || raw == null ? null : Number(raw);
    const v = Number.isFinite(parsed) ? parsed : null;
    const next = { ...(values.customThresholds || {}), [key]: v };
    values.customThresholds = next;
    saveSetting('manufacturing', 'customThresholds', next);
  }
</script>

<div class="space-y-0.5">
  <label class="flex items-center justify-between gap-3 py-1.5">
    <span class="text-xs text-muted-foreground">Process profile</span>
    <div class="w-44">
      <Select
        value={values.profile}
        options={profileOptions}
        onchange={(e) => updateProfile(e.currentTarget.value)}
      />
    </div>
  </label>

  <div class="py-1.5">
    <div class="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
      Custom thresholds <span class="normal-case text-muted-foreground/70">— active profile override</span>
    </div>
  </div>

  <label class="flex items-center justify-between gap-3 py-1.5">
    <span class="text-xs text-muted-foreground">
      Min wall (mm)
      {#if minWallDefault != null}
        <span class="text-muted-foreground/60">[{minWallDefault}]</span>
      {/if}
    </span>
    <div class="w-44">
      <Input
        type="number"
        min={0}
        step={0.05}
        value={values.customThresholds?.minWallMm ?? ''}
        oninput={(e) => updateThreshold('minWallMm', e.currentTarget.value)}
      />
    </div>
  </label>

  <label class="flex items-center justify-between gap-3 py-1.5">
    <span class="text-xs text-muted-foreground">
      Min hole Ø (mm)
      {#if minHoleDefault != null}
        <span class="text-muted-foreground/60">[{minHoleDefault}]</span>
      {/if}
    </span>
    <div class="w-44">
      <Input
        type="number"
        min={0}
        step={0.05}
        value={values.customThresholds?.minHoleMm ?? ''}
        oninput={(e) => updateThreshold('minHoleMm', e.currentTarget.value)}
      />
    </div>
  </label>
</div>
