<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { env } from '$env/dynamic/public';
  import {
    classifyDestination, claimState, nearAccountReady, type AccountCheck, deadlineText, destinationNonce, googleAuthUrl, isCampaignId, isHex32, isValidAccountId, loadAttempt, loadReceipt,
    middle, newAttemptId, parseLinkFragment, saveAttempt, timeLeft, type LinkSecret,
  } from '$lib/claim';
  import { rootFromProof } from '$lib/merkle';
  import { accountExists, ClaimError, describeCheckError, describeError, getCampaign, getClaimState, getNetwork } from '$lib/services';
  import { crossChainOffered, getQuote, payoutCapError, QUOTE_LIFETIME_MS, withinLossBound, QuoteError, refusal, type PayoutAsset } from '$lib/intents';
  import PayoutPicker from '$lib/PayoutPicker.svelte';
  import { AlertTriangle, ArrowUpRight, ChevronDown, Clock, Link2Off, Loader2, Mail, SearchX } from 'lucide-svelte';
  import ClaimRecord from '$lib/ClaimRecord.svelte';
  import { UNAUDITED_LINE, UNIT, USDC_LINES } from '$lib/network';
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
  const paid = loadReceipt(env.PUBLIC_CONTRACT_ID ?? '', campaign, commitment);
  const MODES = $derived([
    ['existing', 'NEAR account'],
    ...(crossChainOffered(network, env.PUBLIC_CROSS_CHAIN) ? [['chain', 'Another chain']] : []), // testnet: chains marked "mainnet only" (canonical choice 9); mainnet: behind a flag
    ...(implicitEnabled ? [['new', 'New account']] : []),
  ] as [typeof mode, string][]);
  // MyNearWallet stopped creating accounts (Nov 2026). Meteor creates named accounts on both networks.
  const METEOR = 'https://wallet.meteorwallet.app';
  const ethOn = env.PUBLIC_ETH_ACCOUNTS === 'on'; // 0x (NEP-518) destinations, off until a real claim proves them

  const dest = $derived(classifyDestination(typed, { escrow: env.PUBLIC_CONTRACT_ID, token: env.PUBLIC_TOKEN_ID, eth: ethOn }));
  const destination = $derived(mode === 'existing' ? (dest.kind === 'named' || dest.kind === 'implicit' ? dest.id : '') : (implicit?.accountId ?? ''));
  // The typed account, read on chain before sign-in: a typo must never be paid (NEAR account-validation guide).
  let acct = $state<AccountCheck>(null);
  let unfundedAck = $state(false);
  // "Is this your account?": answered for one exact id; any edit asks again.
  let confirmedFor = $state('');
  const accountOk = $derived(nearAccountReady(dest, acct, unfundedAck, confirmedFor));
  const askConfirm = $derived(!accountOk && nearAccountReady(dest, acct, unfundedAck, destination)); // all but the answer
  let guideOpen = $state(false);
  // "Use my wallet": the account comes from the recipient's own wallet (NEAR Connect sign-in, no key added), so it
  // cannot be mistyped. The confirm step still applies: the wallet's code is not ours.
  let walletNote = $state('');
  async function useWallet() {
    walletNote = 'Opening your wallet…';
    try {
      const { nearConnectWallet } = await import('$lib/create/wallet');
      // MetaMask (0x ids) only when the field accepts them; signIn always opens the picker, never a stale connection.
      const w = await nearConnectWallet(network, env.PUBLIC_NEAR_RPC_URL ?? '', { ethereum: ethOn });
      typed = await w.signIn();
      walletNote = '';
    } catch {
      walletNote = 'No account came back from the wallet. Try again, or type the account name.';
    }
  }
  function backToField() {
    guideOpen = false;
    document.getElementById('dest')?.focus();
  }
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

  // A refused or failed real quote: offer a fresh one or the NEAR path (flow canvas N2-08).
  let quoteFailed = $state(false);
  let requote = $state(0);
  $effect(() => {
    void mode;
    quoteFailed = false;
  });

  async function signIn() {
    error = '';
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
        if (payoutCapError(link!.amount)) throw new QuoteError(payoutCapError(link!.amount)!); // before any real quote
        const q = await getQuote(false, { amount: link!.amount, assetId: asset.assetId, recipient, refundTo: sender, deadline: requestDeadline });
        if (!withinLossBound(link!.amount, q.minAmountOut, asset.decimals)) throw new QuoteError('The bridge would pay too little: the price moved too far.');
        to = q.depositAddress!;
        intents = { chainName: asset.chain.name, assetId: asset.assetId, recipient, refundTo: sender, requestDeadline, amountOutFormatted: q.amountOutFormatted };
      } catch (e) {
        error = e instanceof QuoteError ? refusal(e.message, asset.chain.name) : 'Cross-chain quotes are unavailable right now. Try again, or claim to a NEAR account.';
        quoteFailed = true;
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
      <ZenButton variant="primary" class="rounded-full min-h-11 mt-2 w-full sm:w-auto" onclick={() => link && checkLink(link)}>Check again</ZenButton>
    {:else if action === 'home'}
      <ZenButton href="/" variant="secondary" class="rounded-full min-h-11 mt-2">What is Zarf?</ZenButton>
    {/if}
  </div>
{/snippet}

<div class="w-full max-w-lg mx-auto px-4 py-8 sm:py-14">
  <ZenCard variant="elevated" class="!p-6 sm:!p-8">
    <div class="flex flex-col gap-6">
      {#if !linkOk}
        {@render terminal(Link2Off, 'muted', 'This claim link is broken', 'Copy the whole link from your message and open it again.', 'home')}
      {:else if loaded && !link}
        {@render terminal(Link2Off, 'muted', 'This claim link is incomplete', 'Part of it is missing. Copy the whole link from your message and open it again.', 'home')}
      {:else if check === 'mismatch'}
        {@render terminal(Link2Off, 'error', 'This link cannot be claimed', describeError(new ClaimError('LINK_MISMATCH')), 'home')}
      {:else if check === 'unknown'}
        {@render terminal(SearchX, 'muted', 'Campaign not found', 'Ask the sender for your link again.', 'home')}
      {:else if check === 'claimed'}
        <div class="flex flex-col items-center text-center gap-4 py-2">
          <ClaimRecord r={paid} amount={link!.amount} title="Already claimed" contract={env.PUBLIC_CONTRACT_ID ?? ''} {campaign} {commitment} />
        </div>
      {:else if check === 'pending'}
        {@render terminal(Clock, 'muted', 'This claim is being paid', 'It usually settles within a minute.', 'recheck')}
      {:else if check === 'ended'}
        {@render terminal(Clock, 'muted', 'This campaign has ended', `Claims closed on ${deadline}. Ask the sender about it.`, 'home')}
      {:else if check === 'error'}
        {@render terminal(AlertTriangle, 'error', 'Could not check this claim', checkError, 'recheck')}
      {:else if loaded && check === 'checking'}
        <div class="flex flex-col items-center text-center gap-4 py-6">
          <Medallion icon={Loader2} tone="muted" spin />
          <h1 class="text-xl font-semibold tracking-tight">Checking your claim…</h1>
          <p class="text-sm text-zen-fg-muted max-w-xs" role="status">Reading this link's campaign on NEAR.</p>
        </div>
      {:else if loaded}
        <!-- Header: medallion, the amount as the hero figure, one muted line -->
        <div class="flex flex-col items-center text-center gap-4">
          <Medallion icon={Mail} />
          <h1><Amount label="Waiting for you" value={formatAmount(BigInt(link!.amount))} unit={UNIT} /></h1>
          <p class="text-xs text-zen-fg-muted">
            From <span class="font-mono">{sender}</span>{#if left}{' · '}<span class="whitespace-nowrap" title="Claim by {deadline}">{left}</span>{/if}
          </p>
          <p class="text-xs text-zen-fg-muted max-w-xs">{USDC_LINES[0]}</p>
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
            <PayoutPicker {network} amount={link!.amount} refundTo={sender} {requote} onUseNear={() => ((error = ''), (mode = 'existing'))} bind:choice={payout} />
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
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
              <ZenButton variant="secondary" class="rounded-full min-h-11" disabled={walletNote === 'Opening your wallet…'} onclick={useWallet}>Use my wallet</ZenButton>
              <span class="text-xs text-zen-fg-muted">{walletNote || 'Fills in your account from a NEAR wallet.'}</span>
            </div>
            <div id="dest-note" class="flex flex-col gap-2 pl-1">
              {#if dest.kind === 'wrong'}
                <Note tone="error">{dest.reason}</Note>
              {:else if acct?.state === 'checking'}
                <Note tone="pending">Checking <span class="font-mono">{acct.id}</span>…</Note>
              {:else if acct?.state === 'found' && !askConfirm}
                <Note tone="success"><span class="font-mono">{acct.id}</span> found</Note>
              {:else if acct?.state === 'missing' && dest.kind === 'named'}
                <Note tone="error">There is no NEAR account called <span class="font-mono">{acct.id}</span>. Check the spelling.</Note>
              {:else if acct?.state === 'missing'}
                <Note tone="error">This account is not on NEAR yet. Check every character: one typo sends the USDC where nobody can reach it.</Note>
                <ZenCheckbox bind:checked={unfundedAck} label="Only the holder of its private key can use these funds. I hold it." />
              {:else if acct?.state === 'error'}
                <Note tone="error">Could not check this account right now. Try again in a minute.</Note>
              {/if}
              {#if askConfirm}
                <!-- Wrong-address guard: the account restated large, before Google (a paid claim cannot be undone) -->
                <div id="confirm" class="flex flex-col gap-3 mt-1 p-4 rounded-xl border-[0.5px] border-zen-border" role="group" aria-labelledby="confirm-q">
                  <p id="confirm-q" class="text-sm font-medium text-zen-fg">Is this your account?</p>
                  <p class="text-2xl font-mono font-semibold tracking-tight break-all text-zen-fg">{destination}</p>
                  <p class="text-xs text-zen-fg-muted">The USDC goes here and cannot be taken back.</p>
                  <div class="flex flex-wrap gap-3">
                    <ZenButton variant="primary" class="rounded-full min-h-11" onclick={() => (confirmedFor = destination)}>Yes, it's mine</ZenButton>
                    <ZenButton variant="ghost" class="rounded-full min-h-11 !text-zen-fg" onclick={backToField}>No, change it</ZenButton>
                  </div>
                </div>
              {:else if accountOk}
                <button type="button" class="self-start min-h-11 text-xs text-zen-fg-muted underline underline-offset-2 hover:text-zen-fg" onclick={() => ((confirmedFor = ''), backToField())}>Change account</button>
              {/if}
              {#if acct?.state !== 'found' && !(dest.kind === 'implicit' && acct?.state === 'missing')}
                <!-- No account yet: a guide in this tab, the wallet in a new one; the claim stays here (flow canvas N2-10) -->
                <details class="group text-xs text-zen-fg-muted" bind:open={guideOpen}>
                  <summary class="inline-flex items-center gap-1.5 min-h-11 cursor-pointer list-none hover:text-zen-fg">
                    No NEAR account yet? <ChevronDown class="w-3.5 h-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />
                  </summary>
                  <ol id="guide" class="flex flex-col gap-2 text-sm text-zen-fg list-decimal pl-5 marker:text-zen-fg-muted">
                    <li>Open Meteor, a free NEAR wallet, with the button below. It opens in a new tab; this tab keeps your claim.</li>
                    {#if network !== 'mainnet'}<li>In Meteor, switch the network to <strong>Testnet</strong>.</li>{/if}
                    <li>Create a new wallet and pick an account name, like <span class="font-mono">{network === 'mainnet' ? 'alice.near' : 'alice.testnet'}</span>. Save the recovery phrase Meteor shows you.</li>
                    <li>Copy the account name, come back to this tab and paste it above.</li>
                  </ol>
                  <div class="mt-3 flex flex-wrap items-center gap-3">
                    <ZenButton href={METEOR} target="_blank" rel="noopener noreferrer" variant="secondary" class="rounded-full min-h-11">
                      Open Meteor
                      {#snippet iconRight()}<ArrowUpRight class="w-3.5 h-3.5" />{/snippet}
                    </ZenButton>
                    <ZenButton variant="ghost" class="rounded-full min-h-11 !text-zen-fg" onclick={backToField}>I have my account: paste it</ZenButton>
                  </div>
                </details>
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
          <p class="text-sm text-zen-fg text-center max-w-xs"><Mail class="inline-block w-4 h-4 mr-1.5 -mt-0.5 align-middle text-zen-fg-muted" aria-hidden="true" />Use the Google account this link was sent to.</p>
          {#if busy}<Note tone="pending">{busy}</Note>{/if}
          <button class="google" disabled={!ready} onclick={signIn}>
            <img src={themeStore.isDark ? '/google/signin-dark.svg' : '/google/signin-light.svg'} alt="Sign in with Google" width="180" height="40" />
          </button>
          <p class="text-xs text-zen-fg-muted text-center">Another account? Pick it on Google's screen.</p>
          {#if mode === 'chain' && network !== 'mainnet'}
            <!-- Why the button is off here, and the way on (empathy walkthrough) -->
            <div class="flex flex-col items-center gap-2">
              <p class="text-sm text-zen-fg-muted text-center">On testnet, claim to a NEAR account.</p>
              <ZenButton variant="secondary" class="rounded-full min-h-11" onclick={() => ((error = ''), (mode = 'existing'))}>Use a NEAR account</ZenButton>
            </div>
          {/if}
          {#if error}<Note tone="error" center>{error}</Note>{/if}
          {#if quoteFailed && mode === 'chain'}
            <div class="flex flex-wrap justify-center gap-3">
              <ZenButton variant="secondary" class="rounded-full min-h-11" onclick={() => ((error = ''), (quoteFailed = false), (requote += 1))}>Get a new quote</ZenButton>
              <ZenButton variant="ghost" class="rounded-full min-h-11 !text-zen-fg" onclick={() => ((error = ''), (mode = 'existing'))}>Claim to a NEAR account</ZenButton>
            </div>
          {/if}
        </div>

        <!-- One honest line; the rest one layer down -->
        <details class="group text-xs text-zen-fg-muted border-t-[0.5px] border-zen-border-subtle pt-4">
          <summary class="flex items-center justify-center gap-2 min-h-11 cursor-pointer list-none hover:text-zen-fg">
            Who sees the email?
            <ChevronDown class="w-3.5 h-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div class="mt-2 flex flex-col gap-2 leading-relaxed">
            <p>The email never goes on chain. Our verifier, operated by Trion Labs, sees your email once to check this claim, and does not store it.</p>
            <p>
              The sign-in only proves the email and is bound to the destination you chose, so it cannot pay anyone else. We
              cannot access your Google account. The USDC usually arrives in about a minute.
            </p>
            {#if network !== 'mainnet'}<p>This is NEAR testnet: the USDC is a test token with no value. Payouts to Base, Arbitrum and Ethereum run on mainnet.</p>{:else}<p>{UNAUDITED_LINE}</p>{/if}
            <p>Claim by {deadline}.</p>
          </div>
        </details>
      {/if}

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
