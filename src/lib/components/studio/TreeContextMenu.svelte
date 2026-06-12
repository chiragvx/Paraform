<script>
  /**
   * Right-click context menu for document-tree rows (features, parts,
   * components, groups). Generic: the opener supplies the item list, so one
   * menu serves every row kind.
   *
   * @prop menu     — { x, y, items: [{ id, label, danger? } | { divider: true }] } | null
   * @prop onclose  — dismiss callback
   * @prop onaction — (itemId) => void; parent dispatches to document ops
   */
  let { menu = null, onclose = () => {}, onaction = () => {} } = $props();

  function fire(id) {
    onaction(id);
    onclose();
  }

  function onKeydown(e) {
    if (e.key === 'Escape') onclose();
  }
</script>

{#if menu}
  <!-- click-outside scrim -->
  <div
    class="fixed inset-0 z-40"
    onclick={onclose}
    onkeydown={onKeydown}
    role="presentation"
  ></div>
  <ul
    class="fixed z-50 min-w-[10rem] rounded border border-border bg-card py-1 text-xs shadow-lg backdrop-blur-sm"
    style:left="{menu.x}px"
    style:top="{menu.y}px"
    role="menu"
  >
    {#each menu.items || [] as item, i (item.id || 'div-' + i)}
      {#if item.divider}
        <li class="my-1 border-t border-border"></li>
      {:else}
        <li>
          <button
            type="button"
            class={[
              'block w-full px-3 py-1 text-left hover:bg-accent',
              item.danger ? 'text-destructive hover:bg-destructive/10' : 'text-foreground',
            ]}
            onclick={() => fire(item.id)}
          >{item.label}</button>
        </li>
      {/if}
    {/each}
  </ul>
{/if}
