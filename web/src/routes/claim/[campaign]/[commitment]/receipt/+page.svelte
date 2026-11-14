<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { env } from '$env/dynamic/public';
  import { CLAIMED_NO_RECORD, EXPLORER_LABEL, claimStartedHere, holdPage, claimedAt, clearAttempt, confirmRemembered, isImplicitAccount, loadAttempt, loadReceipt, middle, saveReceipt, settleReceipt, shownAmount, signedIn, type Receipt } from '$lib/claim';
  import { clearPendingClaim, loadPendingClaim, recoverPendingClaim, savePendingClaim } from '$lib/claim-recovery';
  import { accountExplorerUrl, TESTNET, UNIT } from '$lib/network';
  import ClaimRecord from '$lib/ClaimRecord.svelte';
  import { canRetry, ClaimError, describeError, errorCode, failureHeading, getClaimState, isUnmapped, relayAndSettle, relayAnswerLost, requestSignature, starterLine, submitClaim } from '$lib/services';
  import { formatAmount } from '$lib/create/recipients';
  import { AlertTriangle, ArrowUpRight, Check, CheckCircle2, ChevronDown, Clock, ExternalLink, Loader2, Undo2 } from 'lucide-svelte';
  import AmountPanel from '$lib/AmountPanel.svelte';
  import Avatar from '$lib/Avatar.svelte';
  import Steps from '$lib/Steps.svelte';
  import { markIn, swapIn } from '$lib/motion';
  import Amount from '$lib/Amount.svelte';
  import Medallion from '$lib/Medallion.svelte';
  import Note from '$lib/Note.svelte';
  import ZenButton from '$lib/zarf-kit/components/ui/ZenButton.svelte';
  import ZenCard from '$lib/zarf-kit/components/ui/ZenCard.svelte';
  import { describeStatus, getStatus, nextStep, notReturnedYet, submitDeposit, type StatusView } from '$lib/intents';
  import BridgeDetails from '$lib/BridgeDetails.svelte';
  import { passkeyOffered } from '$lib/passkey';
  import PasskeyAccount from '$lib/PasskeyAccount.svelte';

  const attempt = loadAttempt();
  const idToken = signedIn.idToken;
  const ok = !!idToken && !!attempt && attempt.campaign === page.params.campaign && attempt.commitment === page.params.commitment;

  let step = $state<'checking' | 'paying' | 'settling' | 'done' | 'reverted' | 'unsettled' | 'failed'>('checking');
  let error = $state('');
  let code = $state(''); // shown under Details only when the sentence is the generic one
  let failCode = $state(''); // picks the card: an expired sign-in, another Google account, a final refusal
  const contract = env.PUBLIC_CONTRACT_ID ?? '';
  const campaignId = page.params.campaign!, commitmentId = page.params.commitment!;
  // T-021: a passkey account opens again with one Face ID (the key is re-derived, never stored).
  const passkeyOn = passkeyOffered(TESTNET ? 'testnet' : '', env.PUBLIC_IMPLICIT_ACCOUNTS, env.PUBLIC_PASSKEY_ACCOUNTS);

  let txHash = $state('');
  let starterNear = $state(''); // the relayer's testnet starter NEAR, when it sent some with this claim
  const explorer = $derived(env.PUBLIC_EXPLORER_TX_URL && txHash ? `${env.PUBLIC_EXPLORER_TX_URL}${txHash}` : '');
  // A reload after the NEAR claim has no sign-in left, but the payout it started can still be followed.
  const network = TESTNET ? 'testnet' : 'mainnet';
  const pending = loadPendingClaim(network, contract, campaignId, commitmentId);
  const remembered = loadReceipt(contract, campaignId, commitmentId);
  const payout = pending?.chainName ? { chainName: pending.chainName, recipient: pending.destination, refundTo: pending.refundTo! } : ok ? attempt!.intents : null;
  const depositAddress = pending?.depositAddress ?? (ok ? attempt!.destination : '');
  const claimAmount = pending?.amount ?? attempt?.amount ?? '0';
  const claimDestination = pending?.destination ?? attempt?.destination ?? '';
  const claimPasskey = pending?.passkey ?? attempt?.passkey;
  // A reload or another tab after a claim: what this browser remembers (claim.ts saveReceipt), shown only once
  // the chain says this claim is claimed (security review m1).
  let stored = $state<Receipt | null>(null);
  let recall = $state<'checking' | 'error' | null>(remembered ? 'checking' : null);
  async function verifyRemembered() {
    recall = 'checking';
    try {
      stored = await confirmRemembered(remembered, () => getClaimState(env.PUBLIC_NEAR_RPC_URL, contract, campaignId, commitmentId));
      if (stored) clearPendingClaim(network, contract, campaignId, commitmentId);
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
  async function followPayout(depositAddress: string, again = false) {
    stalled = false;
    if (!again && txHash) void submitDeposit(depositAddress, txHash, env.PUBLIC_RELAYER_ACCOUNT_ID || undefined); // no hash when the relayer's answer was lost
    for (let i = 0; i < 360; i++) { // 30 min, then stop and say where to look
      try {
        const s = await getStatus(depositAddress);
        if (s) {
          bridge = s;
          checkedAt = Date.now();
          // Every answer is remembered with its time; "paid" only after SUCCESS (describeStatus).
          settleReceipt(contract, campaignId, commitmentId, bridgeView!.outcome, s.amountOutFormatted, undefined, Date.now(), s);
        }
        if (bridgeView?.done) return;
      } catch {
        // keep polling: a status read failing says nothing about the swap
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    stalled = true;
  }
  let stalled = $state(false);
  let checkedAt = $state(0); // when the bridge last answered
  let final = $state(false); // the claim can never succeed from this link: no way back to it
  const working = $derived(step === 'checking' || step === 'paying' || step === 'settling');
  $effect(() => ((ok || pending) && working ? holdPage(window) : undefined));

  async function recover() {
    if (!pending || working && step !== 'checking') return;
    step = 'settling';
    txHash = pending.txHash;
    const result = await recoverPendingClaim(network, contract, campaignId, commitmentId, pending,
      () => getClaimState(env.PUBLIC_NEAR_RPC_URL, contract, campaignId, commitmentId));
    stored = result.receipt;
    step = result.state === 'claimed' ? 'done' : 'unsettled';
    if (result.state === 'claimed' && canGoBack) clearAttempt();
  }

  onMount(async () => {
    if (remembered) return verifyRemembered();
    if (pending) { signedIn.idToken = null; return recover(); }
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
      savePendingClaim(network, contract, attempt); // durable before the request can leave this tab
      step = 'paying';
      // A reverted transfer (409 E115) and other refusals throw; a lost answer follows the chain (relayAndSettle).
      const settled = await relayAndSettle(
        () => submitClaim(env.PUBLIC_RELAYER_URL, args).then((r) => {
          txHash = r.txHash;
          starterNear = r.starterNear ?? '';
          step = 'settling';
          try { savePendingClaim(network, contract, attempt, txHash); } catch { /* the pre-submit record still recovers without a hash */ }
          return r;
        }),
        () => getClaimState(env.PUBLIC_NEAR_RPC_URL, env.PUBLIC_CONTRACT_ID, attempt.campaign, attempt.commitment),
      );
      const state = settled.state;
      if (state === 'claimed') {
        step = 'done';
        clearAttempt(); // salt and destination are no longer needed in this tab
        saveReceipt(contract, attempt.campaign, attempt.commitment, {
          amount: attempt.amount, txHash, at: Date.now(), destination: attempt.intents?.recipient ?? attempt.destination, ...(attempt.passkey ? { passkey: true as const } : {}),
          ...(attempt.intents ? { chainName: attempt.intents.chainName, bridge: 'in-transit' as const, depositAddress, refundTo: attempt.intents.refundTo } : {}),
        });
        if (loadReceipt(contract, attempt.campaign, attempt.commitment)) clearPendingClaim(network, contract, attempt.campaign, attempt.commitment);
        if (attempt.intents) {
          void followPayout(depositAddress);
        }
      } else {
        // A view can lag a submitted tx; only the relayer's explicit refusal proves it did not pay.
        step = 'unsettled';
      }
    } catch (e) {
      if ((relayAnswerLost(e) || e instanceof ClaimError && e.code === 'E123_CLAIM_PENDING') && loadPendingClaim(network, contract, campaignId, commitmentId)) {
        step = 'unsettled';
        return;
      }
      if (!relayAnswerLost(e)) clearPendingClaim(network, contract, campaignId, commitmentId);
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

<svelte:head><title>Your Claim · Zarf</title></svelte:head>

{#snippet back()}
  {#if final}
    <a href="/" class="inline-block"><ZenButton tabindex={-1} variant="secondary">What Is Zarf?</ZenButton></a>
  {:else if canGoBack}
    <a href={claimHref} class="block w-full sm:w-auto"><ZenButton tabindex={-1} variant="primary" class="w-full sm:w-auto">Back to Claim</ZenButton></a>
  {:else}
    <p class="text-xs text-zen-fg-muted">Open your claim link again to try once more.</p>
  {/if}
{/snippet}

{#snippet explorerButton(href: string, text: string)}
  <a {href} target="_blank" rel="noopener noreferrer" class="inline-block"><ZenButton tabindex={-1} variant="secondary">
    {text}
    {#snippet iconRight()}<ArrowUpRight class="w-3.5 h-3.5" />{/snippet}
  </ZenButton></a>
{/snippet}

{#snippet details(text: string, value: string, more = '')}
  <details class="group text-xs text-zen-fg-muted">
    <summary class="inline-flex items-center gap-1.5 py-1 cursor-pointer list-none hover:text-zen-fg">Details <ChevronDown class="w-3.5 h-3.5 transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
    <p class="text-xs text-zen-fg-muted break-all">{text} <span class="font-mono">{value}</span></p>
    {#if more}<p class="text-xs text-zen-fg-muted break-words mt-1">{more}</p>{/if}
  </details>
{/snippet}

<!-- Failures that are not errors of the claim itself get their own card (flow canvas: expired, other account) -->
{#snippet failureCard()}
  {#if step === 'failed' && (failCode === 'EXPIRED' || failCode === 'E114_CLAIM_EXPIRED')}
    <Medallion icon={Clock} tone="muted" />
    <h1 class="text-xl font-bold">Sign-In Expired</h1>
    <p class="text-sm text-zen-fg-muted max-w-xs" role="alert">A Google sign-in is good for a few minutes. Nothing was paid; your claim is still open.</p>
    {@render back()}
  {:else if step === 'failed' && failCode === 'COMMITMENT_MISMATCH'}
    <Medallion icon={AlertTriangle} tone="error" />
    <h1 class="text-xl font-bold">Different Google Account</h1>
    <Note tone="error" center>{error}</Note>
    {@render back()}
    <p class="text-xs text-zen-fg-muted">Nothing was paid. Your claim is still open.</p>
  {:else if step === 'failed' && failCode === 'E105_ALREADY_CLAIMED'}
    <!-- The title and the sentence say the same thing: as "Already claimed" on the claim page -->
    <Medallion icon={Check} tone="muted" />
    <h1 class="text-xl font-bold">Already Claimed</h1>
    <p class="text-sm text-zen-fg-muted max-w-xs" role="alert">{CLAIMED_NO_RECORD}</p>
    {@render back()}
  {:else}
    {@const head = step === 'unsettled' ? { title: 'Still Settling', muted: true } : step === 'reverted' ? { title: 'Not Claimed', muted: false } : failureHeading(failCode)}
    {#if head.muted}
      <Medallion icon={Clock} tone="muted" />
    {:else}
      <Medallion icon={AlertTriangle} tone="error" />
    {/if}
    <h1 class="text-xl font-bold">{head.title}</h1>
    {@render failure()}
  {/if}
{/snippet}

{#snippet failure()}
  {#if step === 'reverted'}
    <Note tone="error" center>The transfer failed and your claim is open again.</Note>
    {@render back()}
  {:else if step === 'unsettled'}
    <p class="text-sm text-zen-fg-muted max-w-xs">Sent, not settled yet. No need to claim again.</p>
    <p class="text-xs text-zen-fg-muted max-w-xs">If it stays here, ask the sender to check this claim.</p>
    {#if explorer}{@render explorerButton(explorer, 'View Transaction')}{/if}
    <ZenButton variant="secondary" onclick={() => location.reload()}>Check Again</ZenButton>
  {:else if step === 'failed' && failureHeading(failCode).muted}
    <p class="text-sm text-zen-fg-muted max-w-xs" role="status">{error}</p>
    {@render back()}
  {:else if step === 'failed'}
    <Note tone="error" center>{error}</Note>
    {@render back()}
    {#if code}{@render details('Code', code)}{/if}
  {/if}
{/snippet}

{#snippet nearDone(amount: string, to: string, hash: string, starter: string, passkey = false)}
  <!-- Main claim app ClaimStep5Submit: header row, Amount Highlight, two-button grid (h-14 rounded-2xl) -->
  <div class="w-full text-left space-y-8" in:swapIn>
    <!-- No check disc: the title says it arrived (T-023 waste list item 10) -->
    <div class="flex items-start gap-4">
      <div class="min-w-0">
        <h1 class="text-xl font-semibold">Arrived</h1>
        <p class="text-sm text-zen-fg-muted font-light mt-1 flex items-start gap-1.5">
          <span>To</span><Avatar name={to} /><span class="font-mono break-all min-w-0">{to}</span>
        </p>
      </div>
    </div>
    <AmountPanel label="You Received" value={formatAmount(BigInt(amount))} unit={UNIT} />
    {#if starterLine(starter)}
      <p class="text-xs text-zen-fg-subtle">{starterLine(starter)}</p>
    {:else if isImplicitAccount(to)}
      <p class="text-xs text-zen-fg-subtle">To move these funds later, this account needs a little NEAR for gas.</p>
    {/if}
    {#if passkeyOn && passkey && isImplicitAccount(to)}<PasskeyAccount expected={to} />{/if}
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <!-- Title Case buttons, not Zarf's tracked caps (T-023 waste list item 2) -->
      {#if hash && env.PUBLIC_EXPLORER_TX_URL}
        <a href="{env.PUBLIC_EXPLORER_TX_URL}{hash}" target="_blank" rel="external noopener noreferrer" class="grid"><ZenButton tabindex={-1} variant="secondary">
          {#snippet iconLeft()}<ExternalLink class="w-3.5 h-3.5" />{/snippet}View Transaction
        </ZenButton></a>
      {:else if accountExplorerUrl(env.PUBLIC_EXPLORER_TX_URL, to)}
        <a href={accountExplorerUrl(env.PUBLIC_EXPLORER_TX_URL, to)} target="_blank" rel="external noopener noreferrer" class="grid"><ZenButton tabindex={-1} variant="secondary">
          {#snippet iconLeft()}<ExternalLink class="w-3.5 h-3.5" />{/snippet}{EXPLORER_LABEL}
        </ZenButton></a>
      {/if}
      {#if TESTNET}
        <a href="/create" class="grid"><ZenButton tabindex={-1} variant="primary">Send Your Own</ZenButton></a>
      {/if}
    </div>
    {#if hash && !env.PUBLIC_EXPLORER_TX_URL}<p class="text-xs text-zen-fg-subtle">Transaction <span class="font-mono">{middle(hash, 8)}</span></p>{/if}
    <!-- Checked against testnet tx AY7GFZSLZa5R26YTAUyUWA6uTBMJ9MAcmBaZkjnFMa2F: the relayer signs and pays the gas,
         the escrow contract makes the ft_transfer -->
    <p class="text-xs text-zen-fg-subtle">Zarf paid the network fee; the Zarf contract sent the USDC.</p>
  </div>
{/snippet}

<!-- Zarf claim app frame: AppShell container (apps/claim/src/routes/+layout.svelte: w-full max-w-7xl mx-auto p-8 lg:p-12),
     the page column (apps/claim/src/routes/+page.svelte: max-w-5xl w-full px-4 md:px-0), then the card as LoginPrompt.svelte
     lays it out. No page header: the card's own title is the one header (T-023 waste list item 5). -->
<!-- Phones: p-4 shell, no column inset, p-4 card, as the claim page (blue-team gap 2) -->
<div class="w-full max-w-7xl mx-auto p-4 sm:p-8 lg:p-12">
  <div class="h-full flex flex-col relative max-w-5xl w-full mx-auto sm:px-4 md:px-0">
    <section class="w-full pt-8">
      <div class="max-w-lg mx-auto">
  <ZenCard variant="elevated" class="overflow-hidden">
    <div class="p-4 sm:p-8">
    <div class="flex flex-col items-center text-center gap-4">
      {#if recall === 'checking'}
        <Medallion icon={Loader2} tone="muted" spin />
        <h1 class="text-xl font-bold">Checking Claim…</h1>
      {:else if recall === 'error'}
        <Medallion icon={AlertTriangle} tone="error" />
        <h1 class="text-xl font-bold">Couldn't Check Claim</h1>
        <p class="text-sm text-zen-fg-muted max-w-xs" role="alert">NEAR is not answering right now.</p>
        <ZenButton variant="primary" class="w-full sm:w-auto" onclick={verifyRemembered}>Check Again</ZenButton>
      {:else if stored && !stored.chainName}
        {@render nearDone(stored.amount, stored.destination, stored.txHash, '', !!stored.passkey)}
      {:else if stored}
        <ClaimRecord r={stored} amount={stored.amount} {contract} campaign={campaignId} commitment={commitmentId} />
      {:else if !pending && (!ok || !attempt)}
        {#if claimStartedHere(attempt, campaignId, commitmentId)}
          <!-- Reloaded mid-claim: the sign-in was in memory only; the claim page reads where it stands on chain -->
          <h1 class="text-xl font-bold">Page Reloaded</h1>
          <p class="text-sm text-zen-fg-muted max-w-xs">Your claim may still be on its way. Open it to see where it stands.</p>
        {:else}
          <h1 class="text-xl font-bold">No Claim Here Yet</h1>
          <p class="text-sm text-zen-fg-muted max-w-xs">Open the claim link from your message.</p>
          {#if passkeyOn}<PasskeyAccount quiet label="Already Claimed with a Passkey? Open Your Account" />{/if}
        {/if}
        {#if canGoBack}
          {@render back()}
        {:else}
          <a href="/" class="text-xs text-zen-fg-subtle underline underline-offset-2 hover:text-zen-fg">About Zarf</a>
        {/if}
      {:else if payout}
        {@const outcome = bridgeView?.outcome ?? 'in-transit'}
        {@const arrived = outcome === 'paid'}
        {@const refunded = outcome === 'refunded'}
        {@const refunding = outcome === 'refunding'}
        {@const lost = outcome === 'failed'}
        {@const waiting = stalled && outcome === 'in-transit'}
        {@const shown = shownAmount({ chainName: payout.chainName, bridge: outcome, amountOut: bridge?.amountOutFormatted }, formatAmount(BigInt(claimAmount)), UNIT)}
        {#if step === 'done' || working}
          {#if arrived}
            <!-- no disc: "Arrived on …" says it -->
          {:else if refunded}
            <Medallion icon={Undo2} tone="error" />
          {:else if lost}
            <Medallion icon={AlertTriangle} tone="error" />
          {:else if waiting || refunding}
            <Medallion icon={Clock} tone="muted" />
          {:else}
            <Medallion icon={Loader2} tone="muted" spin />
          {/if}
          <h1 class="text-xl font-semibold tracking-tight">
            {#if step === 'checking'}Checking Claim…{:else if working}Sending Your Tokens…{:else if arrived}Arrived on {payout.chainName}{:else if refunded || refunding}Not Delivered{:else if lost}Payout Failed{:else if waiting}Still on Its Way to {payout.chainName}{:else}Sending to {payout.chainName}…{/if}
          </h1>
          <Amount
            label={working ? 'Claiming' : arrived ? 'You Received' : refunded ? 'Returned to the Sender' : refunding ? 'Going Back to the Sender' : lost ? 'Not Delivered' : 'On Its Way'}
            value={shown.value}
            unit={shown.unit}
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
              <Check class="w-4 h-4 text-zen-success shrink-0" aria-hidden="true" />
              <span class="flex-1">Claimed on NEAR</span>
              {#if explorer}<a href={explorer} target="_blank" rel="noopener noreferrer" class="text-xs text-zen-fg-muted underline underline-offset-2 hover:text-zen-fg">Transaction</a>{/if}
            </li>
            <li class="flex items-center gap-3">
              {#if arrived}<Check class="w-4 h-4 text-zen-success shrink-0" aria-hidden="true" />
              {:else if refunded}<Undo2 class="w-4 h-4 text-zen-error shrink-0" aria-hidden="true" />
              {:else if lost}<AlertTriangle class="w-4 h-4 text-zen-error shrink-0" aria-hidden="true" />
              {:else if waiting || refunding}<Clock class="w-4 h-4 text-zen-fg-muted shrink-0" aria-hidden="true" />
              {:else}<Loader2 class="w-4 h-4 text-zen-fg-muted shrink-0 animate-spin" aria-hidden="true" />{/if}
              <span class="flex-1 {refunded || lost ? 'text-zen-error' : ''}" role="status">{waiting ? 'Waiting for the bridge for 30 minutes.' : (bridgeView?.text ?? 'Sent from NEAR, waiting for the bridge.')}</span>
            </li>
          </ol>
          {#if refunded || refunding || lost}<p class="text-sm text-zen-fg-muted max-w-xs">{nextStep(outcome)}</p>{/if}
          {#if bridge?.destinationTx}
            {#if bridge.destinationTx.explorerUrl}{@render explorerButton(bridge.destinationTx.explorerUrl, `View on ${payout.chainName}`)}{:else}<p class="text-xs text-zen-fg-muted">{payout.chainName} transaction <span class="font-mono">{middle(bridge.destinationTx.hash, 8)}</span></p>{/if}
          {/if}
          {#if stalled && !bridgeView?.done}
            <ZenButton variant="secondary" onclick={() => followPayout(depositAddress, true)}>Check Again</ZenButton>
          {/if}
          {#if refunded || refunding || lost || waiting}
            <BridgeDetails {depositAddress} lines={[lost && checkedAt ? notReturnedYet(payout.refundTo, claimedAt(checkedAt)) : '', bridge?.refundReason ? `The bridge said: ${bridge.refundReason}` : '']} />
          {/if}
        {/if}
      {:else if attempt || pending}
        {#if step === 'done'}
          {@render nearDone(claimAmount, claimDestination, txHash, starterNear, !!claimPasskey)}
        {:else if working}
          <div class="w-full text-left space-y-8" in:swapIn>
            <div class="space-y-1">
              <h1 class="text-xl font-semibold">{step === 'checking' ? 'Checking Claim…' : 'Sending Your Tokens…'}</h1>
              <p class="text-sm text-zen-fg-muted font-light flex items-center gap-1.5">
                <span class="text-zen-fg-subtle">To</span><Avatar name={claimDestination} /><span class="font-mono truncate" title={claimDestination}>{middle(claimDestination, 8)}</span>
              </p>
            </div>
            <AmountPanel label="Claiming" value={formatAmount(BigInt(claimAmount))} unit={UNIT} />
            <Steps
              label="Claiming"
              rows={[
                { label: 'Signed In', state: 'done' },
                { label: 'Link Checked', state: step === 'checking' ? 'active' : 'done' },
                { label: 'Sending', state: step === 'checking' ? 'pending' : 'active' },
              ]}
            />
            <p class="text-xs text-zen-fg-subtle">Keep this page open. It usually settles within a minute.</p>
          </div>
        {:else}
          {@render failureCard()}
        {/if}
      {/if}
    </div>
    </div>
  </ZenCard>
      </div>
    </section>
  </div>
</div>
