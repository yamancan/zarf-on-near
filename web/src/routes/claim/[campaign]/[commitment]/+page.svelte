<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { env } from '$env/dynamic/public';
  import {
    claimState, destinationNonce, googleAuthUrl, isCampaignId, isHex32, isValidAccountId, loadAttempt, newAttemptId,
    saltFromFragment, saveAttempt,
  } from '$lib/claim';
  import { describeError, getCampaign } from '$lib/services';
  import { createImplicitAccount, keyFile, type ImplicitAccount } from '$lib/implicit';

  const campaign = page.params.campaign!;
  const commitment = page.params.commitment!;
  const linkOk = isCampaignId(campaign) && isHex32(commitment);
  // Pending the owner's decision on gas for in-browser accounts; on unless PUBLIC_IMPLICIT_ACCOUNTS=off.
  const implicitEnabled = env.PUBLIC_IMPLICIT_ACCOUNTS !== 'off';

  let salt = $state<string | null>(null);
  let loaded = $state(false);
  let mode = $state<'existing' | 'new'>('existing');
  let typed = $state('');
  let implicit = $state<ImplicitAccount | null>(null);
  let exported = $state(false);
  let confirmed = $state(false);
  let error = $state('');
  let deadline = $state('loading…');

  const destination = $derived(mode === 'existing' ? typed.trim().toLowerCase() : (implicit?.accountId ?? ''));
  const ready = $derived(!!salt && isValidAccountId(destination) && (mode === 'existing' || (exported && confirmed)));

  onMount(() => {
    const prev = loadAttempt();
    salt = saltFromFragment(location.hash) ?? (prev?.campaign === campaign && prev.commitment === commitment ? prev.salt : null);
    // Keep the salt out of the address bar and synced history; this tab's sessionStorage holds it.
    if (location.hash) history.replaceState(history.state, '', location.pathname); // $app/navigation's replaceState throws before the router is up
    if (salt && linkOk) saveAttempt({ campaign, commitment, salt, destination: '', attemptId: '' });
    loaded = true;
    if (linkOk) loadDeadline();
  });

  async function loadDeadline() {
    try {
      const c = await getCampaign(env.PUBLIC_NEAR_RPC_URL, env.PUBLIC_CONTRACT_ID, campaign);
      deadline = c ? new Date(Number(BigInt(c.deadline_ns) / 1_000_000n)).toLocaleString() : 'this campaign does not exist';
    } catch (e) {
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
    saveAttempt({ campaign, commitment, salt: salt!, destination, attemptId });
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
{:else if loaded && !salt}
  <h1>This claim link is incomplete</h1>
  <p class="muted">The part after <code>#</code> is missing. Open the full link from your email again.</p>
{:else if loaded}
  <h1>Claim your tokens</h1>
  <p class="muted">Campaign {campaign}. Claim before: {deadline}</p>

  <h2>Where should they go?</h2>
  {#if implicitEnabled}
    <p>
      <label><input type="radio" bind:group={mode} value="existing" /> I have a NEAR account</label><br />
      <label><input type="radio" bind:group={mode} value="new" /> Create one for me</label>
    </p>
  {/if}

  {#if mode === 'existing'}
    <input
      type="text"
      bind:value={typed}
      placeholder="alice.testnet"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      aria-label="NEAR account"
    />
    {#if typed && !isValidAccountId(destination)}
      <p class="error">That is not a valid NEAR account name.</p>
    {/if}
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
  <button class="primary" disabled={!ready} onclick={signIn}>Continue with Google</button>
{/if}

{#if error}<p class="error" role="alert">{error}</p>{/if}
