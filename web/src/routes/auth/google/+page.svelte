<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
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

{#if error}
  <h1>Sign-in did not finish</h1>
  <p class="error" role="alert">{error}</p>
  <p class="muted">Open your claim link again and start over.</p>
{:else}
  <p class="muted">Signing you in…</p>
{/if}
