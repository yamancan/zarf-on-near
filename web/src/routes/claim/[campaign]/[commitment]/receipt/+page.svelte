<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { env } from '$env/dynamic/public';
  import { clearAttempt, isImplicitAccount, loadAttempt, signedIn } from '$lib/claim';
  import { canRetry, ClaimError, describeError, getClaimState, outcomeAfterRelay, requestSignature, submitClaim } from '$lib/services';
  import { formatAmount } from '$lib/create/recipients';
  import { AlertTriangle, ArrowUpRight, Check, Clock, Loader2, Mail, Undo2 } from 'lucide-svelte';
  import ZenCard from '$lib/zen/components/ZenCard.svelte';
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
  const working = $derived(step === 'checking' || step === 'paying' || step === 'settling');

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

<svelte:head><title>Your claim · Zarf</title></svelte:head>

{#snippet medallion(Icon: typeof Mail, tone: 'success' | 'error' | 'muted', spin = false)}
  <div
    class="w-14 h-14 rounded-full flex items-center justify-center shrink-0 border
      {tone === 'success' ? 'bg-zen-success/10 text-zen-success border-zen-success/10'
      : tone === 'error' ? 'bg-zen-error/5 text-zen-error border-zen-error/10'
      : 'bg-zen-fg/5 text-zen-fg-muted border-zen-border-subtle'}"
    aria-hidden="true"
  >
    <Icon class="w-6 h-6 {spin ? 'animate-spin' : ''}" />
  </div>
{/snippet}

{#snippet pill(href: string, text: string)}
  <a {href} target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1.5 min-h-11 px-5 rounded-full text-sm font-medium no-underline text-zen-fg bg-zen-fg/5 hover:bg-zen-fg/10 transition-colors">
    {text}<ArrowUpRight class="w-3.5 h-3.5" aria-hidden="true" />
  </a>
{/snippet}

{#snippet retry(href: string)}
  <a {href} class="inline-flex items-center min-h-11 px-5 rounded-full text-sm font-medium no-underline bg-zen-fg text-zen-bg">Try again</a>
{/snippet}

{#snippet failure()}
  {#if step === 'reverted'}
    <p class="text-sm text-zen-error" role="alert">The transfer failed and your claim is open again.</p>
    {@render retry(`/claim/${page.params.campaign}/${page.params.commitment}`)}
  {:else if step === 'unsettled'}
    <p class="text-sm text-zen-fg-muted">The transaction was sent but has not settled yet. There is no need to claim again.</p>
    {#if explorer}{@render pill(explorer, 'View the transaction')}{/if}
  {:else if step === 'failed'}
    <p class="text-sm text-zen-error" role="alert">{error}</p>
    {#if retryable}<p class="text-xs text-zen-fg-subtle">Open your claim link to try again.</p>{/if}
  {/if}
{/snippet}

<div class="w-full max-w-md mx-auto px-4 py-8 sm:py-14">
  <ZenCard variant="glass" padding="lg" radius="3xl" class="!p-6 sm:!p-8">
    <div class="flex flex-col items-center text-center gap-4">
      {#if !resumed && (!ok || !attempt)}
        {@render medallion(Mail, 'muted')}
        <h1 class="text-2xl font-semibold tracking-tight">Nothing to show yet</h1>
        <p class="text-sm text-zen-fg-muted">Open your claim link to start.</p>
        <a href="/" class="inline-flex items-center min-h-11 px-5 rounded-full text-sm font-medium no-underline text-zen-fg-muted hover:text-zen-fg bg-zen-fg/5">What is Zarf?</a>
      {:else if payout}
        {@const arrived = !!bridgeView?.done && bridgeView.ok}
        {@const returned = !!bridgeView?.done && !bridgeView.ok}
        {#if working || (step === 'done' && !bridgeView?.done)}
          {@render medallion(Loader2, 'muted', true)}
        {:else if arrived}
          {@render medallion(Check, 'success')}
        {:else if returned}
          {@render medallion(Undo2, 'error')}
        {:else if step === 'unsettled'}
          {@render medallion(Clock, 'muted')}
        {:else}
          {@render medallion(AlertTriangle, 'error')}
        {/if}
        <h1 class="text-2xl font-semibold tracking-tight">
          {#if step === 'checking'}Checking your claim…{:else if step === 'paying' || step === 'settling'}Sending your tokens…{:else if step === 'done'}{bridgeView?.done && bridgeView.ok ? `Arrived on ${payout.chainName}` : bridgeView?.done ? 'Not delivered' : `Sending to ${payout.chainName}…`}{:else if step === 'unsettled'}Still settling{:else}Not claimed{/if}
        </h1>
        <p class="flex flex-col items-center gap-1">
          <span class="text-4xl font-bold tracking-tighter tabular-nums {arrived ? 'text-zen-success' : returned ? 'text-zen-fg-subtle line-through' : ''}">{arrived ? '' : '~'}{payout.amountOutFormatted} USDC</span>
          <span class="text-xs text-zen-fg-subtle">to <span class="font-mono break-all">{payout.recipient}</span> on {payout.chainName}</span>
        </p>
        {#if step === 'done'}
          <!-- Two legs, one dot each: the NEAR claim, then the 1Click payout -->
          <ol class="w-full flex flex-col gap-3 text-left text-sm border-y-[0.5px] border-zen-border-subtle py-4 my-1">
            <li class="flex items-center gap-3">
              <Check class="w-4 h-4 text-zen-success shrink-0" aria-hidden="true" />
              <span class="flex-1">Claimed on NEAR</span>
              {#if explorer}<a href={explorer} target="_blank" rel="noopener noreferrer" class="text-xs text-zen-fg-muted">The NEAR claim transaction</a>{/if}
            </li>
            <li class="flex items-center gap-3">
              {#if arrived}<Check class="w-4 h-4 text-zen-success shrink-0" aria-hidden="true" />
              {:else if returned}<Undo2 class="w-4 h-4 text-zen-error shrink-0" aria-hidden="true" />
              {:else}<span class="w-4 h-4 flex items-center justify-center shrink-0" aria-hidden="true"><span class="w-2 h-2 rounded-full bg-zen-fg-subtle animate-pulse"></span></span>{/if}
              <span class="flex-1 {returned ? 'text-zen-error' : ''}" role="status">{bridgeView?.text ?? 'Sent from NEAR, waiting for the bridge.'}</span>
            </li>
          </ol>
          {#if bridge?.destinationTx}
            {#if bridge.destinationTx.explorerUrl}{@render pill(bridge.destinationTx.explorerUrl, `View it on ${payout.chainName}`)}{:else}<p class="text-xs text-zen-fg-muted">{payout.chainName} transaction: <code>{bridge.destinationTx.hash}</code></p>{/if}
          {/if}
          {#if stalled && !bridgeView?.done}<p class="text-xs text-zen-fg-muted">Still processing after 30 minutes. Keep this page and the deposit address below, and contact the sender.</p>{/if}
          {#if (bridgeView?.done && !bridgeView.ok) || stalled}<p class="text-xs text-zen-fg-subtle">1Click deposit address: <code>{depositAddress}</code></p>{/if}
        {:else}
          {@render failure()}
        {/if}
      {:else if attempt}
        {#if working}
          {@render medallion(Loader2, 'muted', true)}
        {:else if step === 'done'}
          {@render medallion(Check, 'success')}
        {:else if step === 'unsettled'}
          {@render medallion(Clock, 'muted')}
        {:else}
          {@render medallion(AlertTriangle, 'error')}
        {/if}
        {#if step === 'done'}
          <h1 class="flex flex-col items-center gap-1">
            <span class="text-5xl font-bold tracking-tighter tabular-nums text-zen-success">{formatAmount(BigInt(attempt.amount))} USDC</span>
            <span class="text-sm font-normal text-zen-fg-muted">sent to <span class="font-mono break-all text-zen-fg">{attempt.destination}</span></span>
          </h1>
          {#if explorer}
            {@render pill(explorer, 'View the transaction')}
          {:else}
            <p class="text-xs text-zen-fg-subtle">Transaction: <code>{txHash}</code></p>
          {/if}
          {#if isImplicitAccount(attempt.destination)}
            <p class="text-xs text-zen-fg-muted">To move these funds later, this account needs a little NEAR for gas.</p>
          {/if}
        {:else}
          <h1 class="text-2xl font-semibold tracking-tight">
            {#if step === 'checking'}Checking your claim…{:else if step === 'paying' || step === 'settling'}Sending your tokens…{:else if step === 'unsettled'}Still settling{:else}Not claimed{/if}
          </h1>
          <p class="text-xs text-zen-fg-subtle">Funds go to: <span class="font-mono break-all">{attempt.destination}</span></p>
          {@render failure()}
        {/if}
      {/if}
    </div>
  </ZenCard>
</div>
