<script>
  import { navigate, router } from '$lib/router.svelte.js';
  import Button from '$lib/components/ui/button.svelte';
  import Hexagon from '@lucide/svelte/icons/hexagon';
  import { session, signOut } from '$lib/auth/session.svelte.js';

  const links = [
    { name: 'Home', route: 'landing' },
    { name: 'Explore', route: 'explore' },
    { name: 'Manage', route: 'manage' },
  ];

  async function onSignOut() {
    await signOut();
    navigate('landing');
  }
</script>

<header class="border-b border-border bg-background">
  <div class="container max-w-6xl mx-auto px-6 h-14 flex items-center justify-between gap-6">
    <button
      class="flex items-center gap-2 text-foreground hover:text-primary transition-colors"
      onclick={() => navigate('landing')}
      aria-label="ParaForm home"
    >
      <Hexagon class="size-5 text-primary" />
      <span class="text-base font-semibold tracking-tight">ParaForm</span>
    </button>

    <nav class="hidden sm:flex items-center gap-1">
      {#each links as l}
        <button
          class="rounded-md px-3 py-1.5 text-sm transition-colors {router.route === l.route ? 'text-foreground bg-accent' : 'text-muted-foreground hover:text-foreground hover:bg-accent'}"
          onclick={() => navigate(l.route)}
        >
          {l.name}
        </button>
      {/each}
    </nav>

    <div class="flex items-center gap-2">
      {#if session.user}
        <span class="hidden sm:inline text-sm text-muted-foreground truncate max-w-48">
          {session.user.email}
        </span>
        <Button variant="ghost" size="sm" onclick={onSignOut}>
          Sign out
        </Button>
      {:else}
        <Button variant="ghost" size="sm" onclick={() => navigate('auth')}>
          Sign in
        </Button>
      {/if}
      <Button size="sm" onclick={() => navigate('studio')}>
        Launch Studio
      </Button>
    </div>
  </div>
</header>
