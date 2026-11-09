<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { env } from '$env/dynamic/public';
  import { clearAttempt, isImplicitAccount, loadAttempt, signedIn } from '$lib/claim';
  import { checkedProof } from '$lib/merkle';
  import { ClaimError, describeError, fetchLeaves, getCampaign, requestSignature, submitClaim } from '$lib/services';

  const attempt = loadAttempt();
  const idToken = signedIn.idToken;
  const ok = !!idToken && !!attempt && attempt.campaign === page.params.campaign && attempt.commitment === page.params.commitment;

  let step = $state<'checking' | 'paying' | 'done' | 'failed'>('checking');
  let error = $state('');
  let txHash = $state('');
  const explorer = $derived(env.PUBLIC_EXPLORER_TX_URL ? `${env.PUBLIC_EXPLORER_TX_URL}${txHash}` : '');

  onMount(async () => {
    if (!ok || !attempt) return;
    signedIn.idToken = null; // single use from here on
    try {
      const [list, campaign] = await Promise.all([
        fetchLeaves(env.PUBLIC_LEAVES_URL, attempt.campaign),
        getCampaign(env.PUBLIC_NEAR_RPC_URL, env.PUBLIC_CONTRACT_ID, attempt.campaign),
      ]);
      if (!campaign) throw new ClaimError('E110_UNKNOWN_CAMPAIGN');
      const found = await checkedProof(list, campaign.merkle_root, attempt.commitment);
      const args = await requestSignature(env.PUBLIC_VERIFIER_URL, {
        id_token: idToken,
        campaign_id: attempt.campaign,
        commitment: attempt.commitment,
        amount: found.amount,
        proof: found.proof,
        destination: attempt.destination,
        salt: attempt.salt,
      });
      step = 'paying';
      txHash = await submitClaim(env.PUBLIC_RELAYER_URL, args);
      step = 'done';
      clearAttempt(); // salt and destination are no longer needed in this tab
    } catch (e) {
      error = describeError(e);
      step = 'failed';
    }
  });
</script>

{#if !ok || !attempt}
  <h1>Nothing to show yet</h1>
  <p class="muted">Open your claim link to start.</p>
{:else}
  <h1>
    {#if step === 'checking'}Checking your claim…{:else if step === 'paying'}Sending your tokens…{:else if step === 'done'}Claimed{:else}Not claimed{/if}
  </h1>
  <p>Funds go to: <code>{attempt.destination}</code></p>
  {#if step === 'done'}
    {#if explorer}
      <p><a href={explorer} target="_blank" rel="noopener noreferrer">View the transaction</a></p>
    {:else}
      <p>Transaction: <code>{txHash}</code></p>
    {/if}
    {#if isImplicitAccount(attempt.destination)}
      <p>To move these funds later, this account needs a little NEAR for gas.</p>
    {/if}
  {:else if step === 'failed'}
    <p class="error" role="alert">{error}</p>
    <p class="muted">Open your claim link to try again.</p>
  {/if}
{/if}
