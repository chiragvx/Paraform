<script>
  import { navigate } from '$lib/router.svelte.js';
  import Button from '$lib/components/ui/button.svelte';
  import { session } from '$lib/auth/session.svelte.js';
  import { startCheckout, openBillingPortal } from '$lib/billing.js';
  import Check from '@lucide/svelte/icons/check';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Zap from '@lucide/svelte/icons/zap';

  let upgrading = $state(false);
  let managing = $state(false);
  let error = $state('');

  const freeBullets = [
    '15 AI generations/day',
    '60 compiles/day',
    'Full studio + STL/STEP export',
    'Verified parts library',
  ];

  const proBullets = [
    '200 AI generations/day',
    '1000 compiles/day',
    'Priority compiles',
    'Everything in Free',
  ];

  // ?checkout=cancel lands here from the checkout cancel_url.
  const canceled =
    typeof window !== 'undefined' &&
    (window.location.hash || '').includes('checkout=cancel');

  async function onUpgrade() {
    error = '';
    if (!session.user) {
      navigate('auth');
      return;
    }
    upgrading = true;
    try {
      await startCheckout(); // redirects on success
    } catch (e) {
      error = e?.message || 'Something went wrong. Please try again.';
    } finally {
      upgrading = false;
    }
  }

  async function onManage() {
    error = '';
    managing = true;
    try {
      await openBillingPortal(); // redirects on success
    } catch (e) {
      error = e?.message || 'Could not open the billing portal.';
    } finally {
      managing = false;
    }
  }
</script>

<div class="h-full overflow-y-auto bg-background text-foreground">
  <div class="container max-w-5xl mx-auto px-6 py-16 sm:py-24">
    <!-- Header -->
    <header class="text-center">
      <h1 class="text-3xl sm:text-5xl font-semibold tracking-tight">Simple pricing</h1>
      <p class="mt-4 text-lg text-muted-foreground max-w-xl mx-auto">
        Start free. Upgrade when you need more headroom — no contracts, cancel anytime.
      </p>
    </header>

    {#if canceled}
      <div class="mt-8 mx-auto max-w-md rounded-md border border-border bg-card px-4 py-2 text-center text-sm text-muted-foreground">
        Checkout canceled — you can pick up where you left off whenever you're ready.
      </div>
    {/if}

    {#if error}
      <div class="mt-8 mx-auto max-w-md rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-center text-sm text-destructive">
        {error}
      </div>
    {/if}

    <!-- Cards -->
    <div class="mt-12 grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
      <!-- Free -->
      <div class="rounded-xl border border-border bg-card p-8 flex flex-col">
        <h2 class="text-lg font-medium text-card-foreground">Free</h2>
        <div class="mt-3 flex items-baseline gap-1">
          <span class="text-4xl font-semibold tracking-tight">$0</span>
          <span class="text-sm text-muted-foreground">/month</span>
        </div>
        <p class="mt-2 text-sm text-muted-foreground">Everything you need to start designing.</p>

        <ul class="mt-6 space-y-3 flex-1">
          {#each freeBullets as b}
            <li class="flex items-start gap-2.5 text-sm">
              <Check class="size-4 mt-0.5 text-primary shrink-0" />
              <span class="text-card-foreground">{b}</span>
            </li>
          {/each}
        </ul>

        <div class="mt-8">
          {#if !session.user}
            <Button class="w-full" variant="outline" onclick={() => navigate('auth')}>
              Start free
            </Button>
          {:else if session.plan === 'paid'}
            <Button class="w-full" variant="outline" disabled>Included with Pro</Button>
          {:else}
            <Button class="w-full" variant="outline" disabled>Current plan</Button>
          {/if}
        </div>
      </div>

      <!-- Pro -->
      <div class="relative rounded-xl border-2 border-primary bg-card p-8 flex flex-col ring-1 ring-primary/20 shadow-sm">
        <span class="absolute -top-3 left-1/2 -translate-x-1/2 inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground">
          <Sparkles class="size-3" />
          Most popular
        </span>

        <h2 class="flex items-center gap-2 text-lg font-medium text-card-foreground">
          <Zap class="size-4 text-primary" />
          Pro
        </h2>
        <div class="mt-3 flex items-baseline gap-1">
          <span class="text-4xl font-semibold tracking-tight">$9.99</span>
          <span class="text-sm text-muted-foreground">/month</span>
        </div>
        <p class="mt-2 text-sm text-muted-foreground">For makers shipping real work, daily.</p>

        <ul class="mt-6 space-y-3 flex-1">
          {#each proBullets as b}
            <li class="flex items-start gap-2.5 text-sm">
              <Check class="size-4 mt-0.5 text-primary shrink-0" />
              <span class="text-card-foreground">{b}</span>
            </li>
          {/each}
        </ul>

        <div class="mt-8">
          {#if session.plan === 'paid'}
            <div class="mb-3 rounded-md bg-primary/10 px-3 py-2 text-center text-sm font-medium text-primary">
              You're on Pro
            </div>
            <Button class="w-full" variant="outline" onclick={onManage} disabled={managing}>
              {managing ? 'Opening…' : 'Manage billing'}
            </Button>
          {:else}
            <Button class="w-full" onclick={onUpgrade} disabled={upgrading}>
              {upgrading ? 'Redirecting…' : 'Upgrade to Pro'}
            </Button>
          {/if}
        </div>
      </div>
    </div>

    <p class="mt-10 text-center text-sm text-muted-foreground">
      Prices in USD. Billed monthly. Cancel anytime from the billing portal.
    </p>
  </div>
</div>
