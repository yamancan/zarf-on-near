<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { env } from '$env/dynamic/public';
  import {
    classifyDestination, claimState, deadlineText, destinationNonce, googleAuthUrl, isCampaignId, isHex32, isValidAccountId, loadAttempt, loadReceipt,
    middle, newAttemptId, parseLinkFragment, saveAttempt, timeLeft, type LinkSecret,
  } from '$lib/claim';
  import { rootFromProof } from '$lib/merkle';
  import { accountExists, ClaimError, describeCheckError, describeError, getCampaign, getClaimState, getNetwork } from '$lib/services';
  import { getQuote, lossBps, MAX_LOSS_BPS, QUOTE_LIFETIME_MS, QuoteError, type PayoutAsset } from '$lib/intents';
  import PayoutPicker from '$lib/PayoutPicker.svelte';
  import { AlertTriangle, ArrowUpRight, CheckCircle, ChevronDown, Clock, Link2Off, Loader2, Mail, SearchX, ShieldCheck } from 'lucide-svelte';
  import Amount from '$lib/Amount.svelte';
  import Medallion from '$lib/Medallion.svelte';
  import Note from '$lib/Note.svelte';
  import ZenButton from '$lib/zen/components/ZenButton.svelte';
  import ZenCheckbox from '$lib/zen/components/ZenCheckbox.svelte';
  import ZenCard from '$lib/zen/components/ZenCard.svelte';
  import ZenInput from '$lib/zen/components/ZenInput.svelte';
  import { themeStore } from '$lib/zen/stores/themeStore.svelte';
  import { formatAmount } from '$lib/create/recipients';
  import { createImplicitAccount, keyFile, type ImplicitAccount } from '$lib/implicit';

  const campaign = page.params.campaign!;
  const commitment = page.params.commitment!;
  const linkOk = isCampaignId(campaign) && isHex32(commitment);
  // Off unless PUBLIC_IMPLICIT_ACCOUNTS=on: a fresh implicit account has no NEAR to move the tokens on.
  const implicitEnabled = env.PUBLIC_IMPLICIT_ACCOUNTS === 'on';

  let link = $state<LinkSecret | null>(null);
  // The link's own leaf and proof must rebuild the root the contract holds, before any sign-in.
  // Every state but 'ok' replaces the form: nothing is asked of the recipient that cannot succeed.
  let check = $state<'checking' | 'ok' | 'mismatch' | 'unknown' | 'ended' | 'claimed' | 'pending' | 'error'>('checking');
  let loaded = $state(false);
  let mode = $state<'existing' | 'new' | 'chain'>('existing');
  let network = $state('');
  let sender = $state('');
  let payout = $state<{ asset: PayoutAsset; recipient: string } | null>(null);
  let busy = $state('');
  let typed = $state('');
  let implicit = $state<ImplicitAccount | null>(null);
  let exported = $state(false);
  let confirmed = $state(false);
  let error = $state('');
  let deadline = $state('loading…');
  let left = $state('');
  let checkError = $state('');
  // A claim this browser finished earlier (receipt page): lets "Already claimed" show what was paid.
  const paid = loadReceipt(campaign, commitment);
  const MODES = $derived([
    ['existing', 'NEAR account'],
    ...(network === 'mainnet' ? [['chain', 'Another chain']] : []),
    ...(implicitEnabled ? [['new', 'New account']] : []),
  ] as [typeof mode, string][]);
  const walletSite = $derived(network === 'mainnet' ? 'https://app.mynearwallet.com' : 'https://testnet.mynearwallet.com');

  const dest = $derived(classifyDestination(typed));
  const destination = $derived(mode === 'existing' ? (dest.kind === 'named' || dest.kind === 'implicit' ? dest.id : '') : (implicit?.accountId ?? ''));
  // The typed account, read on chain before sign-in: a typo must never be paid (NEAR account-validation guide).
  let acct = $state<{ id: string; state: 'checking' | 'found' | 'missing' | 'error' } | null>(null);
  let unfundedAck = $state(false);
  const accountOk = $derived(
    !!acct && acct.id === destination && (acct.state === 'found' || (acct.state === 'missing' && dest.kind === 'implicit' && unfundedAck)),
  );
  const ready = $derived(
    !!link && check === 'ok' && !busy &&
      (mode === 'chain' ? !!payout : isValidAccountId(destination) && (mode === 'existing' ? accountOk : exported && confirmed)),
  );

  $effect(() => {
    const id = mode === 'existing' ? destination : '';
    unfundedAck = false;
    if (!id) {
      acct = null;
      return;
    }
    acct = { id, state: 'checking' };
    const t = setTimeout(async () => {
      let state: 'found' | 'missing' | 'error';
      try {
        state = (await accountExists(env.PUBLIC_NEAR_RPC_URL, id)) ? 'found' : 'missing';
      } catch {
        state = 'error';
      }
      if (acct?.id === id) acct = { id, state }; // a later keystroke owns the field now
    }, 400);
    return () => clearTimeout(t);
  });

  onMount(() => {
    const prev = loadAttempt();
    const same = prev?.campaign === campaign && prev.commitment === commitment && prev.salt && prev.amount && Array.isArray(prev.proof);
    link = parseLinkFragment(location.hash) ?? (same ? { salt: prev!.salt, amount: prev!.amount, proof: prev!.proof } : null);
    // Keep the salt out of the address bar and synced history; this tab's sessionStorage holds it.
    if (location.hash) history.replaceState(history.state, '', location.pathname); // $app/navigation's replaceState throws before the router is up
    if (link && linkOk) saveAttempt({ campaign, commitment, ...link, destination: '', attemptId: '' });
    loaded = true;
    if (link && linkOk) checkLink(link);
  });

  async function checkLink(l: LinkSecret) {
    check = 'checking';
    try {
      const [c, net] = await Promise.all([
        getCampaign(env.PUBLIC_NEAR_RPC_URL, env.PUBLIC_CONTRACT_ID, campaign),
        getNetwork(env.PUBLIC_NEAR_RPC_URL, env.PUBLIC_CONTRACT_ID),
      ]);
      network = net;
      if (!c) {
        check = 'unknown';
        return;
      }
      sender = c.sender;
      const ms = Number(BigInt(c.deadline_ns) / 1_000_000n);
      deadline = deadlineText(ms, Date.now());
      left = timeLeft(ms, Date.now());
      if ((await rootFromProof(commitment, l.amount, l.proof)) !== c.merkle_root) {
        check = 'mismatch';
        return;
      }
      const state = await getClaimState(env.PUBLIC_NEAR_RPC_URL, env.PUBLIC_CONTRACT_ID, campaign, commitment);
      if (state !== 'unclaimed') check = state;
      else check = BigInt(Date.now()) * 1_000_000n > BigInt(c.deadline_ns) ? 'ended' : 'ok';
    } catch (e) {
      check = 'error';
      checkError = describeCheckError(e);
    }
  }

  async function create() {
    error = '';
    try {
      implicit = await createImplicitAccount();
      exported = confirmed = false;
    } catch {
      error = 'This browser cannot create a NEAR key. Use an existing account instead.';
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([keyFile(implicit!)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${implicit!.accountId}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    exported = true;
  }

  async function signIn() {
    const clientId = env.PUBLIC_GOOGLE_CLIENT_ID;
    if (!clientId) {
      error = 'Google sign-in is not configured on this site yet.';
      return;
    }
    const attemptId = newAttemptId();
    let to = destination;
    let intents;
    if (mode === 'chain') {
      // One real quote per sign-in: its deposit address is the signed destination, never reused.
      const { asset, recipient } = payout!;
      const requestDeadline = new Date(Date.now() + QUOTE_LIFETIME_MS).toISOString();
      busy = 'Getting your quote…';
      try {
        const q = await getQuote(false, { amount: link!.amount, assetId: asset.assetId, recipient, refundTo: sender, deadline: requestDeadline });
        if (lossBps(link!.amount, q.minAmountOut, asset.decimals) > MAX_LOSS_BPS) throw new QuoteError('the price moved too far. Try again.');
        to = q.depositAddress!;
        intents = { chainName: asset.chain.name, assetId: asset.assetId, recipient, refundTo: sender, requestDeadline, amountOutFormatted: q.amountOutFormatted };
      } catch (e) {
        error = e instanceof QuoteError ? `The bridge refused this payout: ${e.message}` : 'Cross-chain quotes are unavailable right now. Try again, or claim to a NEAR account.';
        busy = '';
        return;
      }
    }
    saveAttempt({ campaign, commitment, ...link!, destination: to, attemptId, intents });
    location.href = googleAuthUrl({
      clientId,
      redirectUri: `${location.origin}/auth/google`,
      nonce: await destinationNonce(to),
      state: claimState(campaign, commitment, attemptId),
    });
  }
</script>

<svelte:head><title>Claim your USDC · Zarf</title></svelte:head>


{#snippet terminal(Icon: typeof Mail, tone: 'success' | 'error' | 'muted', title: string, line: string, action: 'home' | 'recheck' | 'none')}
  <div class="flex flex-col items-center text-center gap-4 py-2">
    <Medallion icon={Icon} {tone} />
    <h1 class="text-xl font-semibold tracking-tight">{title}</h1>
    <p class="text-sm text-zen-fg-muted max-w-xs" role={tone === 'error' ? 'alert' : undefined}>{line}</p>
    {#if action === 'recheck'}
      <ZenButton variant="primary" class="rounded-full min-h-11 mt-2" onclick={() => link && checkLink(link)}>Check again</ZenButton>
    {:else if action === 'home'}
      <ZenButton href="/" variant="secondary" class="rounded-full min-h-11 mt-2">What is Zarf?</ZenButton>
    {/if}
  </div>
{/snippet}

<div class="w-full max-w-lg mx-auto px-4 py-8 sm:py-14">
  <ZenCard variant="elevated" class="!p-6 sm:!p-8">
    <div class="flex flex-col gap-6">
      {#if !linkOk}
        {@render terminal(Link2Off, 'muted', 'This claim link is broken', 'Open the link from your email again, in full.', 'home')}
      {:else if loaded && !link}
        {@render terminal(Link2Off, 'muted', 'This claim link is incomplete', 'The part after # is missing. Open the full link from your email again.', 'home')}
      {:else if check === 'mismatch'}
        {@render terminal(Link2Off, 'error', 'This link cannot be claimed', describeError(new ClaimError('LINK_MISMATCH')), 'home')}
      {:else if check === 'unknown'}
        {@render terminal(SearchX, 'muted', 'Campaign not found', "This link's campaign was not found. Ask the sender for your link again.", 'home')}
      {:else if check === 'claimed'}
        <div class="flex flex-col items-center text-center gap-4 py-2">
          <Medallion icon={CheckCircle} tone="success" />
          <h1 class="text-xl font-semibold tracking-tight">Already claimed</h1>
          <Amount label={paid ? 'Paid out' : 'This link held'} value={formatAmount(BigInt(link!.amount))} unit={network === 'mainnet' ? 'USDC' : 'test USDC'} />
          {#if paid}
            <p class="text-sm text-zen-fg-muted">to <span class="font-mono text-zen-fg" title={paid.destination}>{middle(paid.destination, 8)}</span>{paid.chainName ? ` on ${paid.chainName}` : ''}</p>
            {#if env.PUBLIC_EXPLORER_TX_URL}
              <ZenButton href="{env.PUBLIC_EXPLORER_TX_URL}{paid.txHash}" target="_blank" rel="noopener noreferrer" variant="secondary" class="rounded-full min-h-11">
                View the transaction
                {#snippet iconRight()}<ArrowUpRight class="w-3.5 h-3.5" />{/snippet}
              </ZenButton>
            {/if}
          {:else}
            <p class="text-sm text-zen-fg-muted max-w-xs">The tokens for this link have been paid out.</p>
          {/if}
        </div>
      {:else if check === 'pending'}
        {@render terminal(Clock, 'muted', 'This claim is being paid', 'A claim for this link is in progress. It usually settles within a minute.', 'recheck')}
      {:else if check === 'ended'}
        {@render terminal(Clock, 'muted', 'This campaign has ended', `Claims closed on ${deadline}. Ask the sender about it.`, 'home')}
      {:else if check === 'error'}
        {@render terminal(AlertTriangle, 'error', 'Could not check this claim', checkError, 'recheck')}
      {:else if loaded && check === 'checking'}
        <div class="flex flex-col items-center gap-4 py-8">
          <Medallion icon={Loader2} tone="muted" spin />
          <p class="text-sm text-zen-fg-muted" role="status">Checking your claim…</p>
        </div>
      {:else if loaded}
        <!-- Header: medallion, the amount as the hero figure, one muted line -->
        <div class="flex flex-col items-center text-center gap-4">
          <Medallion icon={Mail} />
          <h1><Amount label="Waiting for you" value={formatAmount(BigInt(link!.amount))} unit={network === 'mainnet' ? 'USDC' : 'test USDC'} /></h1>
          <p class="text-xs text-zen-fg-muted">
            From <span class="font-mono">{sender}</span>{#if left}{' · '}<span title="Claim by {deadline}">{left}</span>{/if}
          </p>
        </div>

        <!-- Destination: one question, one field; a switch only when there is a real choice -->
        <div class="flex flex-col gap-3">
          {#if MODES.length > 1}
            <h2 id="dest-q" class="text-sm font-medium text-zen-fg">Where should it go?</h2>
            <div class="control-border grid gap-1 p-1 rounded-full" style="grid-template-columns: repeat({MODES.length}, minmax(0, 1fr))" role="radiogroup" aria-labelledby="dest-q">
              {#each MODES as [value, text] (value)}
                <label
                  class="flex items-center justify-center min-h-10 whitespace-nowrap text-sm font-medium rounded-full px-2 cursor-pointer transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-zen-fg
                    {mode === value ? 'bg-zen-fg text-zen-bg' : 'text-zen-fg-muted hover:text-zen-fg'}"
                >
                  <input class="sr-only" type="radio" bind:group={mode} {value} />{text}
                </label>
              {/each}
            </div>
          {/if}

          {#if mode === 'chain'}
            <PayoutPicker {network} amount={link!.amount} refundTo={sender} bind:choice={payout} />
          {:else if mode === 'existing'}
            <label for="dest" class="text-sm font-medium text-zen-fg {MODES.length > 1 ? 'sr-only' : ''}">Your NEAR account</label>
            <ZenInput
              id="dest"
              class="control-border"
              bind:value={typed}
              placeholder={network === 'mainnet' ? 'alice.near' : 'alice.testnet'}
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              aria-invalid={dest.kind === 'wrong' || (acct?.state === 'missing' && dest.kind === 'named')}
              aria-describedby="dest-note"
            />
            <div id="dest-note" class="flex flex-col gap-2 pl-1">
              {#if dest.kind === 'wrong'}
                <Note tone="error">{dest.reason}</Note>
              {:else if acct?.state === 'checking'}
                <Note tone="pending">Checking <span class="font-mono">{acct.id}</span>…</Note>
              {:else if acct?.state === 'found'}
                <Note tone="success"><span class="font-mono">{acct.id}</span> found</Note>
              {:else if acct?.state === 'missing' && dest.kind === 'named'}
                <Note tone="error">There is no NEAR account called <span class="font-mono">{acct.id}</span>. Check the spelling.</Note>
              {:else if acct?.state === 'missing'}
                <Note tone="info">This account is not on chain yet.</Note>
                <ZenCheckbox bind:checked={unfundedAck} label="Only the holder of its private key can use these funds. I hold it." />
              {:else if acct?.state === 'error'}
                <Note tone="error">Could not check this account right now. Try again in a minute.</Note>
              {/if}
              {#if acct?.state !== 'found'}
                <p class="text-xs text-zen-fg-muted">
                  No NEAR account? <a href={walletSite} target="_blank" rel="noopener noreferrer" class="underline underline-offset-2 hover:text-zen-fg">Create a free one at MyNearWallet</a>, then type it here. This tab keeps your claim.
                </p>
              {/if}
            </div>
          {:else if !implicit}
            <p class="text-sm text-zen-fg-muted">We create a NEAR account in this browser. Only you get its key.</p>
            <ZenButton variant="secondary" class="rounded-full min-h-11 self-center" onclick={create}>Create my NEAR account</ZenButton>
          {:else}
            <p class="text-sm text-zen-fg-muted">Your new account <span class="font-mono text-zen-fg" title={implicit.accountId}>{middle(implicit.accountId, 8)}</span></p>
            <Note tone="info">Save its key now. Without it nobody can move these funds, and we never see it.</Note>
            <ZenButton variant="secondary" class="rounded-full min-h-11 self-start" onclick={download}>Download key</ZenButton>
            <ZenCheckbox bind:checked={confirmed} disabled={!exported} label="I saved the key somewhere safe" />
          {/if}
        </div>

        <!-- Sign in: which account first, then Google's own pill asset -->
        <div class="flex flex-col items-center gap-3 pt-1">
          <p class="text-xs text-zen-fg-muted text-center">Use the Google account this link was sent to.</p>
          {#if busy}<Note tone="pending">{busy}</Note>{/if}
          <button class="google" disabled={!ready} onclick={signIn}>
            <img src={themeStore.isDark ? '/google/signin-dark.svg' : '/google/signin-light.svg'} alt="Sign in with Google" width="180" height="40" />
          </button>
        </div>

        <!-- One honest line; the rest one layer down -->
        <details class="group text-xs text-zen-fg-muted border-t-[0.5px] border-zen-border-subtle pt-4">
          <summary class="flex items-center justify-center gap-2 min-h-11 cursor-pointer list-none hover:text-zen-fg">
            <ShieldCheck class="w-4 h-4 shrink-0" aria-hidden="true" />
            The email never goes on chain
            <ChevronDown class="w-3.5 h-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div class="mt-2 flex flex-col gap-2 leading-relaxed">
            <p>Our verifier, operated by Trion Labs, sees your email once to check this claim, and does not store it.</p>
            <p>
              The sign-in only proves the email and is bound to the destination you chose, so it cannot pay anyone else. We
              cannot access your Google account. The USDC usually arrives in about a minute.
            </p>
            {#if network !== 'mainnet'}<p>This is NEAR testnet: the USDC is a test token with no value. Payouts to Base, Arbitrum and Ethereum run on mainnet.</p>{/if}
            <p>Claim by {deadline}.</p>
          </div>
        </details>
      {/if}

      {#if error}<Note tone="error" class="justify-center">{error}</Note>{/if}
    </div>
  </ZenCard>
</div>

<style>
  /* Google's pre-approved asset (pill variant), unchanged; the off state only lowers its opacity (branding guidelines). */
  .google {
    display: block;
    padding: 0;
    border: 0;
    background: none;
    line-height: 0;
    border-radius: 9999px;
    cursor: pointer;
  }
  .google:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .google img {
    width: 240px;
    height: auto;
  }
  .google:focus-visible {
    outline: 2px solid var(--zen-fg);
    outline-offset: 3px;
  }
</style>
