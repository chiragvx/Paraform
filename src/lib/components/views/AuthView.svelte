<script>
  import Button from '$lib/components/ui/button.svelte';
  import Input from '$lib/components/ui/input.svelte';
  import LogIn from '@lucide/svelte/icons/log-in';
  import Mail from '@lucide/svelte/icons/mail';
  import { session, isAuthConfigured, signInWithOtp, signInWithGoogle } from '$lib/auth/session.svelte.js';
  import { navigate } from '$lib/router.svelte.js';

  let email = $state('');
  let sending = $state(false);
  let sent = $state(false);
  let error = $state(null);

  const configured = isAuthConfigured();

  // Already signed in (or just completed sign-in via magic link / OAuth
  // redirect) → straight into the studio.
  $effect(() => {
    if (session.user) navigate('studio');
  });

  async function onGoogle() {
    error = null;
    const res = await signInWithGoogle();
    if (res.error) error = res.error;
    // On success the browser redirects to Google — nothing else to do here.
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (sending) return;
    error = null;
    sending = true;
    const res = await signInWithOtp(email);
    sending = false;
    if (res.error) {
      error = res.error;
    } else {
      sent = true;
    }
  }
</script>

<div class="h-full overflow-y-auto bg-background text-foreground">
  <div class="container max-w-md mx-auto px-6 py-16">
    <header class="text-center">
      <h1 class="text-3xl font-semibold tracking-tight">Sign in to ParaForm</h1>
      <p class="mt-2 text-sm text-muted-foreground">
        Pick up your projects from any device.
      </p>
    </header>

    <div class="mt-10 rounded-lg border border-border bg-card p-6">
      {#if !configured}
        <p class="text-sm text-muted-foreground text-center">
          Sign-in isn't configured on this deployment. Set
          <code class="text-xs">VITE_SUPABASE_URL</code> and
          <code class="text-xs">VITE_SUPABASE_PUBLISHABLE_KEY</code> to enable
          accounts — or head straight to the studio and work locally.
        </p>
      {:else if sent}
        <div class="text-center space-y-2">
          <Mail class="size-8 mx-auto text-primary" />
          <p class="text-sm font-medium text-card-foreground">Check your email</p>
          <p class="text-sm text-muted-foreground">
            We sent a magic link to <span class="font-medium text-card-foreground">{email}</span>.
            Click it to finish signing in.
          </p>
          <button
            class="text-xs text-muted-foreground underline hover:text-foreground"
            onclick={() => { sent = false; error = null; }}
          >
            Use a different email
          </button>
        </div>
      {:else}
        <Button variant="outline" class="w-full" onclick={onGoogle}>
          <LogIn class="size-4" />
          Continue with Google
        </Button>

        <div class="my-6 flex items-center gap-3">
          <div class="h-px flex-1 bg-border"></div>
          <span class="text-xs uppercase tracking-wider text-muted-foreground">or</span>
          <div class="h-px flex-1 bg-border"></div>
        </div>

        <form onsubmit={onSubmit} class="space-y-3">
          <label for="email" class="block text-sm font-medium text-card-foreground">
            Email
          </label>
          <Input
            id="email"
            type="email"
            required
            placeholder="you@example.com"
            bind:value={email}
          />
          <Button type="submit" class="w-full" disabled={sending}>
            <Mail class="size-4" />
            {sending ? 'Sending…' : 'Send magic link'}
          </Button>
        </form>
      {/if}

      {#if error}
        <p class="mt-4 text-sm text-destructive text-center" role="alert">{error}</p>
      {/if}
    </div>

    <p class="mt-6 text-center text-xs text-muted-foreground">
      By continuing you agree to our terms &amp; privacy policy.
    </p>
  </div>
</div>
