<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { env } from '$env/dynamic/public';
  import { clearAttempt, isImplicitAccount, loadAttempt, loadReceipt, middle, saveReceipt, signedIn, twoDecimals } from '$lib/claim';
  import { ClaimError, describeError, errorCode, getClaimState, isUnmapped, outcomeAfterRelay, requestSignature, submitClaim } from '$lib/services';
  import { formatAmount } from '$lib/create/recipients';
  import { AlertTriangle, ArrowUpRight, Check, ChevronDown, Clock, Loader2, Mail, Undo2 } from 'lucide-svelte';
  import Amount from '$lib/Amount.svelte';
  import Medallion from '$lib/Medallion.svelte';
  import Note from '$lib/Note.svelte';
  import ZenButton from '$lib/zen/components/ZenButton.svelte';
  import ZenCard from '$lib/zen/components/ZenCard.svelte';
  import { describeStatus, getStatus, loadPayout, savePayout, submitDeposit, type StatusView } from '$lib/intents';

  const attempt = loadAttempt();
  const idToken = signedIn.idToken;
  const ok = !!idToken && !!attempt && attempt.campaign === page.params.campaign && attempt.commitment === page.params.commitment;

  let step = $state<'checking' | 'paying' | 'settling' | 'done' | 'reverted' | 'unsettled' | 'failed'>('checking');
  let error = $state('');
  let code = $state(''); // shown as a detail only when the sentence is the generic one
  let txHash = $state('');
  const explorer = $derived(env.PUBLIC_EXPLORER_TX_URL ? `${env.PUBLIC_EXPLORER_TX_URL}${txHash}` : '');
  // A reload after the NEAR claim has no sign-in left, but the payout it started can still be followed.
  const resumed = ok ? null : loadPayout(page.params.campaign!, page.params.commitment!);
  const payout = ok ? attempt!.intents : resumed;
  const depositAddress = ok ? attempt!.destination : (resumed?.depositAddress ?? '');
  // A reload after a NEAR-account claim: the sign-in is spent, but what was paid is kept (claim.ts saveReceipt).
  const stored = ok || resumed ? null : loadReceipt(page.params.campaign!, page.params.commitment!);
  // The claim this tab started, if any: every failure leads back to it (its salt is still in this tab).
  const claimHref = `/claim/${page.params.campaign}/${page.params.commitment}`;
  const canGoBack = !!attempt && attempt.campaign === page.params.campaign && attempt.commitment === page.params.commitment;
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
        saveReceipt(attempt.campaign, attempt.commitment, {
          amount: attempt.amount, txHash, destination: attempt.intents?.recipient ?? attempt.destination, chainName: attempt.intents?.chainName,
        });
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
        code = isUnmapped(e) ? errorCode(e) : '';
        step = 'failed';
      }
    }
  });
</script>

<svelte:head><title>Your claim · Zarf</title></svelte:head>

{#snippet back()}
  {#if canGoBack}
    <ZenButton href={claimHref} variant="primary" class="rounded-full min-h-11">Back to your claim</ZenButton>
  {:else}
    <p class="text-xs text-zen-fg-muted">Open your claim link again to try once more.</p>
  {/if}
{/snippet}

{#snippet explorerButton(href: string, text: string)}
  <ZenButton {href} target="_blank" rel="noopener noreferrer" variant="secondary" class="rounded-full min-h-11">
    {text}
    {#snippet iconRight()}<ArrowUpRight class="w-3.5 h-3.5" />{/snippet}
  </ZenButton>
{/snippet}

{#snippet failure()}
  {#if step === 'reverted'}
    <Note tone="error">The transfer failed and your claim is open again.</Note>
    {@render back()}
  {:else if step === 'unsettled'}
    <p class="text-sm text-zen-fg-muted">The transaction was sent but has not settled yet. There is no need to claim again.</p>
    {#if explorer}{@render explorerButton(explorer, 'View the transaction')}{/if}
  {:else if step === 'failed'}
    <Note tone="error">{error}</Note>
    {#if code}<p class="text-xs text-zen-fg-muted">Code <span class="font-mono">{code}</span></p>{/if}
    {@render back()}
  {/if}
{/snippet}

{#snippet nearDone(amount: string, to: string, hash: string)}
  <Medallion icon={Check} tone="success" />
  <h1 class="text-xl font-semibold tracking-tight">Arrived</h1>
  <Amount label="You received" value={formatAmount(BigInt(amount))} />
  <p class="text-sm text-zen-fg-muted">to <span class="font-mono text-zen-fg" title={to}>{middle(to, 8)}</span></p>
  {#if env.PUBLIC_EXPLORER_TX_URL}
    {@render explorerButton(`${env.PUBLIC_EXPLORER_TX_URL}${hash}`, 'View the transaction')}
  {:else}
    <p class="text-xs text-zen-fg-muted">Transaction <span class="font-mono">{middle(hash, 8)}</span></p>
  {/if}
  {#if isImplicitAccount(to)}
    <p class="text-xs text-zen-fg-muted">To move these funds later, this account needs a little NEAR for gas.</p>
  {/if}
{/snippet}

<div class="w-full max-w-lg mx-auto px-4 py-8 sm:py-14">
  <ZenCard variant="elevated" class="!p-6 sm:!p-8">
    <div class="flex flex-col items-center text-center gap-4">
      {#if stored && !stored.chainName}
        {@render nearDone(stored.amount, stored.destination, stored.txHash)}
      {:else if !resumed && (!ok || !attempt)}
        <Medallion icon={Mail} tone="muted" />
        <h1 class="text-xl font-semibold tracking-tight">Nothing to show yet</h1>
        <p class="text-sm text-zen-fg-muted">This page shows a claim after the Google sign-in.</p>
        {#if canGoBack}
          {@render back()}
        {:else}
          <ZenButton href="/" variant="secondary" class="rounded-full min-h-11">What is Zarf?</ZenButton>
        {/if}
      {:else if payout}
        {@const arrived = !!bridgeView?.done && bridgeView.ok}
        {@const returned = !!bridgeView?.done && !bridgeView.ok}
        {#if working || (step === 'done' && !bridgeView?.done)}
          <Medallion icon={Loader2} tone="muted" spin />
        {:else if arrived}
          <Medallion icon={Check} tone="success" />
        {:else if returned}
          <Medallion icon={Undo2} tone="error" />
        {:else if step === 'unsettled'}
          <Medallion icon={Clock} tone="muted" />
        {:else}
          <Medallion icon={AlertTriangle} tone="error" />
        {/if}
        <h1 class="text-xl font-semibold tracking-tight">
          {#if step === 'checking'}Checking your claim…{:else if step === 'paying' || step === 'settling'}Sending your tokens…{:else if step === 'done'}{arrived ? `Arrived on ${payout.chainName}` : returned ? 'Not delivered' : `Sending to ${payout.chainName}…`}{:else if step === 'unsettled'}Still settling{:else}Not claimed{/if}
        </h1>
        {#if step === 'done' || working || step === 'unsettled'}
        <Amount
          label={arrived ? 'You received' : returned ? 'Returned to the sender' : 'On its way'}
          value={twoDecimals(arrived && bridge?.amountOutFormatted ? bridge.amountOutFormatted : payout.amountOutFormatted)}
          approx={!arrived}
          struck={returned}
        />
        <p class="text-sm text-zen-fg-muted">to <span class="font-mono text-zen-fg" title={payout.recipient}>{middle(payout.recipient)}</span> on {payout.chainName}</p>
        {/if}
        {#if step === 'done'}
          <!-- Two legs, one mark each: the NEAR claim, then the bridge payout -->
          <ol class="w-full flex flex-col gap-3 text-left text-sm border-y-[0.5px] border-zen-border-subtle py-4 my-1">
            <li class="flex items-center gap-3">
              <Check class="w-4 h-4 text-zen-success-content shrink-0" aria-hidden="true" />
              <span class="flex-1">Claimed on NEAR</span>
              {#if explorer}<a href={explorer} target="_blank" rel="noopener noreferrer" class="inline-flex items-center min-h-11 text-xs text-zen-fg-muted underline underline-offset-2 hover:text-zen-fg">Transaction</a>{/if}
            </li>
            <li class="flex items-center gap-3">
              {#if arrived}<Check class="w-4 h-4 text-zen-success-content shrink-0" aria-hidden="true" />
              {:else if returned}<Undo2 class="w-4 h-4 text-zen-error-content shrink-0" aria-hidden="true" />
              {:else}<Loader2 class="w-4 h-4 text-zen-fg-muted shrink-0 animate-spin" aria-hidden="true" />{/if}
              <span class="flex-1 {returned ? 'text-zen-error-content' : ''}" role="status">{bridgeView?.text ?? 'Sent from NEAR, waiting for the bridge.'}</span>
            </li>
          </ol>
          {#if bridge?.destinationTx}
            {#if bridge.destinationTx.explorerUrl}{@render explorerButton(bridge.destinationTx.explorerUrl, `View it on ${payout.chainName}`)}{:else}<p class="text-xs text-zen-fg-muted">{payout.chainName} transaction <span class="font-mono">{middle(bridge.destinationTx.hash, 8)}</span></p>{/if}
          {/if}
          {#if stalled && !bridgeView?.done}<Note tone="info">Still processing after 30 minutes. Keep this page and contact the sender.</Note>{/if}
          {#if returned || stalled}
            <details class="group text-xs text-zen-fg-muted">
              <summary class="inline-flex items-center gap-1.5 min-h-11 cursor-pointer list-none hover:text-zen-fg">Details <ChevronDown class="w-3.5 h-3.5 transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
              <p class="break-all">Bridge deposit address <span class="font-mono">{depositAddress}</span></p>
            </details>
          {/if}
        {:else}
          {@render failure()}
        {/if}
      {:else if attempt}
        {#if step === 'done'}
          {@render nearDone(attempt.amount, attempt.destination, txHash)}
        {:else}
          {#if working}
            <Medallion icon={Loader2} tone="muted" spin />
          {:else if step === 'unsettled'}
            <Medallion icon={Clock} tone="muted" />
          {:else}
            <Medallion icon={AlertTriangle} tone="error" />
          {/if}
          <h1 class="text-xl font-semibold tracking-tight">
            {#if step === 'checking'}Checking your claim…{:else if step === 'paying' || step === 'settling'}Sending your tokens…{:else if step === 'unsettled'}Still settling{:else}Not claimed{/if}
          </h1>
          {#if working}
            <Amount label="Claiming" value={formatAmount(BigInt(attempt.amount))} />
            <p class="text-sm text-zen-fg-muted">to <span class="font-mono text-zen-fg" title={attempt.destination}>{middle(attempt.destination, 8)}</span></p>
          {/if}
          {@render failure()}
        {/if}
      {/if}
    </div>
  </ZenCard>
</div>
