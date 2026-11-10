<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { env } from '$env/dynamic/public';
  import { clearAttempt, isImplicitAccount, loadAttempt, signedIn } from '$lib/claim';
  import { canRetry, ClaimError, describeError, getClaimState, outcomeAfterRelay, requestSignature, submitClaim } from '$lib/services';
  import { formatAmount } from '$lib/create/recipients';
  import { describeStatus, getStatus, loadPayout, savePayout, submitDeposit, type StatusView } from '$lib/intents';

  const attempt = loadAttempt();
  const idToken = signedIn.idToken;
  const ok = !!idToken && !!attempt && attempt.campaign === page.params.campaign && attempt.commitment === page.params.commitment;

  let step = $state<'checking' | 'paying' | 'settling' | 'done' | 'reverted' | 'unsettled' | 'failed'>('checking');
  let error = $state('');
  let retryable = $state(true);
  let txHash = $state('');
  const explorer = $derived(env.PUBLIC_EXPLORER_TX_URL ? `${env.PUBLIC_EXPLORER_TX_URL}${txHash}` : '');
  // A reload after the NEAR claim has no sign-in left, but the payout it started can still be followed.
  const resumed = ok ? null : loadPayout(page.params.campaign!, page.params.commitment!);
  const payout = ok ? attempt!.intents : resumed;
  const depositAddress = ok ? attempt!.destination : (resumed?.depositAddress ?? '');
  let bridge = $state<StatusView | null>(null);
  const bridgeView = $derived(bridge && payout ? describeStatus(bridge, payout.chainName, payout.refundTo) : null);

  /** After the NEAR claim lands: follow the 1Click swap every 5 s until it settles. */
  async function followPayout(depositAddress: string) {
    void submitDeposit(depositAddress, txHash);
    for (let i = 0; i < 360; i++) { // 30 min, then stop and say where to look
      try {
        const s = await getStatus(depositAddress);
        if (s) bridge = s;
        if (bridgeView?.done) return;
      } catch {
        // keep polling: a status read failing says nothing about the swap
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    stalled = true;
  }
  let stalled = $state(false);

  onMount(async () => {
    if (resumed) {
      step = 'done';
      txHash = resumed.txHash;
      void followPayout(resumed.depositAddress);
      return;
    }
    if (!ok || !attempt) return;
    signedIn.idToken = null; // single use from here on
    try {
      // Past the request deadline 1Click starts refunding: never pay a deposit address that late.
      if (attempt.intents && Date.now() > Date.parse(attempt.intents.requestDeadline)) throw new ClaimError('QUOTE_EXPIRED');
      // Amount and proof come from the link, already checked against the chain root on the claim page;
      // the verifier checks them again against get_campaign before it signs.
      const args = await requestSignature(env.PUBLIC_VERIFIER_URL, {
        id_token: idToken,
        campaign_id: attempt.campaign,
        commitment: attempt.commitment,
        amount: attempt.amount,
        proof: attempt.proof,
        destination: attempt.destination,
        salt: attempt.salt,
        ...(attempt.intents ? { intents: { destination_asset: attempt.intents.assetId, recipient: attempt.intents.recipient } } : {}),
      });
      step = 'paying';
      const relay = await submitClaim(env.PUBLIC_RELAYER_URL, args); // a reverted transfer (409 E115) throws
      txHash = relay.txHash;
      step = 'settling';
      const state = await outcomeAfterRelay(relay, () => getClaimState(env.PUBLIC_NEAR_RPC_URL, env.PUBLIC_CONTRACT_ID, attempt.campaign, attempt.commitment));
      if (state === 'claimed') {
        step = 'done';
        clearAttempt(); // salt and destination are no longer needed in this tab
        if (attempt.intents) {
          const i = attempt.intents;
          savePayout(attempt.campaign, attempt.commitment, {
            depositAddress, txHash, chainName: i.chainName, recipient: i.recipient, refundTo: i.refundTo, amountOutFormatted: i.amountOutFormatted,
          });
          void followPayout(depositAddress);
        }
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

{#if !resumed && (!ok || !attempt)}
  <h1>Nothing to show yet</h1>
  <p class="muted">Open your claim link to start.</p>
{:else if payout}
  <h1>
    {#if step === 'checking'}Checking your claim…{:else if step === 'paying' || step === 'settling'}Sending your tokens…{:else if step === 'done'}{bridgeView?.done && bridgeView.ok ? `Arrived on ${payout.chainName}` : bridgeView?.done ? 'Not delivered' : `Sending to ${payout.chainName}…`}{:else if step === 'unsettled'}Still settling{:else}Not claimed{/if}
  </h1>
  <p>Funds go to: <code>{payout.recipient}</code> on {payout.chainName} (about {payout.amountOutFormatted} USDC)</p>
  {#if step === 'done'}
    <p role="status" class={bridgeView && !bridgeView.ok ? 'error' : ''}>{bridgeView?.text ?? 'Sent from NEAR, waiting for the bridge.'}</p>
    {#if bridge?.destinationTx}
      <p>
        {#if bridge.destinationTx.explorerUrl}<a href={bridge.destinationTx.explorerUrl} target="_blank" rel="noopener noreferrer">View it on {payout.chainName}</a>{:else}{payout.chainName} transaction: <code>{bridge.destinationTx.hash}</code>{/if}
      </p>
    {/if}
    {#if stalled && !bridgeView?.done}<p class="muted">Still processing after 30 minutes. Keep this page and the deposit address below, and contact the sender.</p>{/if}
    {#if (bridgeView?.done && !bridgeView.ok) || stalled}<p class="muted">1Click deposit address: <code>{depositAddress}</code></p>{/if}
    {#if explorer}<p class="muted"><a href={explorer} target="_blank" rel="noopener noreferrer">The NEAR claim transaction</a></p>{/if}
  {:else if step === 'reverted'}
    <p class="error" role="alert">The transfer failed and your claim is open again.</p>
    <p><a href="/claim/{page.params.campaign}/{page.params.commitment}">Try again</a></p>
  {:else if step === 'unsettled'}
    <p>The transaction was sent but has not settled yet. Check it on the explorer; there is no need to claim again.</p>
    {#if explorer}<p><a href={explorer} target="_blank" rel="noopener noreferrer">View the transaction</a></p>{/if}
  {:else if step === 'failed'}
    <p class="error" role="alert">{error}</p>
    {#if retryable}<p class="muted">Open your claim link to try again.</p>{/if}
  {/if}
{:else if attempt}
  <h1>
    {#if step === 'checking'}Checking your claim…{:else if step === 'paying' || step === 'settling'}Sending your tokens…{:else if step === 'done'}{formatAmount(BigInt(attempt.amount))} USDC sent to {attempt.destination}{:else if step === 'unsettled'}Still settling{:else}Not claimed{/if}
  </h1>
  {#if step !== 'done'}
    <p>Funds go to: <code>{attempt.destination}</code></p>
  {/if}
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
