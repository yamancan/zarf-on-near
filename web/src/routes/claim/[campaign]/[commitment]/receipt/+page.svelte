<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { env } from '$env/dynamic/public';
  import { clearAttempt, isImplicitAccount, loadAttempt, loadReceipt, middle, saveReceipt, settleReceipt, signedIn, twoDecimals, type Receipt } from '$lib/claim';
  import { UNIT } from '$lib/network';
  import ClaimRecord from '$lib/ClaimRecord.svelte';
  import { canRetry, ClaimError, describeError, errorCode, getClaimState, isUnmapped, outcomeAfterRelay, requestSignature, submitClaim } from '$lib/services';
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
  let code = $state(''); // shown under Details only when the sentence is the generic one
  let failCode = $state(''); // picks the card: an expired sign-in, another Google account, a final refusal
  const contract = env.PUBLIC_CONTRACT_ID ?? '';
  const campaignId = page.params.campaign!, commitmentId = page.params.commitment!;
  let txHash = $state('');
  const explorer = $derived(env.PUBLIC_EXPLORER_TX_URL ? `${env.PUBLIC_EXPLORER_TX_URL}${txHash}` : '');
  // A reload after the NEAR claim has no sign-in left, but the payout it started can still be followed.
  const resumed = ok ? null : loadPayout(page.params.campaign!, page.params.commitment!);
  const payout = ok ? attempt!.intents : resumed;
  const depositAddress = ok ? attempt!.destination : (resumed?.depositAddress ?? '');
  // A reload or another tab after a claim: what this browser remembers (claim.ts saveReceipt), shown only once
  // the chain says this claim is claimed (security review m1).
  const remembered = ok || resumed ? null : loadReceipt(contract, campaignId, commitmentId);
  let stored = $state<Receipt | null>(null);
  let recall = $state<'checking' | 'error' | null>(remembered ? 'checking' : null);
  async function verifyRemembered() {
    recall = 'checking';
    try {
      const s = await getClaimState(env.PUBLIC_NEAR_RPC_URL, contract, campaignId, commitmentId);
      if (s === 'claimed') stored = remembered;
      recall = null;
    } catch {
      recall = 'error';
    }
  }
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
        if (bridgeView?.done) {
          // Remembered only now: until the bridge reports, a reopened link says "in transit", never "paid out".
          settleReceipt(contract, campaignId, commitmentId, bridgeView.outcome, bridge?.amountOutFormatted);
          return;
        }
      } catch {
        // keep polling: a status read failing says nothing about the swap
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    stalled = true;
  }
  let stalled = $state(false);
  let final = $state(false); // the claim can never succeed from this link: no way back to it
  const working = $derived(step === 'checking' || step === 'paying' || step === 'settling');

  onMount(async () => {
    if (remembered) return verifyRemembered();
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
        saveReceipt(contract, attempt.campaign, attempt.commitment, {
          amount: attempt.amount, txHash, at: Date.now(), destination: attempt.intents?.recipient ?? attempt.destination,
          ...(attempt.intents ? { chainName: attempt.intents.chainName, bridge: 'in-transit' as const } : {}),
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
        failCode = errorCode(e);
        code = isUnmapped(e) ? failCode : '';
        if (!canRetry(e)) final = true;
        step = 'failed';
      }
    }
  });
</script>

<svelte:head><title>Your claim · Zarf</title></svelte:head>

{#snippet back()}
  {#if final}
    <ZenButton href="/" variant="secondary" class="rounded-full min-h-11">What is Zarf?</ZenButton>
  {:else if canGoBack}
    <ZenButton href={claimHref} variant="primary" class="rounded-full min-h-11 w-full sm:w-auto">Back to your claim</ZenButton>
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

{#snippet details(text: string, value: string)}
  <details class="group text-xs text-zen-fg-muted">
    <summary class="inline-flex items-center gap-1.5 min-h-11 cursor-pointer list-none hover:text-zen-fg">Details <ChevronDown class="w-3.5 h-3.5 transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
    <p class="break-all">{text} <span class="font-mono">{value}</span></p>
  </details>
{/snippet}

<!-- Failures that are not errors of the claim itself get their own card (flow canvas: expired, other account) -->
{#snippet failureCard()}
  {#if step === 'failed' && (failCode === 'EXPIRED' || failCode === 'E114_CLAIM_EXPIRED')}
    <Medallion icon={Clock} tone="muted" />
    <h1 class="text-xl font-semibold tracking-tight">Sign-in expired</h1>
    <p class="text-sm text-zen-fg-muted max-w-xs" role="alert">A Google sign-in is good for a few minutes. Nothing was paid; your claim is still open.</p>
    {@render back()}
  {:else if step === 'failed' && failCode === 'COMMITMENT_MISMATCH'}
    <Medallion icon={AlertTriangle} tone="error" />
    <h1 class="text-xl font-semibold tracking-tight">Different Google account</h1>
    <Note tone="error" center>{error}</Note>
    {@render back()}
    <p class="text-xs text-zen-fg-muted">Nothing was paid. Your claim is still open.</p>
  {:else}
    {#if step === 'unsettled'}
      <Medallion icon={Clock} tone="muted" />
    {:else}
      <Medallion icon={AlertTriangle} tone="error" />
    {/if}
    <h1 class="text-xl font-semibold tracking-tight">{step === 'unsettled' ? 'Still settling' : 'Not claimed'}</h1>
    {@render failure()}
  {/if}
{/snippet}

{#snippet failure()}
  {#if step === 'reverted'}
    <Note tone="error" center>The transfer failed and your claim is open again.</Note>
    {@render back()}
  {:else if step === 'unsettled'}
    <p class="text-sm text-zen-fg-muted max-w-xs">The transaction was sent but has not settled yet. There is no need to claim again.</p>
    {#if explorer}{@render explorerButton(explorer, 'View the transaction')}{/if}
  {:else if step === 'failed'}
    <Note tone="error" center>{error}</Note>
    {@render back()}
    {#if code}{@render details('Code', code)}{/if}
  {/if}
{/snippet}

{#snippet nearDone(amount: string, to: string, hash: string)}
  <Medallion icon={Check} tone="success" />
  <h1 class="text-xl font-semibold tracking-tight">Arrived</h1>
  <Amount label="You received" value={formatAmount(BigInt(amount))} unit={UNIT} />
  <p class="text-sm text-zen-fg-muted">to <span class="font-mono text-zen-fg" title={to}>{middle(to, 8)}</span></p>
  {#if env.PUBLIC_EXPLORER_TX_URL}
    {@render explorerButton(`${env.PUBLIC_EXPLORER_TX_URL}${hash}`, 'View the transaction')}
  {:else}
    <p class="text-xs text-zen-fg-muted">Transaction <span class="font-mono">{middle(hash, 8)}</span></p>
  {/if}
  {#if isImplicitAccount(to)}
    <p class="text-xs text-zen-fg-muted max-w-xs">To move these funds later, this account needs a little NEAR for gas.</p>
  {/if}
{/snippet}

<div class="w-full max-w-lg mx-auto px-4 py-8 sm:py-14">
  <ZenCard variant="elevated" class="!p-6 sm:!p-8">
    <div class="flex flex-col items-center text-center gap-4">
      {#if recall === 'checking'}
        <Medallion icon={Loader2} tone="muted" spin />
        <h1 class="text-xl font-semibold tracking-tight">Checking your claim…</h1>
      {:else if recall === 'error'}
        <Medallion icon={AlertTriangle} tone="error" />
        <h1 class="text-xl font-semibold tracking-tight">Could not check this claim</h1>
        <p class="text-sm text-zen-fg-muted max-w-xs" role="alert">NEAR is not answering right now.</p>
        <ZenButton variant="primary" class="rounded-full min-h-11 w-full sm:w-auto" onclick={verifyRemembered}>Check again</ZenButton>
      {:else if stored && !stored.chainName}
        {@render nearDone(stored.amount, stored.destination, stored.txHash)}
      {:else if stored}
        <ClaimRecord r={stored} amount={stored.amount} title={stored.bridge === 'paid' ? `Arrived on ${stored.chainName}` : stored.bridge === 'in-transit' ? 'Claimed on NEAR' : 'Not delivered'} />
      {:else if !resumed && (!ok || !attempt)}
        <Medallion icon={Mail} tone="muted" />
        <h1 class="text-xl font-semibold tracking-tight">Nothing to show yet</h1>
        <p class="text-sm text-zen-fg-muted max-w-xs">This page shows your claim after you sign in with Google.</p>
        {#if canGoBack}
          {@render back()}
        {:else}
          <ZenButton href="/" variant="secondary" class="rounded-full min-h-11">What is Zarf?</ZenButton>
        {/if}
      {:else if payout}
        {@const outcome = bridgeView?.done ? bridgeView.outcome : 'in-transit'}
        {@const arrived = outcome === 'paid'}
        {@const refunded = outcome === 'refunded'}
        {@const lost = outcome === 'failed'}
        {#if step === 'done' || working}
          {#if arrived}
            <Medallion icon={Check} tone="success" />
          {:else if refunded}
            <Medallion icon={Undo2} tone="error" />
          {:else if lost}
            <Medallion icon={AlertTriangle} tone="error" />
          {:else}
            <Medallion icon={Loader2} tone="muted" spin />
          {/if}
          <h1 class="text-xl font-semibold tracking-tight">
            {#if step === 'checking'}Checking your claim…{:else if working}Sending your tokens…{:else if arrived}Arrived on {payout.chainName}{:else if refunded}Not delivered{:else if lost}Payout failed{:else}Sending to {payout.chainName}…{/if}
          </h1>
          <Amount
            label={arrived ? 'You received' : refunded ? 'Returned to the sender' : lost ? 'Not delivered' : 'On its way'}
            value={twoDecimals(arrived && bridge?.amountOutFormatted ? bridge.amountOutFormatted : payout.amountOutFormatted)}
            approx={!arrived}
            struck={refunded}
          />
          <p class="text-sm text-zen-fg-muted">to <span class="font-mono text-zen-fg" title={payout.recipient}>{middle(payout.recipient)}</span> on {payout.chainName}</p>
        {:else}
          {@render failureCard()}
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
              {:else if refunded}<Undo2 class="w-4 h-4 text-zen-error-content shrink-0" aria-hidden="true" />
              {:else if lost}<AlertTriangle class="w-4 h-4 text-zen-error-content shrink-0" aria-hidden="true" />
              {:else}<Loader2 class="w-4 h-4 text-zen-fg-muted shrink-0 animate-spin" aria-hidden="true" />{/if}
              <span class="flex-1 {refunded || lost ? 'text-zen-error-content' : ''}" role="status">{bridgeView?.text ?? 'Sent from NEAR, waiting for the bridge.'}</span>
            </li>
          </ol>
          {#if bridge?.destinationTx}
            {#if bridge.destinationTx.explorerUrl}{@render explorerButton(bridge.destinationTx.explorerUrl, `View it on ${payout.chainName}`)}{:else}<p class="text-xs text-zen-fg-muted">{payout.chainName} transaction <span class="font-mono">{middle(bridge.destinationTx.hash, 8)}</span></p>{/if}
          {/if}
          {#if stalled && !bridgeView?.done}<Note tone="info" center>Still processing after 30 minutes. Keep this page and contact the sender.</Note>{/if}
          {#if refunded || lost || stalled}{@render details('Bridge deposit address', depositAddress)}{/if}
        {/if}
      {:else if attempt}
        {#if step === 'done'}
          {@render nearDone(attempt.amount, attempt.destination, txHash)}
        {:else if working}
          <Medallion icon={Loader2} tone="muted" spin />
          <h1 class="text-xl font-semibold tracking-tight">{step === 'checking' ? 'Checking your claim…' : 'Sending your tokens…'}</h1>
          <Amount label="Claiming" value={formatAmount(BigInt(attempt.amount))} unit={UNIT} />
          <p class="text-sm text-zen-fg-muted">to <span class="font-mono text-zen-fg" title={attempt.destination}>{middle(attempt.destination, 8)}</span></p>
        {:else}
          {@render failureCard()}
        {/if}
      {/if}
    </div>
  </ZenCard>
</div>
