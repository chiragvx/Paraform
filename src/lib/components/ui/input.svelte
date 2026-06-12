<script>
  import { cn } from '$lib/utils.js';

  let { class: className = '', value = $bindable(''), ...rest } = $props();
</script>

<input
  bind:value
  class={cn(
    'flex h-8 w-full rounded-md border border-input bg-transparent px-2.5 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
    className,
  )}
  {...rest}
/>
