<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { env } from '$env/dynamic/public';
  import {
    classifyDestination, claimState, destinationNonce, googleAuthUrl, isCampaignId, isHex32, isValidAccountId, loadAttempt, newAttemptId,
    parseLinkFragment, saveAttempt, type LinkSecret,
  } from '$lib/claim';
  import { rootFromProof } from '$lib/merkle';
  import { accountExists, ClaimError, describeError, getCampaign, getClaimState } from '$lib/services';
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
  let mode = $state<'existing' | 'new'>('existing');
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
    !!link && check === 'ok' && isValidAccountId(destination) && (mode === 'existing' ? accountOk : exported && confirmed),
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
      const c = await getCampaign(env.PUBLIC_NEAR_RPC_URL, env.PUBLIC_CONTRACT_ID, campaign);
      if (!c) {
        check = 'unknown';
        return;
      }
      deadline = new Date(Number(BigInt(c.deadline_ns) / 1_000_000n)).toLocaleString();
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
    saveAttempt({ campaign, commitment, ...link!, destination, attemptId });
    location.href = googleAuthUrl({
      clientId,
      redirectUri: `${location.origin}/auth/google`,
      nonce: await destinationNonce(destination),
      state: claimState(campaign, commitment, attemptId),
    });
  }
</script>

{#if !linkOk}
  <h1>This claim link is broken</h1>
  <p class="muted">Open the link from your email again, exactly as it was sent.</p>
{:else if loaded && !link}
  <h1>This claim link is incomplete</h1>
  <p class="muted">The part after <code>#</code> is missing or damaged. Open the full link from your email again.</p>
{:else if check === 'mismatch'}
  <h1>This claim link does not match</h1>
  <p class="error" role="alert">{describeError(new ClaimError('LINK_MISMATCH'))}</p>
{:else if check === 'unknown'}
  <h1>This campaign does not exist</h1>
  <p class="muted">There is no campaign {campaign} on this contract. Ask the sender for your link again.</p>
{:else if check === 'claimed'}
  <h1>Already claimed</h1>
  <p class="muted">The tokens for this link have been paid out.</p>
{:else if check === 'pending'}
  <h1>This claim is being paid</h1>
  <p class="muted">A claim for this link is in progress. Check again in a minute.</p>
{:else if check === 'ended'}
  <h1>This campaign has ended</h1>
  <p class="muted">Claims closed on {deadline}. Ask the sender about it.</p>
{:else if check === 'error'}
  <h1>Could not check this claim</h1>
  <p class="error" role="alert">{deadline}. Try again in a minute.</p>
{:else if loaded && check === 'checking'}
  <p class="muted" role="status">Checking your claim…</p>
{:else if loaded}
  <h1><strong>{formatAmount(BigInt(link!.amount))} USDC</strong> is waiting for you</h1>
  <p class="muted">Claim by {deadline}.</p>

  <h2>Where should they go?</h2>
  {#if implicitEnabled}
    <p>
      <label><input type="radio" bind:group={mode} value="existing" /> I have a NEAR account</label><br />
      <label><input type="radio" bind:group={mode} value="new" /> Create one for me</label>
    </p>
  {/if}

  {#if mode === 'existing'}
    <label for="dest">NEAR account</label>
    <input
      id="dest"
      type="text"
      bind:value={typed}
      placeholder="alice.testnet"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      aria-invalid={dest.kind === 'wrong' || acct?.state === 'missing'}
      aria-describedby="dest-note"
    />
    <div id="dest-note">
      {#if dest.kind === 'wrong'}
        <p class="error" role="alert">{dest.reason}</p>
      {:else if acct?.state === 'checking'}
        <p class="muted" role="status">Checking <code>{acct.id}</code>…</p>
      {:else if acct?.state === 'found'}
        <p role="status">Account found: <code>{acct.id}</code></p>
      {:else if acct?.state === 'missing' && dest.kind === 'named'}
        <p class="error" role="alert">There is no NEAR account called <code>{acct.id}</code>. Check the spelling.</p>
      {:else if acct?.state === 'missing'}
        <label>
          <input type="checkbox" bind:checked={unfundedAck} />
          This account is not on chain yet. Only the holder of its private key can use these funds.
        </label>
      {:else if acct?.state === 'error'}
        <p class="error" role="alert">Could not check this account right now. Try again in a minute.</p>
      {/if}
      <p class="muted">
        Your account on NEAR testnet, like <code>alice.testnet</code>. No NEAR account yet?
        <a href="https://docs.near.org/getting-started/create-account" target="_blank" rel="noopener noreferrer">Create a free testnet account</a>
        (about a minute), then come back to this tab. Your claim stays open until the deadline.
      </p>
    </div>
  {:else if !implicit}
    <button onclick={create}>Create a NEAR account in this browser</button>
  {:else}
    <p>Your account: <code>{implicit.accountId}</code></p>
    <p><strong>Save its key now.</strong> We never see it, and without it nobody can move these funds.</p>
    <p>
      <button onclick={download}>Download key file</button>
      <button onclick={copy}>Copy private key</button>
    </p>
    <label>
      <input type="checkbox" bind:checked={confirmed} disabled={!exported} />
      I saved the key somewhere safe
    </label>
  {/if}

  {#if isValidAccountId(destination)}
    <p>Funds go to: <code>{destination}</code></p>
  {/if}
  <p class="muted">
    Our verifier sees your email to check it matches this claim. It is never put on chain. Your sign-in is bound to
    the account above, so it cannot be used to pay anyone else.
  </p>
  <button class="google" disabled={!ready} onclick={signIn}>
    <picture>
      <source srcset="/google/signin-dark.svg" media="(prefers-color-scheme: dark)" />
      <img src="/google/signin-light.svg" alt="Sign in with Google" width="180" height="40" />
    </picture>
  </button>
{/if}

{#if error}<p class="error" role="alert">{error}</p>{/if}

<style>
  /* Google's pre-approved asset, unchanged; the off state only lowers its opacity (branding guidelines). */
  .google {
    display: block;
    padding: 0;
    border: 0;
    background: none;
    line-height: 0;
    border-radius: 4px;
  }
  .google img {
    width: 240px;
    height: auto;
  }
</style>
