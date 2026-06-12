<script>
  import { cn } from '$lib/utils.js';

  let { orientation = 'horizontal', class: className = '' } = $props();
</script>

<div
  role="separator"
  aria-orientation={orientation}
  class={cn(
    'bg-border shrink-0',
    orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
    className,
  )}
></div>
