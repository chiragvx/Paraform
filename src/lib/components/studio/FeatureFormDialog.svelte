<script>
  import Dialog from '$lib/components/ui/dialog.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import Input from '$lib/components/ui/input.svelte';
  import Select from '$lib/components/ui/select.svelte';
  import { dialogs } from '$lib/dialogs/dialogs.svelte.js';
  import { getDocumentStore } from '../../../../lib/document/index.js';
  import { evaluateInScope, validateExpression } from '$lib/parameters/store.svelte.js';

  const store = getDocumentStore();

  let open = $derived(dialogs.featureForm !== null);
  let command = $derived(dialogs.featureForm?.command ?? null);
  let values = $derived(dialogs.featureForm?.values ?? {});

  /**
   * Literal-vs-expression discriminator.
   *
   * A string `s` is treated as a *literal* number iff parseFloat round-trips:
   * `parseFloat(s.trim()).toString() === s.trim()` AND the result is finite.
   * That rejects things like `"5mm"`, `"5 + 1"`, `"width / 2"`, but accepts
   * `"5"`, `"5.0"` (well, `.toString()` of 5 is "5" so `5.0` fails — fine,
   * `5.0` then takes the expression path and still evaluates to 5, identical
   * result). Anything else goes through validateExpression / evaluateInScope.
   */
  function isLiteralNumber(raw) {
    if (typeof raw !== 'string') return Number.isFinite(raw);
    const trimmed = raw.trim();
    if (trimmed === '') return false;
    const n = parseFloat(trimmed);
    if (!Number.isFinite(n)) return false;
    return n.toString() === trimmed;
  }

  function isExpression(raw) {
    if (raw == null) return false;
    const s = typeof raw === 'string' ? raw : String(raw);
    if (s.trim() === '') return false;
    return !isLiteralNumber(s);
  }

  /**
   * Per-field state derived from the current `values` snapshot. We compute
   * once per render via $derived rather than recomputing inside the {#each}
   * template (which would re-run evaluateInScope on every keystroke for
   * every field, not just the edited one — fine here since the table is
   * tiny, but $derived makes the dependency explicit and keys it on values).
   *
   * Shape: { [key]: { error: string|null, evalText: string|null, num: number|null } }
   */
  let fieldState = $derived.by(() => {
    const out = {};
    if (!command?.form?.fields) return out;
    for (const field of command.form.fields) {
      if (field.type !== 'number') continue;
      const raw = values[field.key];
      const s = raw == null ? '' : String(raw);
      if (s.trim() === '') {
        out[field.key] = { error: 'required', evalText: null, num: null };
        continue;
      }
      if (isLiteralNumber(s)) {
        const n = parseFloat(s.trim());
        out[field.key] = { error: null, evalText: null, num: n };
        continue;
      }
      // Expression path.
      const v = validateExpression(s);
      if (!v?.valid) {
        out[field.key] = { error: v?.error || 'invalid expression', evalText: null, num: null };
        continue;
      }
      try {
        const n = evaluateInScope(s);
        if (!Number.isFinite(n)) {
          out[field.key] = { error: 'not a finite number', evalText: null, num: null };
          continue;
        }
        const unit = field.unit ? ` ${field.unit}` : '';
        out[field.key] = { error: null, evalText: `= ${n.toFixed(2)}${unit}`, num: n };
      } catch (e) {
        out[field.key] = { error: e?.message || 'eval error', evalText: null, num: null };
      }
    }
    return out;
  });

  let hasErrors = $derived(
    Object.values(fieldState).some((s) => s && s.error),
  );

  function setField(key, raw) {
    if (!dialogs.featureForm) return;
    const field = command.form.fields.find((f) => f.key === key);
    if (!field) return;
    let next = raw;
    if (field.type === 'boolean') next = raw === 'true' || raw === true;
    // number / select / text: store the raw string. Number fields stay text
    // so expressions survive the round-trip; we coerce on submit.
    dialogs.featureForm.values = { ...values, [key]: next };
  }

  function run() {
    if (!command) return;
    // Resolve all number fields against the parameter scope. If any field
    // is in an error state (per fieldState), abort without closing.
    const resolved = {};
    for (const field of command.form.fields) {
      const raw = values[field.key];
      if (field.type === 'number') {
        const st = fieldState[field.key];
        if (!st || st.error) {
          // Keep the dialog open with errors visible — fieldState is reactive.
          return;
        }
        resolved[field.key] = st.num;
      } else if (field.type === 'boolean') {
        resolved[field.key] = raw === true || raw === 'true';
      } else {
        resolved[field.key] = raw;
      }
    }
    try {
      command.run({ store, params: resolved });
    } catch (e) {
      console.error('[featureForm]', command.id, e);
    }
    dialogs.closeForm();
  }

  function onOpenChange(v) {
    if (!v) dialogs.closeForm();
  }
</script>

<Dialog
  open={open}
  onclose={() => dialogs.closeForm()}
  title={command?.form?.title ?? command?.title ?? ''}
  description={command?.form?.description ?? ''}
>
  {#snippet children()}
    {#if command}
      <div class="space-y-3">
        {#each command.form.fields as field (field.key)}
          <div>
            <label for={`ff-${field.key}`} class="mb-1 block text-xs font-medium text-muted-foreground">
              {field.label}{field.unit ? ` (${field.unit})` : ''}
            </label>
            {#if field.type === 'select'}
              <Select
                id={`ff-${field.key}`}
                value={String(values[field.key] ?? '')}
                options={field.options}
                onchange={(e) => setField(field.key, e.currentTarget.value)}
              />
            {:else if field.type === 'boolean'}
              <Select
                id={`ff-${field.key}`}
                value={String(values[field.key] ?? 'false')}
                options={[{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]}
                onchange={(e) => setField(field.key, e.currentTarget.value)}
              />
            {:else if field.type === 'number'}
              <div class="flex items-center gap-2">
                <Input
                  id={`ff-${field.key}`}
                  type="text"
                  inputmode="numeric"
                  autocomplete="off"
                  spellcheck={false}
                  value={String(values[field.key] ?? '')}
                  oninput={(e) => setField(field.key, e.currentTarget.value)}
                />
                {#if isExpression(values[field.key]) && fieldState[field.key]?.evalText}
                  <span class="whitespace-nowrap font-mono text-xs text-muted-foreground">
                    {fieldState[field.key].evalText}
                  </span>
                {/if}
              </div>
              {#if fieldState[field.key]?.error}
                <div class="mt-1 rounded-sm bg-destructive/10 px-1.5 py-0.5 font-mono text-[10px] text-destructive">
                  {fieldState[field.key].error}
                </div>
              {/if}
            {:else}
              <Input
                id={`ff-${field.key}`}
                type="text"
                value={String(values[field.key] ?? '')}
                onchange={(e) => setField(field.key, e.currentTarget.value)}
              />
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/snippet}

  {#snippet footer()}
    <Button variant="ghost" size="sm" onclick={() => dialogs.closeForm()}>
      {#snippet children()}Cancel{/snippet}
    </Button>
    <Button size="sm" onclick={run} disabled={hasErrors}>
      {#snippet children()}{command?.form?.submitLabel ?? 'Apply'}{/snippet}
    </Button>
  {/snippet}
</Dialog>
