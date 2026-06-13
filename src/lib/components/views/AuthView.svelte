<script>
  import Button from '$lib/components/ui/button.svelte';
  import Input from '$lib/components/ui/input.svelte';
  import LogIn from '@lucide/svelte/icons/log-in';
  import Mail from '@lucide/svelte/icons/mail';
  import Hexagon from '@lucide/svelte/icons/hexagon';
  import Boxes from '@lucide/svelte/icons/boxes';
  import Box from '@lucide/svelte/icons/box';
  import Download from '@lucide/svelte/icons/download';
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
  <div class="mx-auto grid min-h-full w-full max-w-6xl grid-cols-1 items-stretch gap-0 md:grid-cols-2">
    <!-- Brand / hero panel -->
    <section
      class="flex flex-col justify-center gap-8 rounded-none bg-gradient-to-br from-primary/10 via-background to-background px-8 py-12 md:rounded-l-2xl md:px-12 md:py-16"
    >
      <div class="flex items-center gap-3">
        <div class="flex size-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <Hexagon class="size-6" />
        </div>
        <span class="text-lg font-semibold tracking-tight">ParaForm</span>
      </div>

      <div class="space-y-3">
        <h1 class="text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
          Describe a machine.<br />Get a printable assembly.
        </h1>
        <p class="max-w-md text-sm text-muted-foreground">
          ParaForm turns a plain-language brief into a real, parametric,
          print-ready build — no CAD wrangling required.
        </p>
      </div>

      <ul class="space-y-4">
        <li class="flex items-start gap-3">
          <span class="mt-0.5 flex size-8 items-center justify-center rounded-lg bg-accent text-primary">
            <Boxes class="size-4" />
          </span>
          <span class="text-sm text-card-foreground">
            AI-assembled from a verified parts library
          </span>
        </li>
        <li class="flex items-start gap-3">
          <span class="mt-0.5 flex size-8 items-center justify-center rounded-lg bg-accent text-primary">
            <Box class="size-4" />
          </span>
          <span class="text-sm text-card-foreground">
            Auto-fitted enclosures around your design
          </span>
        </li>
        <li class="flex items-start gap-3">
          <span class="mt-0.5 flex size-8 items-center justify-center rounded-lg bg-accent text-primary">
            <Download class="size-4" />
          </span>
          <span class="text-sm text-card-foreground">
            Download print-ready STL in one click
          </span>
        </li>
      </ul>
    </section>

    <!-- Sign-in panel -->
    <section class="flex items-center justify-center px-6 py-12 md:px-12 md:py-16">
      <div class="w-full max-w-sm">
        <header>
          <h2 class="text-2xl font-semibold tracking-tight">Sign in to ParaForm</h2>
          <p class="mt-2 text-sm text-muted-foreground">
            Pick up your projects from any device.
          </p>
        </header>

        <div class="mt-8 rounded-xl border border-border bg-card p-6 shadow-sm">
      {#if !configured}
        <div class="space-y-4 text-center">
          <p class="text-sm text-muted-foreground">
            Accounts aren't set up yet — you can keep working locally. Your
            project stays on this device.
          </p>
          <Button class="w-full" onclick={() => navigate('studio')}>
            Continue to the studio
          </Button>
        </div>
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
    </section>
  </div>
</div>
