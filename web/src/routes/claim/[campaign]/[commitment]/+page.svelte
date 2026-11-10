<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { env } from '$env/dynamic/public';
  import {
    classifyDestination, claimState, deadlineText, destinationNonce, googleAuthUrl, isCampaignId, isHex32, isValidAccountId, loadAttempt, newAttemptId,
    parseLinkFragment, saveAttempt, type LinkSecret,
  } from '$lib/claim';
  import { rootFromProof } from '$lib/merkle';
  import { accountExists, ClaimError, describeError, getCampaign, getClaimState, getNetwork } from '$lib/services';
  import { getQuote, lossBps, MAX_LOSS_BPS, QUOTE_LIFETIME_MS, QuoteError, type PayoutAsset } from '$lib/intents';
  import PayoutPicker from '$lib/PayoutPicker.svelte';
  import { AlertTriangle, Check, CheckCircle, ChevronDown, Clock, Link2Off, Loader2, Mail, SearchX, ShieldCheck } from 'lucide-svelte';
  import ZenBadge from '$lib/zen/components/ZenBadge.svelte';
  import ZenButton from '$lib/zen/components/ZenButton.svelte';
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
  let checkError = $state('');

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
      deadline = deadlineText(Number(BigInt(c.deadline_ns) / 1_000_000n), Date.now());
      if ((await rootFromProof(commitment, l.amount, l.proof)) !== c.merkle_root) {
        check = 'mismatch';
        return;
      }
      const state = await getClaimState(env.PUBLIC_NEAR_RPC_URL, env.PUBLIC_CONTRACT_ID, campaign, commitment);
      if (state !== 'unclaimed') check = state;
      else check = BigInt(Date.now()) * 1_000_000n > BigInt(c.deadline_ns) ? 'ended' : 'ok';
    } catch (e) {
      check = 'error';
      deadline = `unavailable (${describeError(e)})`;
      checkError = describeError(e);
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

  async function copy() {
    await navigator.clipboard.writeText(implicit!.privateKey);
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
        error = e instanceof QuoteError ? `1Click refused this payout: ${e.message}` : 'Cross-chain quotes are unavailable right now. Try again, or claim to a NEAR account.';
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

{#snippet medallion(Icon: typeof Mail, tone: 'primary' | 'success' | 'error' | 'muted', spin = false)}
  <!-- Medallion from the main claim app (LoginPrompt, ClaimStep4Proof) -->
  <div
    class="w-14 h-14 rounded-full flex items-center justify-center shrink-0 border
      {tone === 'success' ? 'bg-zen-success/10 text-zen-success border-zen-success/10'
      : tone === 'error' ? 'bg-zen-error/5 text-zen-error border-zen-error/10'
      : tone === 'muted' ? 'bg-zen-fg/5 text-zen-fg-muted border-zen-border-subtle'
      : 'bg-zen-primary/10 text-zen-primary border-transparent'}"
    aria-hidden="true"
  >
    <Icon class="w-6 h-6 {spin ? 'animate-spin' : ''}" />
  </div>
{/snippet}

{#snippet terminal(Icon: typeof Mail, tone: 'success' | 'error' | 'muted', title: string, line: string, alert: boolean, newLink: boolean)}
  <div class="flex flex-col items-center text-center gap-4 py-4">
    {@render medallion(Icon, tone)}
    <h1 class="text-2xl font-semibold tracking-tight">{title}</h1>
    <p class="text-sm max-w-xs {alert ? 'text-zen-error' : 'text-zen-fg-muted'}" role={alert ? 'alert' : undefined}>{line}</p>
    {#if newLink}<p class="text-xs text-zen-fg-subtle">Nothing was taken from you. Ask the sender for a new link.</p>{/if}
    <a href="/" class="mt-2 inline-flex items-center justify-center min-h-11 px-5 rounded-full text-sm font-medium no-underline text-zen-fg-muted hover:text-zen-fg bg-zen-fg/5 hover:bg-zen-fg/10 transition-colors">What is Zarf?</a>
  </div>
{/snippet}

<div class="w-full max-w-md mx-auto px-4 py-8 sm:py-14">
  <ZenCard variant="glass" padding="lg" radius="3xl" class="!p-6 sm:!p-8">
    <div class="flex flex-col gap-6">
      {#if !linkOk}
        {@render terminal(Link2Off, 'muted', 'This claim link is broken', 'Open the link from your email again, exactly as it was sent.', false, true)}
      {:else if loaded && !link}
        {@render terminal(Link2Off, 'muted', 'This claim link is incomplete', 'The part after # is missing or damaged. Open the full link from your email again.', false, true)}
      {:else if check === 'mismatch'}
        {@render terminal(Link2Off, 'error', 'This link cannot be claimed', describeError(new ClaimError('LINK_MISMATCH')), true, true)}
      {:else if check === 'unknown'}
        {@render terminal(SearchX, 'muted', 'This campaign does not exist', `There is no campaign ${campaign} on this contract. Ask the sender for your link again.`, false, true)}
      {:else if check === 'claimed'}
        {@render terminal(CheckCircle, 'success', 'Already claimed', 'The tokens for this link have been paid out.', false, false)}
      {:else if check === 'pending'}
        {@render terminal(Clock, 'muted', 'This claim is being paid', 'A claim for this link is in progress. Check again in a minute.', false, false)}
      {:else if check === 'ended'}
        {@render terminal(Clock, 'muted', 'This campaign has ended', `Claims closed on ${deadline}. Ask the sender about it.`, false, false)}
      {:else if check === 'error'}
        {@render terminal(AlertTriangle, 'error', 'Could not check this claim', `${checkError} Try again in a minute.`, true, false)}
      {:else if loaded && check === 'checking'}
        <div class="flex flex-col items-center gap-4 py-8">
          {@render medallion(Loader2, 'muted', true)}
          <p class="text-sm text-zen-fg-muted" role="status">Checking your claim…</p>
        </div>
      {:else if loaded}
        <!-- Header: medallion, the amount as the hero number, sender and deadline muted -->
        <div class="flex flex-col items-center text-center gap-3">
          {@render medallion(Mail, 'primary')}
          <h1 class="flex flex-col items-center gap-1">
            <span class="text-5xl font-bold tracking-tighter text-zen-fg tabular-nums">{formatAmount(BigInt(link!.amount))} USDC</span>
            <span class="text-base font-normal text-zen-fg-muted">is waiting for you</span>
          </h1>
          <p class="text-xs text-zen-fg-subtle leading-relaxed">
            From <span class="font-mono">{sender}</span><br />Claim by {deadline}
          </p>
          {#if network !== 'mainnet'}<ZenBadge size="sm">NEAR {network} · test funds, no value</ZenBadge>{/if}
        </div>

        <!-- Destination: one question, one switch, one field -->
        <div class="flex flex-col gap-3">
          <h2 id="dest-q" class="text-sm font-medium text-zen-fg">Where should it go?</h2>
          <div class="control-border grid grid-cols-2 gap-1 p-1 rounded-full" role="radiogroup" aria-labelledby="dest-q">
            {#each [['existing', 'NEAR account'], ['chain', 'Another chain']] as [value, text] (value)}
              <label
                class="flex items-center justify-center min-h-10 whitespace-nowrap text-sm font-medium rounded-full px-3 cursor-pointer transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-zen-fg
                  {mode === value ? 'bg-zen-fg text-zen-bg' : 'text-zen-fg-muted hover:text-zen-fg'}"
              >
                <input class="sr-only" type="radio" bind:group={mode} {value} />{text}
              </label>
            {/each}
          </div>
          {#if implicitEnabled}
            <label class="flex items-center gap-2 min-h-11 text-xs text-zen-fg-muted"><input type="radio" bind:group={mode} value="new" /> Create a NEAR account for me</label>
          {/if}

          {#if mode === 'chain'}
            <PayoutPicker {network} amount={link!.amount} refundTo={sender} bind:choice={payout} />
          {:else if mode === 'existing'}
            <ZenInput
              id="dest"
              class="control-border"
              aria-label="NEAR account"
              bind:value={typed}
              placeholder={network === 'mainnet' ? 'alice.near' : 'alice.testnet'}
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              aria-invalid={dest.kind === 'wrong' || acct?.state === 'missing'}
              aria-describedby="dest-note"
            />
            <div id="dest-note" class="text-xs flex flex-col gap-2 -mt-1 pl-1">
              {#if dest.kind === 'wrong'}
                <p class="text-zen-error" role="alert">{dest.reason}</p>
              {:else if acct?.state === 'checking'}
                <p class="text-zen-fg-subtle" role="status">Checking {acct.id}…</p>
              {:else if acct?.state === 'found'}
                <p class="flex items-center gap-1.5 text-zen-success" role="status"><Check class="w-3.5 h-3.5" aria-hidden="true" /><span class="font-mono">{acct.id}</span> found</p>
              {:else if acct?.state === 'missing' && dest.kind === 'named'}
                <p class="text-zen-error" role="alert">There is no NEAR account called {acct.id}. Check the spelling.</p>
              {:else if acct?.state === 'missing'}
                <label class="flex gap-2 items-start text-zen-fg-muted">
                  <input type="checkbox" bind:checked={unfundedAck} />
                  This account is not on chain yet. Only the holder of its private key can use these funds.
                </label>
              {:else if acct?.state === 'error'}
                <p class="text-zen-error" role="alert">Could not check this account right now. Try again in a minute.</p>
              {/if}
              {#if acct?.state !== 'found'}
                <p class="text-zen-fg-subtle">
                  No NEAR account? <a href="https://docs.near.org/getting-started/create-account" target="_blank" rel="noopener noreferrer">Create one</a>, then come back.
                </p>
              {/if}
            </div>
          {:else if !implicit}
            <ZenButton variant="secondary" class="rounded-full" onclick={create}>Create a NEAR account in this browser</ZenButton>
          {:else}
            <p class="text-sm">Your account: <code>{implicit.accountId}</code></p>
            <p class="text-sm"><strong>Save its key now.</strong> We never see it, and without it nobody can move these funds.</p>
            <div class="flex flex-wrap gap-2">
              <ZenButton variant="secondary" size="sm" class="rounded-full min-h-11" onclick={download}>Download key file</ZenButton>
              <ZenButton variant="secondary" size="sm" class="rounded-full min-h-11" onclick={copy}>Copy private key</ZenButton>
            </div>
            <label class="flex items-center gap-2 min-h-11 text-sm">
              <input type="checkbox" bind:checked={confirmed} disabled={!exported} />
              I saved the key somewhere safe
            </label>
          {/if}
        </div>

        <!-- Sign in: Google's own pill asset, centred -->
        <div class="flex flex-col items-center gap-3 pt-1">
          {#if busy}<p class="text-xs text-zen-fg-subtle" role="status">{busy}</p>{/if}
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
              You choose where the USDC goes, then sign in with Google. The sign-in only proves the email and is bound to
              this destination, so it cannot pay anyone else. We cannot access your Google account. The USDC usually
              arrives in about a minute.
            </p>
          </div>
        </details>
      {/if}

      {#if error}<p class="text-sm text-zen-error text-center" role="alert">{error}</p>{/if}
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
  .google img {
    width: 240px;
    height: auto;
  }
  .google:focus-visible {
    outline: 2px solid var(--zen-fg);
    outline-offset: 3px;
  }
</style>
