<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { env } from '$env/dynamic/public';
  import { clearAttempt, isImplicitAccount, loadAttempt, signedIn } from '$lib/claim';
  import { checkedProof } from '$lib/merkle';
  import { canRetry, ClaimError, describeError, fetchLeaves, getCampaign, getClaimState, outcomeAfterRelay, requestSignature, submitClaim } from '$lib/services';

  const attempt = loadAttempt();
  const idToken = signedIn.idToken;
  const ok = !!idToken && !!attempt && attempt.campaign === page.params.campaign && attempt.commitment === page.params.commitment;

  let step = $state<'checking' | 'paying' | 'settling' | 'done' | 'reverted' | 'unsettled' | 'failed'>('checking');
  let error = $state('');
  let retryable = $state(true);
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
      const relay = await submitClaim(env.PUBLIC_RELAYER_URL, args); // a reverted transfer (409 E115) throws
      txHash = relay.txHash;
      step = 'settling';
      const state = await outcomeAfterRelay(relay, () => getClaimState(env.PUBLIC_NEAR_RPC_URL, env.PUBLIC_CONTRACT_ID, attempt.campaign, attempt.commitment));
      if (state === 'claimed') {
        step = 'done';
        clearAttempt(); // salt and destination are no longer needed in this tab
      } else {
        step = state === 'unclaimed' ? 'reverted' : 'unsettled'; // the attempt stays, so a retry keeps the salt
      }
    } catch (e) {
      // The relayer saw claim_reverted: same state as a reopened claim, with the retry link.
      if (e instanceof ClaimError && e.code === 'E115_TOKEN_TRANSFER_FAILED') step = 'reverted';
      else {
        error = describeError(e);
        retryable = canRetry(e);
        step = 'failed';
      }
    }
  });
</script>

{#if !ok || !attempt}
  <h1>Nothing to show yet</h1>
  <p class="muted">Open your claim link to start.</p>
{:else}
  <h1>
    {#if step === 'checking'}Checking your claim…{:else if step === 'paying' || step === 'settling'}Sending your tokens…{:else if step === 'done'}Claimed{:else if step === 'unsettled'}Still settling{:else}Not claimed{/if}
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
  {:else if step === 'reverted'}
    <p class="error" role="alert">The transfer failed and your claim is open again.</p>
    <p><a href="/claim/{attempt.campaign}/{attempt.commitment}">Try again</a></p>
  {:else if step === 'unsettled'}
    <p>The transaction was sent but has not settled yet. Check it on the explorer; there is no need to claim again.</p>
    {#if explorer}<p><a href={explorer} target="_blank" rel="noopener noreferrer">View the transaction</a></p>{/if}
  {:else if step === 'failed'}
    <p class="error" role="alert">{error}</p>
    {#if retryable}<p class="muted">Open your claim link to try again.</p>{/if}
  {/if}
{/if}
