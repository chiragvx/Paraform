<script>
  /**
   * Spec 08 — Repair loop panel.
   *
   * Textarea for the user's natural-language spec, "Generate" button
   * drives runRepairLoop, the iteration log shows each pass's failures
   * + LLM proposal, "Accept" merges the ops list onto the live document.
   *
   * The Generate run uses a scratch store (resetDoc=true), so the live
   * document is untouched until Accept. Accept replays the ops against
   * the live store.
   */
  import { runRepairLoop } from '$lib/repair/loop.js';
  import { applyOps } from '$lib/repair/loop.js';
  import { recordRepairRun } from '$lib/repair/telemetry.js';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Check from '@lucide/svelte/icons/check';
  import AlertTriangle from '@lucide/svelte/icons/alert-triangle';

  let specText = $state('');
  let running  = $state(false);
  let result   = $state(null);

  async function generate() {
    if (!specText.trim() || running) return;
    running = true;
    try {
      // Scratch run — leaves the live doc alone.
      result = await runRepairLoop({ specText, resetDoc: true });
      try { await recordRepairRun(result, { goal: specText, label: 'studio' }); }
      catch { /* telemetry never blocks the UI */ }
    } catch (e) {
      result = { success: false, error: (e && e.message) || String(e), iterations: [] };
    } finally {
      running = false;
    }
  }

  function accept() {
    if (!result || !result.ops || result.ops.length === 0) return;
    applyOps(result.ops);
    result = null;
    specText = '';
  }

  function iconFor(passed) {
    return passed ? Check : AlertTriangle;
  }
</script>

<div class="flex h-full flex-col gap-3 p-3 text-sm">
  <header class="flex items-center gap-2">
    <Sparkles class="size-4 text-amber-500" />
    <span class="font-medium">AI repair loop</span>
  </header>

  <textarea
    bind:value={specText}
    placeholder="e.g. 60×40×3 mm aluminum plate with four M3 clearance holes 5 mm from each edge"
    rows="4"
    class="w-full resize-y rounded-md border border-neutral-300 bg-white p-2 text-sm
           focus:border-amber-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900"
    disabled={running}
  ></textarea>

  <div class="flex items-center gap-2">
    <button
      type="button"
      onclick={generate}
      disabled={running || !specText.trim()}
      class="rounded-md bg-amber-500 px-3 py-1.5 text-white shadow-sm
             disabled:cursor-not-allowed disabled:opacity-50 hover:bg-amber-600"
    >
      {running ? 'Working…' : 'Generate'}
    </button>
    {#if result && result.ops && result.ops.length > 0}
      <button
        type="button"
        onclick={accept}
        class="rounded-md bg-emerald-600 px-3 py-1.5 text-white shadow-sm hover:bg-emerald-700"
      >
        Accept ({result.ops.length} ops)
      </button>
    {/if}
  </div>

  {#if result}
    <section class="flex flex-col gap-2 overflow-y-auto rounded-md border border-neutral-200 p-2 dark:border-neutral-800">
      <div class="flex items-center justify-between text-xs">
        <span class="font-medium">
          {result.success ? 'Passed' : 'Did not converge'}
        </span>
        <span class="text-neutral-500">
          {result.iterations?.length ?? 0} iter, {result.llmCalls ?? 0} LLM calls
        </span>
      </div>

      {#each (result.iterations || []) as iter (iter.iter)}
        {@const Icon = iconFor(iter.passed)}
        <details class="rounded border border-neutral-200 p-2 text-xs dark:border-neutral-800">
          <summary class="flex cursor-pointer items-center gap-2">
            <Icon class="size-3 {iter.passed ? 'text-emerald-600' : 'text-amber-600'}" />
            <span>Pass {iter.iter + 1} — {iter.opsApplied} ops, {iter.failures.length} failures</span>
          </summary>
          {#if iter.llmRationale}
            <p class="mt-1 text-neutral-600 dark:text-neutral-400">LLM: {iter.llmRationale}</p>
          {/if}
          {#if iter.failures.length}
            <ul class="mt-1 list-disc pl-4 text-neutral-600 dark:text-neutral-400">
              {#each iter.failures.slice(0, 5) as f}
                <li>
                  <span class="font-mono text-[10px] text-neutral-500">[{f.source}]</span>
                  {f.result?.message ?? f.id}
                </li>
              {/each}
            </ul>
          {/if}
        </details>
      {/each}
    </section>
  {/if}
</div>
