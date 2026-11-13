<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { page } from '$app/state';
  import { env } from '$env/dynamic/public';
  import {
    INCOMPLETE_LINE, classifyDestination, confirmRemembered, isEthAccount, typedBefore, type Receipt, missingAccountLine, nearAccountReady, type AccountCheck, deadlineText, destinationNonce, googleAuthUrl, isCampaignId, isHex32, isValidAccountId, loadAttempt, loadReceipt,
    middle, newAttemptId, parseLinkFragment, saveAttempt, timeLeft, type LinkSecret,
  } from '$lib/claim';
  import { rootFromProof } from '$lib/merkle';
  import { accountExists, ClaimError, describeCheckError, describeError, getCampaign, getClaimState, getNetwork } from '$lib/services';
  import { crossChainOffered, getQuote, payoutCapError, QUOTE_LIFETIME_MS, withinLossBound, QuoteError, refusal, type PayoutAsset } from '$lib/intents';
  import PayoutPicker from '$lib/PayoutPicker.svelte';
  import { AlertTriangle, ArrowUpRight, CheckCircle2, ChevronDown, Clock, Link2Off, Loader2, Mail, SearchX, Wallet } from 'lucide-svelte';
  import ClaimCard from '$lib/ClaimCard.svelte';
  import { swapIn } from '$lib/motion';
  import ClaimRecord from '$lib/ClaimRecord.svelte';
  import { TESTNET, UNAUDITED_LINE, UNIT } from '$lib/network';
  import Medallion from '$lib/Medallion.svelte';
  import Note from '$lib/Note.svelte';
  import ZenButton from '$lib/zarf-kit/components/ui/ZenButton.svelte';
  import ZenCheckbox from '$lib/zarf-kit/components/ui/ZenCheckbox.svelte';
  import ZenCard from '$lib/zarf-kit/components/ui/ZenCard.svelte';
  import ZenInput from '$lib/zarf-kit/components/ui/ZenInput.svelte';
  import { themeStore } from '$lib/zarf-kit/stores/themeStore.svelte';
  import { formatAmount } from '$lib/create/recipients';
  import { createImplicitAccount, keyFile, type ImplicitAccount } from '$lib/implicit';
  import { createPasskeyAccount, passkeyOffered } from '$lib/passkey';
  import PasskeyAccount from '$lib/PasskeyAccount.svelte';

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
  // true: derived from a passkey's PRF (Face ID unlocks it again); false: that device gave no PRF, so a random key; null: key-file account.
  let passkeyPrf = $state<boolean | null>(null);
  // The chain's network once the link is checked; before that (a recalled claim never checks it) the contract id's, as the receipt does.
  const passkeyOn = $derived(passkeyOffered(network || (TESTNET ? 'testnet' : ''), env.PUBLIC_IMPLICIT_ACCOUNTS, env.PUBLIC_PASSKEY_ACCOUNTS));
  let exported = $state(false);
  let confirmed = $state(false);
  let error = $state('');
  let deadline = $state('loading…');
  let left = $state('');
  let checkError = $state('');
  // A claim this browser finished earlier (receipt page): lets "Already claimed" show what was paid.
  const paid = loadReceipt(env.PUBLIC_CONTRACT_ID ?? '', campaign, commitment);
  // Back after "Arrived" (the address has no secret part any more): the remembered claim, once the chain confirms it.
  let recalled = $state<Receipt | null>(null);
  let recalling = $state(false);
  // Blue-team gap 3: "NEAR Account · Face ID · Other Chain", in that order.
  const MODES = $derived([
    ['existing', 'NEAR Account'],
    ...(implicitEnabled ? [['new', passkeyOn ? 'Face ID' : 'New Account']] : []),
    ...(crossChainOffered(network, env.PUBLIC_CROSS_CHAIN) ? [['chain', 'Other Chain']] : []), // testnet: a live mainnet price, "Mainnet Only"; mainnet: behind a flag
  ] as [typeof mode, string][]);
  // Face ID is a phone gesture: preselect it on touch screens until the person picks a choice themselves.
  let modePicked = false;
  $effect(() => {
    if (!modePicked && passkeyOn && mode === 'existing' && matchMedia('(pointer: coarse)').matches) mode = 'new';
  });
  const pick = (m: typeof mode) => ((modePicked = true), (mode = m));
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
  // One line under the field (design spec 3.1 item 4); the found and confirm states render below it.
  const destError = $derived(
    dest.kind === 'wrong'
      ? dest.reason
      : acct?.id === destination && acct.state === 'missing'
        ? missingAccountLine(dest)
        : acct?.id === destination && acct.state === 'error'
          ? "Couldn't check. Retry in a minute."
          : null,
  );
  // Radiogroup keys on the pills: arrows move the choice and the focus, as native radios do.
  function backToField() {
    guideOpen = false;
    document.getElementById('dest')?.focus();
  }
  const ready = $derived(
    !!link && check === 'ok' && !busy &&
      (mode === 'chain' ? !!payout : isValidAccountId(destination) && (mode === 'existing' ? accountOk : passkeyPrf === true || (exported && confirmed))),
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
    if (link && linkOk) {
      typed = typedBefore(prev, campaign, commitment); // "Back to Claim" after a failed sign-in keeps the account
      saveAttempt({ campaign, commitment, ...link, destination: '', attemptId: '' });
    }
    if (!link && linkOk && paid) {
      recalling = true;
      confirmRemembered(paid, () => getClaimState(env.PUBLIC_NEAR_RPC_URL, env.PUBLIC_CONTRACT_ID, campaign, commitment))
        .then((r) => (recalled = r))
        .catch(() => {}) // a failed read leaves the incomplete-link card, which still says what to do
        .finally(() => (recalling = false));
    }
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
      passkeyPrf = null;
    } catch {
      error = 'This browser cannot create a NEAR key. Use an existing account instead.';
    }
  }

  async function createWithPasskey() {
    error = '';
    try {
      const r = await createPasskeyAccount();
      implicit = r.account;
      passkeyPrf = r.prf;
      exported = confirmed = false;
    } catch {
      error = 'Face ID was cancelled or is not available in this browser. Try again, or save a key file instead.';
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
    saveAttempt({ campaign, commitment, ...link!, destination: to, attemptId, intents, ...(mode === 'new' && passkeyPrf ? { passkey: true as const } : {}) });
    location.href = googleAuthUrl({
      clientId,
      redirectUri: `${location.origin}/auth/google`,
      nonce: await destinationNonce(to),
      state: attemptId, // the id alone; campaign and commitment stay in this tab (red team #5)
    });
  }
</script>

<svelte:head><title>Claim Your USDC · Zarf</title></svelte:head>

<!-- Terminal states: the main claim app's LoginPrompt anatomy (64 px medallion, bold title, one line, one button) -->
{#snippet terminal(Icon: typeof Mail, tone: 'success' | 'error' | 'muted', title: string, line: string, action: 'home' | 'recheck' | 'none')}
  <div class="flex flex-col items-center text-center space-y-6 py-2" in:swapIn>
    <Medallion icon={Icon} {tone} />
    <div class="space-y-2">
      <h1 class="text-xl font-bold text-zen-fg">{title}</h1>
      <p class="text-sm text-zen-fg-muted leading-relaxed max-w-xs" role={tone === 'error' ? 'alert' : undefined}>{line}</p>
    </div>
    {#if action === 'recheck'}
      <ZenButton variant="primary" class="w-full sm:w-auto" onclick={() => link && checkLink(link)}>Check Again</ZenButton>
    {:else if action === 'home'}
      <a href="/" class="inline-block"><ZenButton tabindex={-1} variant="secondary">What Is Zarf?</ZenButton></a>
    {/if}
  </div>
{/snippet}

{#snippet faceIdDetails(made: boolean)}
  <details class="group text-xs text-zen-fg-subtle">
    <summary class="inline-flex items-center gap-1.5 py-1 cursor-pointer list-none hover:text-zen-fg">Details <ChevronDown class="w-3.5 h-3.5 transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
    <div class="flex flex-col items-start gap-2 pt-1 leading-relaxed">
      <p>The wallet's key is never stored, here or with us. Face ID unlocks it on any device that syncs your passkeys. Lose both the passkey and a backup key, and the funds are gone.</p>
      {#if made}
        <ZenButton variant="ghost" size="sm" onclick={download}>{exported ? 'Backup Key Saved' : 'Download Backup Key'}</ZenButton>
      {:else}
        <ZenButton variant="ghost" size="sm" onclick={create}>Use a Key File Instead</ZenButton>
      {/if}
    </div>
  </details>
{/snippet}

<!-- Zarf claim app frame: AppShell container (apps/claim/src/routes/+layout.svelte: w-full max-w-7xl mx-auto p-8 lg:p-12),
     the page column (apps/claim/src/routes/+page.svelte: max-w-5xl w-full px-4 md:px-0), then the card as LoginPrompt.svelte
     lays it out (section pt-8, max-w-lg mx-auto, ZenCard elevated, p-8; p-6 on phones for the form). No page header: the
     card's own title is the one header (T-023 waste list item 5). -->
<!-- Phones: p-4 shell, no column inset, p-4 card (blue-team gap 2, accepted by main as a departure from the kit's p-8) -->
<div class="w-full max-w-7xl mx-auto p-4 sm:p-8 lg:p-12">
  <div class="h-full flex flex-col relative max-w-5xl w-full sm:px-4 md:px-0">
    <section class="w-full pt-8">
      <div class="max-w-lg mx-auto">
  <ZenCard variant="elevated" class="overflow-hidden">
    <div class="p-4 sm:p-8">
    {#if !linkOk}
      {@render terminal(Link2Off, 'muted', 'Broken Link', 'Open the full link from your message.', 'home')}
    {:else if loaded && !link && recalled}
      <div class="flex flex-col items-center text-center gap-4 py-2" in:swapIn>
        <ClaimRecord r={recalled} amount={recalled.amount} contract={env.PUBLIC_CONTRACT_ID ?? ''} {campaign} {commitment} />
        {#if passkeyOn}<PasskeyAccount label="Claimed with Face ID? Open Your Account" />{/if}
      </div>
    {:else if loaded && !link && !recalling}
      {@render terminal(Link2Off, 'muted', 'Incomplete Link', INCOMPLETE_LINE, 'home')}
    {:else if check === 'mismatch'}
      {@render terminal(Link2Off, 'error', 'Link Not Valid', describeError(new ClaimError('LINK_MISMATCH')), 'home')}
    {:else if check === 'unknown'}
      {@render terminal(SearchX, 'muted', 'Campaign Not Found', 'Ask the sender for your link again.', 'home')}
    {:else if check === 'claimed'}
      <div class="flex flex-col items-center text-center gap-4 py-2" in:swapIn>
        <ClaimRecord r={paid} amount={link!.amount} title="Already Claimed" contract={env.PUBLIC_CONTRACT_ID ?? ''} {campaign} {commitment} />
        {#if passkeyOn}<PasskeyAccount label="Claimed with Face ID? Open Your Account" />{/if}
      </div>
    {:else if check === 'pending'}
      {@render terminal(Clock, 'muted', 'Payment in Progress', 'It usually settles within a minute.', 'recheck')}
    {:else if check === 'ended'}
      {@render terminal(Clock, 'muted', 'Campaign Ended', `Claims closed on ${deadline}. Ask the sender.`, 'home')}
    {:else if check === 'error'}
      {@render terminal(AlertTriangle, 'error', "Couldn't Check Claim", checkError, 'recheck')}
    {:else if loaded && check === 'checking'}
      <div class="flex flex-col items-center text-center space-y-6 py-2">
        <Medallion icon={Loader2} tone="muted" spin />
        <div class="space-y-2">
          <h1 class="text-xl font-bold text-zen-fg">Checking Claim…</h1>
          <p class="text-sm text-zen-fg-muted" role="status">Reading this link's campaign on NEAR.</p>
        </div>
      </div>
    {:else if loaded}
      <div in:swapIn>
        <ClaimCard
          title={network === 'mainnet' ? 'Claim Your USDC' : 'Claim Your Test USDC'}
          {sender}
          {left}
          {deadline}
          amount={formatAmount(BigInt(link!.amount))}
          unit={UNIT}
          modes={MODES}
          {mode}
          onpick={pick}
          {ready}
          mainnetOnly={mode === 'chain' && network !== 'mainnet'}
          onsignin={signIn}
        >
          {#snippet body()}
          {#if mode === 'chain'}
            <PayoutPicker {network} amount={link!.amount} refundTo={sender} {requote} onUseNear={() => ((error = ''), pick('existing'))} bind:choice={payout} />
          {:else if mode === 'existing'}
            <!-- No visible label: the selected "NEAR Account" pill above names the field -->
            <ZenInput
              id="dest"
              aria-label="NEAR account"
              bind:value={typed}
              placeholder={network === 'mainnet' ? 'alice.near' : 'alice.testnet'}
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              error={destError}
            />
            <div id="dest-note" class="flex flex-col gap-3">
              {#if acct?.state === 'checking'}
                <Note tone="pending">Checking <span class="font-mono">{acct.id}</span>…</Note>
              {:else if acct?.state === 'found'}
                <p class="flex items-center gap-2 text-sm text-zen-fg" role="status">
                  <!-- The name is in the field above; this row only says it was found (T-023 waste list item 6) -->
                  <CheckCircle2 class="w-4 h-4 text-zen-success shrink-0" aria-hidden="true" /><span>Account found</span>
                </p>
              {:else if acct?.state === 'missing' && dest.kind === 'implicit' && !isEthAccount(dest.id)}
                <ZenCheckbox bind:checked={unfundedAck} label="Only the holder of its private key can use these funds. I hold it." />
              {/if}
              {#if askConfirm || accountOk}
                <!-- Wrong-address guard before Google (a paid claim cannot be undone): one checkbox line, so Google stays
                     the only primary button (blue-team gap 12). Ticked for this exact id; any edit asks again. -->
                <div id="confirm" class="pt-4 border-t border-zen-border-subtle">
                  <ZenCheckbox
                    checked={confirmedFor === destination}
                    onchange={(e: Event) => (confirmedFor = (e.currentTarget as HTMLInputElement).checked ? destination : '')}
                    label="This is my account. The USDC cannot be taken back."
                  />
                </div>
              {/if}
              {#if acct?.state !== 'found' && !(dest.kind === 'implicit' && !isEthAccount(dest.id) && acct?.state === 'missing')}
                <div class="flex flex-wrap items-center gap-2">
                  <ZenButton variant="tonal" size="xs" onclick={useWallet} disabled={walletNote === 'Opening your wallet…'}>
                    {#snippet iconLeft()}<Wallet class="w-3.5 h-3.5" />{/snippet}Use My Wallet
                  </ZenButton>
                  {#if passkeyOn}
                    <!-- No account yet: a Face ID wallet, in this page (blue-team gap 3), not a trip to another wallet -->
                    <ZenButton variant="ghost" size="xs" onclick={() => pick('new')}>Use Face ID Instead</ZenButton>
                  {:else}
                    <!-- No account yet: Meteor in a new tab, three steps here; this tab keeps the claim (T-002) -->
                    <ZenButton variant="ghost" size="xs" onclick={() => ((guideOpen = true), window.open(METEOR, '_blank', 'noopener,noreferrer'))}>
                      Get a NEAR Account
                      {#snippet iconRight()}<ArrowUpRight class="w-3.5 h-3.5" />{/snippet}
                    </ZenButton>
                  {/if}
                </div>
                {#if walletNote && walletNote !== 'Opening your wallet…'}<p class="text-xs text-zen-error">{walletNote}</p>{/if}
                {#if guideOpen}
                  <ol id="guide" class="flex flex-col gap-1 text-xs text-zen-fg-muted list-decimal pl-5 marker:text-zen-fg-subtle">
                    <li>Create a wallet in Meteor{network === 'mainnet' ? '' : ', on Testnet'}.</li>
                    <li>Pick a name, like <span class="font-mono">{network === 'mainnet' ? 'alice.near' : 'alice.testnet'}</span>.</li>
                    <li>Copy it, come back and <button type="button" class="underline underline-offset-2 hover:text-zen-fg" onclick={backToField}>paste it above</button>.</li>
                  </ol>
                {/if}
              {/if}
            </div>
          {:else if !implicit && passkeyOn}
            <!-- Face ID: one line, one button; the risk and the key-file way sit under Details (blue-team gap 3) -->
            <p class="text-sm text-zen-fg-muted">A new wallet that your Face ID unlocks.</p>
            <ZenButton variant="secondary" class="self-start" onclick={createWithPasskey}>Create With Face ID</ZenButton>
            {@render faceIdDetails(false)}
          {:else if !implicit}
            <p class="text-sm text-zen-fg-muted">We create a NEAR account in this browser. Only you get its key.</p>
            <ZenButton variant="secondary" class="self-center" onclick={create}>Create NEAR Account</ZenButton>
          {:else if passkeyPrf}
            <p class="flex items-center gap-2 text-sm text-zen-fg" role="status">
              <CheckCircle2 class="w-4 h-4 text-zen-success shrink-0" aria-hidden="true" />Wallet <span class="font-mono" title={implicit.accountId}>{middle(implicit.accountId, 4)}</span> ready
            </p>
            <p class="text-sm text-zen-fg-muted">Unlocks with Face ID on your devices.</p>
            {@render faceIdDetails(true)}
          {:else}
            <p class="text-sm text-zen-fg-muted">Your new account <span class="font-mono text-zen-fg" title={implicit.accountId}>{middle(implicit.accountId, 8)}</span></p>
            {#if passkeyPrf === false}<Note tone="info">This device could not tie the account to Face ID, so it uses a key file instead.</Note>{/if}
            <Note tone="info">Save its key now. Without it nobody can move these funds, and we never see it.</Note>
            <ZenButton variant="secondary" class="self-start" onclick={download}>Download Key</ZenButton>
            <ZenCheckbox bind:checked={confirmed} disabled={!exported} label="I saved the key somewhere safe" />
          {/if}
          {/snippet}
          {#snippet footer()}
          {#if busy}<Note tone="pending">{busy}</Note>{/if}
          <p class="text-xs text-zen-fg-subtle text-center">Use the email this link was sent to.</p>
          <!-- T-001: the unaudited note stays visible on mainnet -->
          {#if network === 'mainnet'}<p class="text-xs text-zen-fg-subtle text-center">{UNAUDITED_LINE}</p>{/if}
          {#if error}<Note tone="error" center>{error}</Note>{/if}
          {#if quoteFailed && mode === 'chain'}
            <div class="flex flex-wrap justify-center gap-2">
              <ZenButton variant="secondary" size="sm" onclick={() => ((error = ''), (quoteFailed = false), (requote += 1))}>Get New Quote</ZenButton>
              <ZenButton variant="ghost" size="sm" onclick={() => ((error = ''), pick('existing'))}>Claim to a NEAR Account</ZenButton>
            </div>
          {/if}
          {/snippet}
        </ClaimCard>
      </div>
    {/if}
    </div>
  </ZenCard>
      </div>
    </section>
  </div>
</div>
