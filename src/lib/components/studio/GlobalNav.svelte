<script>
  import { navigate, router } from '$lib/router.svelte.js';
  import Button from '$lib/components/ui/button.svelte';
  import Hexagon from '@lucide/svelte/icons/hexagon';
  import { session, signOut } from '$lib/auth/session.svelte.js';
  import { openBillingPortal } from '$lib/billing.js';

  const links = [
    { name: 'Home', route: 'landing' },
    { name: 'Manage', route: 'manage' },
    { name: 'Pricing', route: 'pricing' },
  ];

  async function onSignOut() {
    await signOut();
    navigate('landing');
  }

  async function onManageBilling() {
    try {
      await openBillingPortal();
    } catch {
      // Fall back to the pricing page if the portal can't be opened.
      navigate('pricing');
    }
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
        <span class="hidden sm:inline text-sm text-muted-foreground truncate max-w-40">
          {session.user.email}
        </span>
        {#if session.plan === 'paid'}
          <span class="hidden sm:inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            Pro
          </span>
          <Button class="hidden sm:inline-flex" variant="ghost" size="sm" onclick={onManageBilling}>
            Manage billing
          </Button>
        {:else}
          <span class="hidden sm:inline-flex items-center rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-muted-foreground">
            Free
          </span>
          <Button class="hidden sm:inline-flex" size="sm" onclick={() => navigate('pricing')}>
            Upgrade
          </Button>
        {/if}
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
