<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { AlertTriangle, Loader2 } from 'lucide-svelte';
  import { claimState, loadAttempt, parseCallback, signedIn } from '$lib/claim';
  import Medallion from '$lib/Medallion.svelte';
  import ZenButton from '$lib/zen/components/ZenButton.svelte';
  import ZenCard from '$lib/zen/components/ZenCard.svelte';

  let failed = $state<{ title: string; line: string; code?: string } | null>(null);
  // The claim this tab started: its link (salt included) is still in this tab's sessionStorage.
  let back = $state('');

  onMount(() => {
    const cb = parseCallback(location.hash);
    history.replaceState(history.state, '', location.pathname); // the id_token leaves the address bar and history at once
    const attempt = loadAttempt();
    if (attempt?.campaign && attempt.commitment) back = `/claim/${attempt.campaign}/${attempt.commitment}`;
    if ('error' in cb) {
      failed = cb.error === 'access_denied'
        ? { title: 'Sign-in cancelled', line: 'Your claim is still waiting. Sign in again when you are ready.' }
        : { title: 'Google sign-in did not finish', line: 'Google could not sign you in this time. Try again.', code: cb.error };
    } else if (!attempt?.destination || !attempt.attemptId || claimState(attempt.campaign, attempt.commitment, attempt.attemptId) !== cb.state) {
      failed = { title: 'This sign-in belongs to another tab', line: 'Start the sign-in again from your claim.' };
    } else {
      signedIn.idToken = cb.idToken;
      goto(`/claim/${attempt.campaign}/${attempt.commitment}/receipt`, { replaceState: true });
    }
  });
</script>

<svelte:head><title>Signing in · Zarf</title></svelte:head>

<div class="w-full max-w-lg mx-auto px-4 py-8 sm:py-14">
  <ZenCard variant="elevated" class="!p-6 sm:!p-8">
    <div class="flex flex-col items-center text-center gap-4 py-2">
      {#if failed}
        <Medallion icon={AlertTriangle} tone="error" />
        <h1 class="text-xl font-semibold tracking-tight">{failed.title}</h1>
        <p class="text-sm text-zen-fg-muted max-w-xs" role="alert">{failed.line}</p>
        {#if failed.code}<p class="text-xs text-zen-fg-muted">Code <span class="font-mono">{failed.code}</span></p>{/if}
        {#if back}
          <ZenButton href={back} variant="primary" class="rounded-full min-h-11 mt-2">Back to your claim</ZenButton>
        {:else}
          <p class="text-xs text-zen-fg-muted">Open the claim link from your email again.</p>
        {/if}
      {:else}
        <Medallion icon={Loader2} tone="muted" spin />
        <p class="text-sm text-zen-fg-muted" role="status">Signing you in…</p>
      {/if}
    </div>
  </ZenCard>
</div>
