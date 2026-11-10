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
  import { Gift, ShieldCheck } from 'lucide-svelte';
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

{#snippet next(newLink: boolean)}
  {#if newLink}<p class="text-sm">Nothing was taken from you. Ask the sender for a new link.</p>{/if}
  <p class="text-sm"><a href="/">What is Zarf?</a></p>
{/snippet}

{#snippet terminal(title: string, line: string, alert: boolean, newLink: boolean)}
  <h1 class="text-2xl font-semibold tracking-tight">{title}</h1>
  <p class={alert ? 'text-sm text-zen-error' : 'text-sm text-zen-fg-muted'} role={alert ? 'alert' : undefined}>{line}</p>
  {@render next(newLink)}
{/snippet}

<div class="w-full max-w-md mx-auto px-4 py-8 sm:py-14">
  <ZenCard variant="glass" padding="lg" radius="3xl" class="!p-6 sm:!p-8">
    <div class="flex flex-col gap-6">
      {#if !linkOk}
        {@render terminal('This claim link is broken', 'Open the link from your email again, exactly as it was sent.', false, true)}
      {:else if loaded && !link}
        {@render terminal('This claim link is incomplete', 'The part after # is missing or damaged. Open the full link from your email again.', false, true)}
      {:else if check === 'mismatch'}
        {@render terminal('This claim link does not match', describeError(new ClaimError('LINK_MISMATCH')), true, true)}
      {:else if check === 'unknown'}
        {@render terminal('This campaign does not exist', `There is no campaign ${campaign} on this contract. Ask the sender for your link again.`, false, true)}
      {:else if check === 'claimed'}
        {@render terminal('Already claimed', 'The tokens for this link have been paid out.', false, false)}
      {:else if check === 'pending'}
        {@render terminal('This claim is being paid', 'A claim for this link is in progress. Check again in a minute.', false, false)}
      {:else if check === 'ended'}
        {@render terminal('This campaign has ended', `Claims closed on ${deadline}. Ask the sender about it.`, false, false)}
      {:else if check === 'error'}
        {@render terminal('Could not check this claim', `${deadline}. Try again in a minute.`, true, false)}
      {:else if loaded && check === 'checking'}
        <p class="text-sm text-zen-fg-muted" role="status">Checking your claim…</p>
      {:else if loaded}
        <!-- Header: medallion, the amount as the hero number, sender and deadline muted -->
        <div class="flex flex-col items-center text-center gap-3">
          <div class="w-12 h-12 rounded-full bg-zen-primary/10 text-zen-primary flex items-center justify-center shrink-0">
            <Gift class="w-6 h-6" />
          </div>
          <h1 class="flex flex-col items-center gap-1">
            <span class="text-5xl font-bold tracking-tighter text-zen-fg tabular-nums">{formatAmount(BigInt(link!.amount))} USDC</span>
            <span class="text-base font-normal text-zen-fg-muted">is waiting for you</span>
          </h1>
          <p class="text-xs text-zen-fg-subtle leading-relaxed">
            From <span class="font-mono">{sender}</span> · NEAR {network}{network === 'mainnet' ? '' : ', test funds'}<br />
            Claim by {deadline}
          </p>
        </div>

        <div class="h-px bg-zen-border-subtle"></div>

        <!-- Destination -->
        <div class="flex flex-col gap-3">
          <h2 class="text-xs font-bold uppercase tracking-widest opacity-40">Where should it go?</h2>
          <div class="grid grid-cols-2 gap-1 p-1 rounded-full bg-zen-fg/5" role="radiogroup" aria-label="Destination">
            <label class="text-center text-xs font-medium rounded-full px-3 py-2 cursor-pointer transition-colors {mode === 'existing' ? 'bg-zen-fg text-zen-bg' : 'text-zen-fg-muted hover:text-zen-fg'}">
              <input class="sr-only" type="radio" bind:group={mode} value="existing" /> My NEAR account
            </label>
            <label class="text-center text-xs font-medium rounded-full px-3 py-2 cursor-pointer transition-colors {mode === 'chain' ? 'bg-zen-fg text-zen-bg' : 'text-zen-fg-muted hover:text-zen-fg'}">
              <input class="sr-only" type="radio" bind:group={mode} value="chain" /> USDC on another chain
            </label>
          </div>
          {#if implicitEnabled}
            <label class="text-xs text-zen-fg-muted"><input type="radio" bind:group={mode} value="new" /> Create a NEAR account for me</label>
          {/if}

          {#if mode === 'chain'}
            <PayoutPicker {network} amount={link!.amount} refundTo={sender} bind:choice={payout} />
          {:else if mode === 'existing'}
            <ZenInput
              id="dest"
              label="NEAR account"
              bind:value={typed}
              placeholder="alice.testnet"
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              aria-invalid={dest.kind === 'wrong' || acct?.state === 'missing'}
              aria-describedby="dest-note"
            />
            <div id="dest-note" class="text-xs flex flex-col gap-2 -mt-1">
              {#if dest.kind === 'wrong'}
                <p class="text-zen-error" role="alert">{dest.reason}</p>
              {:else if acct?.state === 'checking'}
                <p class="text-zen-fg-subtle" role="status">Checking {acct.id}…</p>
              {:else if acct?.state === 'found'}
                <p class="text-zen-success" role="status">Account found: <span class="font-mono">{acct.id}</span></p>
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
              <p class="text-zen-fg-subtle">
                No NEAR account? <a href="https://docs.near.org/getting-started/create-account" target="_blank" rel="noopener noreferrer">Create one</a>, then come back.
              </p>
            </div>
          {:else if !implicit}
            <button class="legacy-btn" onclick={create}>Create a NEAR account in this browser</button>
          {:else}
            <p class="text-sm">Your account: <code>{implicit.accountId}</code></p>
            <p class="text-sm"><strong>Save its key now.</strong> We never see it, and without it nobody can move these funds.</p>
            <p class="flex gap-2">
              <button class="legacy-btn" onclick={download}>Download key file</button>
              <button class="legacy-btn" onclick={copy}>Copy private key</button>
            </p>
            <label class="text-sm">
              <input type="checkbox" bind:checked={confirmed} disabled={!exported} />
              I saved the key somewhere safe
            </label>
          {/if}
        </div>

        <!-- Sign in -->
        <div class="flex flex-col items-center gap-3">
          {#if mode === 'chain' && payout}
            <p class="text-xs text-zen-fg-muted text-center">Funds go to <span class="font-mono break-all">{payout.recipient}</span> on {payout.asset.chain.name}</p>
          {:else if mode !== 'chain' && isValidAccountId(destination)}
            <p class="text-xs text-zen-fg-muted text-center">Funds go to <span class="font-mono break-all">{destination}</span></p>
          {/if}
          {#if busy}<p class="text-xs text-zen-fg-subtle" role="status">{busy}</p>{/if}
          <button class="google" disabled={!ready} onclick={signIn}>
            <img src={themeStore.isDark ? '/google/signin-dark.svg' : '/google/signin-light.svg'} alt="Sign in with Google" width="180" height="40" />
          </button>
        </div>

        <!-- One honest line; the rest one layer down -->
        <div class="flex items-start gap-2 text-xs text-zen-fg-muted">
          <ShieldCheck class="w-4 h-4 shrink-0 mt-px" />
          <span>The email never goes on chain; our verifier sees it once to check the claim.</span>
        </div>
        <details class="text-xs text-zen-fg-subtle -mt-3">
          <summary class="cursor-pointer">How this works</summary>
          <p class="mt-2">
            You choose where the USDC goes, then sign in with Google. The sign-in only proves the email and is bound to
            this destination, so it cannot pay anyone else. We cannot access your Google account. The USDC usually
            arrives in about a minute.
          </p>
        </details>
      {/if}

      {#if error}<p class="text-sm text-zen-error" role="alert">{error}</p>{/if}
    </div>
  </ZenCard>
</div>

<style>
  /* Google's pre-approved asset, unchanged; the off state only lowers its opacity (branding guidelines). */
  .google {
    display: block;
    padding: 0;
    border: 0;
    background: none;
    line-height: 0;
    border-radius: 4px;
    cursor: pointer;
  }
  .google img {
    width: 240px;
    height: auto;
  }
  .legacy-btn {
    padding: 0.5rem 1rem;
    border-radius: 9999px;
    border: 0.5px solid var(--zen-border-strong);
    font-size: 0.875rem;
  }
</style>
