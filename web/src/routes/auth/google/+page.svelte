<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { AlertTriangle, ChevronDown, Loader2, Mail } from 'lucide-svelte';
  import { formatAmount } from '$lib/create/recipients';
  import { UNIT } from '$lib/network';
  import { claimState, loadAttempt, parseCallback, signedIn } from '$lib/claim';
  import Medallion from '$lib/Medallion.svelte';
  import ZenButton from '$lib/zarf-kit/components/ui/ZenButton.svelte';
  import ZenCard from '$lib/zarf-kit/components/ui/ZenCard.svelte';

  let failed = $state<{ title: string; line: string; code?: string; cancelled?: boolean } | null>(null);
  // The claim this tab started: its link (salt included) is still in this tab's sessionStorage.
  let back = $state('');

  onMount(() => {
    const cb = parseCallback(location.hash);
    history.replaceState(history.state, '', location.pathname); // the id_token leaves the address bar and history at once
    const attempt = loadAttempt();
    if (attempt?.campaign && attempt.commitment) back = `/claim/${attempt.campaign}/${attempt.commitment}`;
    // Cancelling is not an error: the claim waits (flow canvas). The amount comes from this tab's own link.
    const waiting = attempt && /^[1-9]\d{0,38}$/.test(attempt.amount) ? `Your ${formatAmount(BigInt(attempt.amount))} ${UNIT} is still waiting.` : 'Your claim is still waiting.';
    if ('error' in cb) {
      failed = cb.error === 'access_denied'
        ? { title: 'Sign-In Cancelled', line: back ? `${waiting} Sign in again when you are ready.` : 'Open your claim link again to sign in.', cancelled: true }
        : { title: 'Sign-In Did Not Finish', line: 'Google could not sign you in this time. Try again.', code: cb.error };
    } else if (!attempt?.destination || !attempt.attemptId || claimState(attempt.campaign, attempt.commitment, attempt.attemptId) !== cb.state) {
      failed = { title: 'Sign-In From Another Tab', line: 'Start the sign-in again from your claim.' };
    } else {
      signedIn.idToken = cb.idToken;
      goto(`/claim/${attempt.campaign}/${attempt.commitment}/receipt`, { replaceState: true });
    }
  });
</script>

<svelte:head><title>Signing in · Zarf</title></svelte:head>

<div class="w-full max-w-lg mx-auto px-4 sm:px-6 lg:px-8 py-8 md:py-12">
  <ZenCard variant="elevated" padding="lg">
    <div class="flex flex-col items-center text-center gap-4 py-2">
      {#if failed}
        {#if failed.cancelled}
          <Medallion icon={Mail} />
        {:else}
          <Medallion icon={AlertTriangle} tone="error" />
        {/if}
        <h1 class="text-xl font-bold">{failed.title}</h1>
        <p class="text-sm text-zen-fg-muted max-w-xs" role={failed.cancelled ? 'status' : 'alert'}>{failed.line}</p>
        {#if back}
          <a href={back} class="block w-full sm:w-auto"><ZenButton tabindex={-1} variant="primary" class="w-full sm:w-auto">Back to Claim</ZenButton></a>
        {:else}
          {#if !failed.cancelled}<p class="text-xs text-zen-fg-muted max-w-xs">Open your claim link again to try once more.</p>{/if}
          <a href="/" class="inline-block"><ZenButton tabindex={-1} variant="secondary">What Is Zarf?</ZenButton></a>
        {/if}
        {#if failed.code}
          <details class="group text-xs text-zen-fg-muted">
            <summary class="inline-flex items-center gap-1.5 py-1 cursor-pointer list-none hover:text-zen-fg">Details <ChevronDown class="w-3.5 h-3.5 transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
            <p>Code <span class="font-mono">{failed.code}</span></p>
          </details>
        {/if}
      {:else}
        <Medallion icon={Loader2} tone="muted" spin />
        <h1 class="text-xl font-bold" role="status">Signing In…</h1>
      {/if}
    </div>
  </ZenCard>
</div>
