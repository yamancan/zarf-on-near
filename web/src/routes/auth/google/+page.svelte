<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { AlertTriangle, Loader2 } from 'lucide-svelte';
  import { claimState, loadAttempt, parseCallback, signedIn } from '$lib/claim';

  let error = $state('');

  onMount(() => {
    const cb = parseCallback(location.hash);
    history.replaceState(history.state, '', location.pathname); // the id_token leaves the address bar and history at once
    const attempt = loadAttempt();
    if ('error' in cb) {
      error = cb.error === 'access_denied' ? 'Google sign-in was cancelled.' : `Google sign-in failed (${cb.error}).`;
    } else if (!attempt?.destination || !attempt.attemptId || claimState(attempt.campaign, attempt.commitment, attempt.attemptId) !== cb.state) {
      error = 'This sign-in does not match a claim started in this tab.';
    } else {
      signedIn.idToken = cb.idToken;
      goto(`/claim/${attempt.campaign}/${attempt.commitment}/receipt`, { replaceState: true });
    }
  });
</script>

<svelte:head><title>Signing in · Zarf</title></svelte:head>

<section class="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center px-6">
  {#if error}
    <div class="w-14 h-14 rounded-full bg-zen-error/5 text-zen-error border border-zen-error/10 flex items-center justify-center" aria-hidden="true"><AlertTriangle class="w-6 h-6" /></div>
    <h1 class="text-2xl font-semibold tracking-tight">Sign-in did not finish</h1>
    <p class="text-sm text-zen-error" role="alert">{error}</p>
    <p class="text-xs text-zen-fg-subtle">Open your claim link again and start over.</p>
  {:else}
    <div class="w-14 h-14 rounded-full bg-zen-fg/5 text-zen-fg-muted border border-zen-border-subtle flex items-center justify-center" aria-hidden="true"><Loader2 class="w-6 h-6 animate-spin" /></div>
    <p class="text-sm text-zen-fg-muted" role="status">Signing you in…</p>
  {/if}
</section>
