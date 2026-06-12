<script>
  import Dialog from '$lib/components/ui/dialog.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Plus from '@lucide/svelte/icons/plus';

  import { dialogs } from '$lib/dialogs/dialogs.svelte.js';
  import {
    parameters,
    addParameter,
    updateParameter,
    removeParameter,
    validateExpression,
  } from '$lib/parameters/store.svelte.js';
  import { format } from '$lib/parameters/expression.js';

  // Row edit buffer: a single keyed-by-id object, NOT per-row $state. One
  // $state container is cheaper than spinning up a state node per row and
  // makes the debounce timer map symmetric (also keyed by id). Each entry
  // is a partial patch: { name?, expression?, unit? }. We only mirror the
  // field the user is actively editing — other columns read straight from
  // parameters.items so external store updates aren't shadowed.
  let editing = $state({});

  // Inline-add row inputs.
  let newName = $state('');
  let newExpression = $state('');
  let newError = $state('');

  // Debounce timers per (id, field). Cleared on unmount.
  const timers = new Map();

  function timerKey(id, field) {
    return `${id}::${field}`;
  }

  function scheduleCommit(id, field, value) {
    editing[id] = { ...(editing[id] || {}), [field]: value };
    const key = timerKey(id, field);
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => {
      timers.delete(key);
      commit(id, field, value);
    }, 300);
    timers.set(key, handle);
  }

  function commit(id, field, value) {
    const patch = { [field]: value };
    // For name/expression edits, validate via the store before committing.
    // The store re-validates internally, but we want to avoid even a
    // transient invalid write when we can detect it cheaply.
    if (field === 'expression') {
      const result = validateExpression(value, { exclude: id });
      if (!result?.valid) {
        // Leave the buffer untouched so the user keeps typing; the row
        // surfaces the error via param.error after the store rejects it.
      }
    }
    updateParameter(id, patch);
    // Drop the buffered field — the store is now the source of truth.
    if (editing[id]) {
      const next = { ...editing[id] };
      delete next[field];
      if (Object.keys(next).length === 0) delete editing[id];
      else editing[id] = next;
    }
  }

  function valueFor(param, field) {
    const buf = editing[param.id];
    if (buf && field in buf) return buf[field];
    return param[field] ?? '';
  }

  function onAdd() {
    const name = newName.trim();
    const expr = newExpression.trim();
    if (!name || !expr) {
      newError = 'Name and expression are required.';
      return;
    }
    const result = validateExpression(expr);
    if (!result?.valid) {
      newError = result?.error || 'Invalid expression.';
      return;
    }
    try {
      addParameter(name, expr);
      newName = '';
      newExpression = '';
      newError = '';
    } catch (err) {
      newError = err?.message || 'Could not add parameter.';
    }
  }

  function onAddKeydown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      onAdd();
    }
  }

  function close() {
    dialogs.close('parameters');
  }

  $effect(() => {
    // Clear any pending debounce timers on close/teardown.
    return () => {
      for (const handle of timers.values()) clearTimeout(handle);
      timers.clear();
    };
  });

  const items = $derived(parameters.items ?? []);

  // Shared input class for compact in-table editors.
  const cellInputClass =
    'h-7 w-full text-xs px-2 rounded border border-input bg-transparent font-mono ' +
    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
</script>

<Dialog
  bind:open={dialogs.parameters}
  title="Parameters"
  class="max-w-3xl"
  onclose={close}
>
  {#snippet children()}
    <p class="text-xs text-muted-foreground mb-3">
      Document-level named values + expressions. Used in feature inputs as
      <code class="font-mono">wallThickness</code> etc.
      <code class="font-mono">width = 2 * height + 5mm</code> works.
    </p>

    <div class="max-h-[24rem] overflow-y-auto -mx-1 px-1">
      {#if items.length === 0}
        <div class="py-10 text-center text-xs text-muted-foreground">
          No parameters yet. Add one below to define document-level values.
        </div>
      {:else}
        <table class="w-full text-xs border-collapse">
          <thead>
            <tr class="text-left text-muted-foreground border-b border-border">
              <th class="font-medium py-1.5 px-2 w-[22%]">Name</th>
              <th class="font-medium py-1.5 px-2">Expression / Value</th>
              <th class="font-medium py-1.5 px-2 w-[18%]">Evaluated</th>
              <th class="font-medium py-1.5 px-2 w-[10%]">Unit</th>
              <th class="font-medium py-1.5 px-2 w-8"></th>
            </tr>
          </thead>
          <tbody>
            {#each items as param (param.id)}
              <tr class="border-b border-border/50 hover:bg-accent/30 align-top">
                <td class="py-1.5 px-2">
                  <input
                    class={cellInputClass}
                    value={valueFor(param, 'name')}
                    oninput={(e) => scheduleCommit(param.id, 'name', e.currentTarget.value)}
                    spellcheck="false"
                    autocomplete="off"
                  />
                </td>
                <td class="py-1.5 px-2">
                  <input
                    class={cellInputClass}
                    value={valueFor(param, 'expression')}
                    oninput={(e) => scheduleCommit(param.id, 'expression', e.currentTarget.value)}
                    spellcheck="false"
                    autocomplete="off"
                  />
                  {#if param.error}
                    <div
                      class="mt-1 inline-block rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
                    >
                      {param.error}
                    </div>
                  {/if}
                </td>
                <td class="py-1.5 px-2">
                  <span class="text-muted-foreground font-mono text-xs">
                    {#if param.error || param.evaluated == null}
                      &mdash;
                    {:else}
                      = {format(param.evaluated, param.unit)}
                    {/if}
                  </span>
                </td>
                <td class="py-1.5 px-2">
                  <input
                    class={cellInputClass}
                    value={valueFor(param, 'unit')}
                    oninput={(e) => scheduleCommit(param.id, 'unit', e.currentTarget.value)}
                    placeholder="mm"
                    spellcheck="false"
                    autocomplete="off"
                  />
                </td>
                <td class="py-1.5 px-2 text-right">
                  <button
                    type="button"
                    aria-label="Delete parameter {param.name}"
                    title="Delete"
                    class="inline-flex items-center justify-center p-1 rounded hover:bg-accent"
                    onclick={() => removeParameter(param.id)}
                  >
                    <Trash2 class="size-3.5 text-muted-foreground hover:text-destructive" />
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>

    <!-- Add-parameter row -->
    <div class="mt-3 pt-3 border-t border-border">
      <div class="flex items-start gap-2">
        <input
          class={cellInputClass + ' flex-[0_0_22%]'}
          placeholder="name"
          bind:value={newName}
          onkeydown={onAddKeydown}
          spellcheck="false"
          autocomplete="off"
        />
        <input
          class={cellInputClass + ' flex-1'}
          placeholder="expression (e.g. 2 * height + 5mm)"
          bind:value={newExpression}
          onkeydown={onAddKeydown}
          spellcheck="false"
          autocomplete="off"
        />
        <Button size="sm" variant="outline" onclick={onAdd}>
          {#snippet children()}
            <Plus class="size-3.5" />
            Add
          {/snippet}
        </Button>
      </div>
      {#if newError}
        <div
          class="mt-1.5 inline-block rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
        >
          {newError}
        </div>
      {/if}
    </div>
  {/snippet}

  {#snippet footer()}
    <Button size="sm" variant="ghost" onclick={close}>
      {#snippet children()}Close{/snippet}
    </Button>
  {/snippet}
</Dialog>
