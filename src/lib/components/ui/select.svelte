<script>
  import { cn } from '$lib/utils.js';

  let { class: className = '', value = $bindable(''), options = [], ...rest } = $props();
</script>

<select
  bind:value
  class={cn(
    'flex h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
    className,
  )}
  {...rest}
>
  {#each options as opt (typeof opt === 'object' ? opt.value : opt)}
    {#if typeof opt === 'object'}
      <option value={opt.value}>{opt.label}</option>
    {:else}
      <option value={opt}>{opt}</option>
    {/if}
  {/each}
</select>
