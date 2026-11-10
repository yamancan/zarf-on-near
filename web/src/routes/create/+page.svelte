<script lang="ts">
  import { onMount } from 'svelte';
  import { env } from '$env/dynamic/public';
  import { buildDraft, claimLink, LONG_LINKS_ABOVE, mailtoHref, recoveryFile, type Draft } from '$lib/create/campaign';
  import { getCampaignByRoot, getCampaignView, getConfig, getPrepayBalance, getStorageCosts, txOutcome, type ContractConfig } from '$lib/create/chain';
  import {
    checkCreation, fundCampaign, LookupPending, mayCreate, minDeadlineMs, NotCreated, NotSent, OutcomeUnclear, readMarker, resolveByRoot,
    settleAfterUncertain, type UnresolvedMarker,
  } from '$lib/create/funding';
  import { saveFile } from '$lib/create/publish';
  import { formatAmount, parseRecipients } from '$lib/create/recipients';
  import { myNearWallet, type SenderWallet } from '$lib/create/wallet';
  import { ArrowRight, Check, ChevronDown, Mail } from 'lucide-svelte';
  import ZenButton from '$lib/zen/components/ZenButton.svelte';
  import ZenCard from '$lib/zen/components/ZenCard.svelte';

  const rpc = env.PUBLIC_NEAR_RPC_URL;
  const contract = env.PUBLIC_CONTRACT_ID;
  const token = env.PUBLIC_TOKEN_ID;

  let csv = $state('');
  const parsed = $derived(parseRecipients(csv));
  let config = $state<ContractConfig | null>(null);
  let setupError = $state('');
  let deadline = $state(''); // datetime-local, the sender's time zone
  let wallet: SenderWallet | null = null;
  let walletReady = $state(false); // the wallet module loads after the config; Connect waits for it
  let account = $state<string | null>(null);
  let draft = $state<Draft | null>(null);
  let recoverySaved = $state(false);
  let recoveryAck = $state(false);
  let busy = $state('');
  let error = $state('');
  let result = $state<{ campaignId: string; txHash: string } | null>(null);
  let copied = $state(false);
  // A funding tx that was sent: while set, Create stays off until its outcome is known.
  let sentTx = $state<string | null>(null);
  let txState = $state<'checking' | 'settling' | 'unclear' | 'mismatch' | null>(null);
  // Once a send may have gone out, this draft (its merkle_root) is pinned: re-sending the same root is
  // safe (E132 refunds a duplicate), a new draft is not. Unpinned only by a campaign or a proven refund.
  let pinned = $state(false);
  let hadUncertain = false;
  // Other tabs: an unresolved send there means a new draft here could fund twice.
  const MARKER_KEY = 'zarf-near:unresolved';
  let otherTab = $state<UnresolvedMarker | null>(null);
  let otherTabNote = $state('');
  const setMarker = (m: UnresolvedMarker | null) => {
    try {
      if (m) localStorage.setItem(MARKER_KEY, JSON.stringify(m));
      else localStorage.removeItem(MARKER_KEY);
    } catch {
      // best effort: this tab's own pin still holds
    }
  };
  let sentFrom = $state<string | null>(null); // the sender of sentTx (the tx lookup needs it)
  /** Pinned to a sender: only that account may send this draft (a second account would fund it twice). */
  const sendable = $derived(mayCreate({ pinned, sentFrom, account }));
  // Display only (Create itself goes through mayCreate): pinned to someone else, or to nobody connected.
  const wrongAccount = $derived(pinned && !!sentFrom && account !== sentFrom);

  const FUNDING_KEY = 'zarf-near:create-funding';
  interface Funding {
    txHash: string | null; // null: the wallet was asked but no hash came back (yet)
    sender: string;
    draft: Draft;
    deadline: string;
    campaignId?: string;
    uncertain?: boolean; // a send whose outcome was lost happened for this draft
  }
  /** True if persisted. Before a send it must succeed (see beforeSend); later writes are best effort. */
  const saveFunding = (f: Funding): boolean => {
    try {
      sessionStorage.setItem(FUNDING_KEY, JSON.stringify(f));
      return true;
    } catch {
      return false;
    }
  };
  const loadFunding = (): Funding | null => {
    try {
      return JSON.parse(sessionStorage.getItem(FUNDING_KEY) ?? 'null');
    } catch {
      return null;
    }
  };
  const clearFunding = () => {
    try {
      sessionStorage.removeItem(FUNDING_KEY);
    } catch {
      // nothing to clear
    }
  };

  const toLocalInput = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const minMs = $derived(config ? minDeadlineMs(Date.now(), config.min_lifetime_ns) : null);
  const deadlineMs = $derived(deadline ? new Date(deadline).getTime() : NaN);
  const deadlineOk = $derived(minMs !== null && Number.isFinite(deadlineMs) && deadlineMs > minMs);
  const ready = $derived(parsed.rows.length > 0 && parsed.rejected.length === 0 && deadlineOk && !!account);
  const claimOrigin = env.PUBLIC_CLAIM_ORIGIN || (typeof location === 'undefined' ? '' : location.origin);
  const linkRows = $derived(
    result && draft ? draft.recipients.map((r) => ({ r, link: claimLink(claimOrigin, result!.campaignId, r) })) : [],
  );
  const links = $derived(linkRows.map(({ r, link }) => `${r.email},${formatAmount(BigInt(r.amount))},${link}`));
  let copiedRow = $state(-1);

  onMount(async () => {
    if (!rpc || !contract || !token) {
      setupError = 'This site is not fully set up yet (PUBLIC_NEAR_RPC_URL, PUBLIC_CONTRACT_ID, PUBLIC_TOKEN_ID).';
      return;
    }
    try {
      config = await getConfig(rpc, contract);
      if (!config.token_ids.includes(token)) setupError = `${token} is not accepted by this contract.`;
      deadline = toLocalInput(Math.max(Date.now() + 7 * 86_400_000, minDeadlineMs(Date.now(), config.min_lifetime_ns) + 3_600_000));
      wallet = await myNearWallet(config.network, rpc);
      walletReady = true;
      account = wallet.accountId();
      // A funding tx from before a reload: resume checking it instead of offering Create again.
      const f = loadFunding();
      if (!f) {
        try {
          otherTab = readMarker(localStorage, MARKER_KEY, Date.now());
        } catch {
          otherTab = null;
        }
      }
      if (f) {
        draft = f.draft;
        deadline = f.deadline;
        recoverySaved = recoveryAck = true;
        sentFrom = f.sender;
        pinned = true;
        hadUncertain = !!f.uncertain;
        if (f.campaignId) result = { campaignId: f.campaignId, txHash: f.txHash ?? '' };
        else if (f.txHash) await check(f.txHash);
        else await checkByRoot(); // reloaded while the wallet popup was open
      }
    } catch {
      setupError = 'Could not read the contract. Try again in a minute.';
    }
  });

  async function connect() {
    error = '';
    try {
      account = await wallet!.signIn();
    } catch (e) {
      error = `Wallet: ${(e as Error).message}`;
    }
  }

  async function disconnect() {
    await wallet!.signOut();
    account = null;
  }

  async function prepare() {
    error = '';
    draft = await buildDraft(parsed.rows);
    recoverySaved = recoveryAck = false;
  }

  function saveRecovery() {
    const ctx = { contractId: contract!, network: config!.network, claimOrigin };
    saveFile(`zarf-recovery-${draft!.merkleRoot.slice(0, 8)}.json`, recoveryFile(draft!, (BigInt(deadlineMs) * 1_000_000n).toString(), ctx));
    recoverySaved = true;
  }

  const ERRORS: Record<string, string> = {
    E119_INVALID_DEADLINE: 'The deadline is too early for this contract. Pick a later one.',
    E126_UNKNOWN_TOKEN: 'The contract does not accept this token.',
    E127_NO_VERIFIER: 'The contract has no verifier key that covers this deadline.',
    E128_INSUFFICIENT_STORAGE: 'The storage pre-pay was too low twice in a row. Your tokens were refunded; try again.',
  };

  const lookup = { outcome: (hash: string) => txOutcome(rpc!, hash, sentFrom ?? account!), contractId: contract!, tokenId: token! };

  async function created(r: { campaignId: string; txHash: string }) {
    result = r;
    txState = null;
    setMarker(null);
    saveFunding({ txHash: r.txHash, sender: sentFrom ?? account!, draft: draft!, deadline, campaignId: r.campaignId });
  }

  const byRoot = () => ({
    sender: sentFrom ?? account!,
    campaignByRoot: (sender: string, root: string) => getCampaignByRoot(rpc!, contract!, sender, root),
    campaign: (id: string) => getCampaignView(rpc!, contract!, id),
  });

  /**
   * The wallet failed or the page reloaded before a hash came back: the tx may have landed anyway.
   * The draft's merkle_root is an idempotency key, so ask the contract. Never assume nothing was sent.
   */
  async function checkByRoot() {
    txState = 'checking';
    busy = 'Checking whether the campaign exists…';
    try {
      const id = await resolveByRoot(byRoot(), { merkleRoot: draft!.merkleRoot, total: draft!.total });
      if (id) {
        await created({ campaignId: id, txHash: sentTx ?? '' });
      } else {
        // Not landed (yet). Keep the draft pinned: only the same root may be sent again.
        sentTx = txState = null;
        error =
          'Your wallet did not confirm, and no campaign exists for these links yet. You can send the same campaign ' +
          'again: if the earlier transaction still lands, the contract refunds the duplicate. These links stay as they are.';
      }
    } catch (e) {
      // A campaign under our (sender, root) that does not match is terminal; an unreadable contract is not.
      txState = (e as Error).message === 'CAMPAIGN_MISMATCH' ? 'mismatch' : 'checking';
    } finally {
      busy = '';
    }
  }

  const recheck = () => (sentTx ? check(sentTx) : checkByRoot());

  function failed(e: unknown) {
    if (e instanceof LookupPending) {
      txState = 'checking'; // sent, outcome unknown: Create stays off
    } else if (e instanceof OutcomeUnclear) {
      txState = 'unclear';
    } else if (e instanceof NotSent) {
      error = 'This browser would not store the campaign before sending, so nothing was sent. Allow site storage and try again.';
    } else if (e instanceof NotCreated) {
      // Proven for this tx: the tokens are back (or never left).
      const msg = ERRORS[e.code] ?? `The campaign was not created (${e.code}). Your tokens were returned.`;
      if (hadUncertain) void unpinAfterSecondLook(msg);
      else unpin(msg);
    } else if (sentTx) {
      txState = 'checking';
    } else {
      // SendUncertain or any other failure without a hash: remember it, then ask the contract.
      hadUncertain = true;
      if (draft && sentFrom) saveFunding({ txHash: null, sender: sentFrom, draft, deadline, uncertain: true });
      void checkByRoot();
    }
  }

  function unpin(msg: string) {
    sentTx = txState = null;
    pinned = hadUncertain = false;
    clearFunding();
    setMarker(null);
    error = msg;
  }

  /** An earlier send's outcome was lost, so it may still land: look by root once more before unpinning. */
  async function unpinAfterSecondLook(msg: string) {
    txState = 'settling'; // its own state: create()'s finally clears `busy` while this runs
    try {
      const id = await settleAfterUncertain(byRoot(), { merkleRoot: draft!.merkleRoot, total: draft!.total });
      if (id) await created({ campaignId: id, txHash: sentTx ?? '' });
      else unpin(msg);
    } catch (e) {
      txState = (e as Error).message === 'CAMPAIGN_MISMATCH' ? 'mismatch' : 'checking';
    }
  }

  /** Looks up a funding tx that was already sent. Never sends anything. */
  async function check(txHash: string) {
    sentTx = txHash;
    txState = 'checking';
    busy = 'Checking the transaction…';
    try {
      const c = await checkCreation(lookup, txHash, { merkleRoot: draft!.merkleRoot, total: draft!.total });
      if (c.kind === 'created') await created(c);
      else if (c.kind === 'refunded') failed(new NotCreated(c.code, txHash));
      else txState = 'unclear';
    } catch (e) {
      failed(e);
    } finally {
      busy = '';
    }
  }

  async function create() {
    error = '';
    if (!sendable.ok) {
      error = sendable.reason;
      return;
    }
    busy = 'Waiting for your wallet…';
    try {
      const d = draft!;
      await created(
        await fundCampaign(
          {
            sender: account!, contractId: contract!, tokenId: token!, storageByteCost: config!.storage_byte_cost,
            costs: () => getStorageCosts(rpc!, contract!, token!),
            freePrepay: () => getPrepayBalance(rpc!, contract!, account!),
            send: (txs) => wallet!.send(txs),
            campaignByRoot: byRoot().campaignByRoot,
            campaign: byRoot().campaign,
            beforeSend: () => {
              if (!saveFunding({ txHash: null, sender: account!, draft: d, deadline, uncertain: hadUncertain })) throw new Error('session storage unavailable');
              sentFrom = account;
              pinned = true;
              setMarker({ root: d.merkleRoot, sender: account!, total: d.total, at: Date.now() });
            },
            onSent: (txHash) => {
              sentTx = txHash;
              sentFrom = account;
              busy = 'Checking the transaction…';
              saveFunding({ txHash, sender: account!, draft: d, deadline });
            },
            outcome: lookup.outcome,
          },
          { merkleRoot: d.merkleRoot, deadlineNs: (BigInt(deadlineMs) * 1_000_000n).toString(), leafCount: d.recipients.length, total: d.total },
        ),
      );
    } catch (e) {
      failed(e);
    } finally {
      busy = '';
    }
  }

  /** "Check it" for another tab's unresolved send: clear the marker once its (sender, root) has a campaign. */
  async function checkOtherTab() {
    const m = otherTab!;
    otherTabNote = 'Checking…';
    try {
      const id = await resolveByRoot(
        { sender: m.sender, campaignByRoot: (s, r) => getCampaignByRoot(rpc!, contract!, s, r), campaign: (i) => getCampaignView(rpc!, contract!, i) },
        { merkleRoot: m.root, total: m.total },
      );
      if (id) {
        setMarker(null);
        otherTab = null;
        otherTabNote = `That campaign was created (campaign ${id}). You can start a new one here.`;
      } else {
        otherTabNote = 'It has not been created yet. Finish it in its tab, or wait and check again.';
      }
    } catch {
      otherTabNote = 'Could not check right now. Try again in a minute.';
    }
  }

  /** After a finished (or mismatched) campaign: forget it in this tab and begin a new draft. */
  function startOver() {
    clearFunding();
    setMarker(null);
    draft = result = null;
    sentTx = sentFrom = txState = null;
    pinned = recoverySaved = recoveryAck = copied = false;
    csv = error = '';
  }

  // Wizard: the first three steps are local; Send and the links follow the draft and the result.
  const STEPS = ['Recipients', 'Deadline', 'Wallet', 'Send'];
  const QUESTIONS = ['Who gets it?', 'Until when can they claim?', 'Which wallet pays?', 'Review and send'];
  let uiStep = $state(0);
  const step = $derived(result && draft ? 4 : draft ? 3 : uiStep);
  const recipientsOk = $derived(parsed.rows.length > 0 && parsed.rejected.length === 0);
  let stepHeading = $state<HTMLElement | null>(null);
  let lastStep = -1;
  $effect(() => {
    const s = step;
    // A step the user moved to (focus was on a control) puts focus on its heading; a restored one does not.
    const fromUser = typeof document !== 'undefined' && document.activeElement !== document.body;
    if (lastStep !== -1 && lastStep !== s && fromUser) stepHeading?.focus();
    lastStep = s;
  });
  const previewAmount = $derived(parsed.rows[0] ? formatAmount(BigInt(parsed.rows[0].amount)) : '10');
  const previewDeadline = $derived(
    Number.isFinite(deadlineMs) ? new Date(deadlineMs).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '',
  );

  async function copyAll() {
    await navigator.clipboard.writeText(links.join('\n'));
    copied = true;
  }

  async function copyOne(i: number) {
    await navigator.clipboard.writeText(linkRows[i].link);
    copiedRow = i;
  }
</script>

<svelte:head><title>Send USDC · Zarf</title></svelte:head>

{#snippet walletBlock()}
  {#if pinned && !wrongAccount}
    <p class="text-sm text-zen-fg-muted">Sending from <span class="font-mono text-zen-fg">{account}</span>. This campaign is tied to this account until it resolves.</p>
  {:else}
    {#if wrongAccount}
      <p class="text-sm text-zen-error" role="alert">This draft belongs to <code>{sentFrom}</code>: reconnect {sentFrom} to continue.</p>
    {/if}
    {#if account}
      <div class="flex items-center justify-between gap-3 min-h-11 px-4 rounded-2xl bg-zen-fg/[0.03] border-[0.5px] border-zen-border-subtle">
        <span class="text-sm truncate"><span class="text-zen-fg-muted">Sending from</span> <span class="font-mono">{account}</span></span>
        <ZenButton variant="ghost" size="sm" class="rounded-full min-h-11" onclick={disconnect} disabled={!!busy}>Disconnect</ZenButton>
      </div>
    {:else}
      <ZenButton variant="secondary" class="rounded-full self-start" onclick={connect} disabled={!walletReady}>Connect MyNearWallet</ZenButton>
    {/if}
  {/if}
{/snippet}

{#snippet actions(back: boolean, label: string, enabled: boolean, go: () => void)}
  <div class="mt-4 pt-6 border-t-[0.5px] border-zen-border-subtle flex items-center {back ? 'justify-between' : 'justify-end'} gap-3">
    {#if back}<ZenButton variant="ghost" class="rounded-full min-h-11" onclick={() => (uiStep -= 1)}>Back</ZenButton>{/if}
    <ZenButton variant="primary" class="rounded-full min-h-11" disabled={!enabled} onclick={go}>
      {label}
      {#snippet iconRight()}<ArrowRight class="w-4 h-4" />{/snippet}
    </ZenButton>
  </div>
{/snippet}

{#if step < 4}
  <!-- WizardSteps (main repo create app): one thin bar and the step name -->
  <div class="w-full border-b-[0.5px] border-zen-border-subtle">
    <div class="max-w-5xl mx-auto px-4 sm:px-6 py-2 flex items-center gap-4">
      <div class="flex-1 h-1 bg-zen-fg/10 rounded-full overflow-hidden" role="progressbar" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={step + 1} aria-valuetext="Step {step + 1} of {STEPS.length}: {STEPS[step]}">
        <div class="h-full bg-zen-fg rounded-full transition-all duration-500 ease-out" style="width: {((step + 1) / STEPS.length) * 100}%"></div>
      </div>
      <div class="text-xs font-mono text-zen-fg-muted whitespace-nowrap">
        Step {step + 1} of {STEPS.length} · <span class="text-zen-fg font-medium uppercase tracking-wider">{STEPS[step]}</span>
      </div>
    </div>
  </div>
{/if}

<div class="w-full max-w-5xl mx-auto px-4 sm:px-6 py-8 md:py-12">
  <!-- PageHeader (main repo) -->
  <header class="mb-8 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
    <div class="space-y-2">
      <h1 class="text-2xl md:text-3xl font-light tracking-tight">Send USDC to emails</h1>
      <p class="text-sm md:text-base text-zen-fg-muted font-light">Each recipient claims with their Google account.</p>
    </div>
    <a href="/campaigns" class="inline-flex items-center min-h-11 text-xs font-medium no-underline text-zen-fg-muted hover:text-zen-fg">Your campaigns</a>
  </header>

  {#if otherTab && !draft}
    <div class="mb-6 flex flex-col gap-3 rounded-2xl border-[0.5px] border-zen-error/20 bg-zen-error-muted p-4 text-sm" role="alert">
      <p>Another tab has a campaign from <code>{otherTab.sender}</code> whose send has not resolved yet. Finish it there before creating a new one here, or the same tokens could be sent twice.</p>
      <ZenButton variant="secondary" size="sm" class="rounded-full self-start min-h-11" onclick={checkOtherTab} disabled={!config}>Check it</ZenButton>
    </div>
  {/if}
  {#if otherTabNote}<p class="mb-6 text-sm text-zen-fg-muted" role="status">{otherTabNote}</p>{/if}

  {#if setupError}
    <p class="text-sm text-zen-error" role="alert">{setupError}</p>
  {:else if result && draft}
    <!-- Done: the links are the product of this page -->
    <section class="max-w-2xl flex flex-col gap-6" aria-labelledby="done-h">
      <div class="flex items-center gap-4">
        <div class="w-12 h-12 rounded-full bg-zen-success/10 text-zen-success border border-zen-success/10 flex items-center justify-center shrink-0" aria-hidden="true"><Check class="w-5 h-5" /></div>
        <div>
          <h2 id="done-h" bind:this={stepHeading} tabindex="-1" class="text-xl font-semibold tracking-tight outline-hidden">Campaign {result.campaignId} is live</h2>
          <p class="text-sm text-zen-fg-muted">{formatAmount(BigInt(draft.total))} USDC to {draft.recipients.length} recipients
            {#if env.PUBLIC_EXPLORER_TX_URL && result.txHash}· <a href="{env.PUBLIC_EXPLORER_TX_URL}{result.txHash}" target="_blank" rel="noopener noreferrer">View the transaction</a>{/if}
          </p>
        </div>
      </div>

      <div class="flex flex-col gap-2">
        <h3 class="text-sm font-medium">Claim links</h3>
        <details class="group text-sm">
          <summary class="flex items-center gap-2 min-h-11 cursor-pointer list-none text-zen-warning-content">
            Send each link only to its recipient: it is the only copy.
            <ChevronDown class="w-4 h-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <p class="mt-1 text-zen-fg-muted">
            These links are the only copy of each recipient's salt. Keep them private: anyone holding a link can test
            whether it matches an email they guess. Without the links (or your recovery file) nobody can claim, and you
            can only reclaim after the deadline.
          </p>
        </details>
        {#if linkRows.length > LONG_LINKS_ABOVE}
          <p class="text-sm text-zen-error" role="alert">Long links: some apps may cut them; send by email or copy carefully.</p>
        {/if}
      </div>

      <ul class="links flex flex-col">
        {#each linkRows as { r, link }, i (r.commitment)}
          <li class="flex items-center gap-2 min-h-12 border-b-[0.5px] border-zen-border-subtle last:border-b-0">
            <span class="flex-1 min-w-0 text-sm"><span class="break-all">{r.email}</span> <span class="text-zen-fg-muted tabular-nums">· {formatAmount(BigInt(r.amount))} USDC</span></span>
            <ZenButton variant="ghost" size="sm" class="rounded-full min-h-11" onclick={() => copyOne(i)}>{copiedRow === i ? 'Copied' : 'Copy'}</ZenButton>
            <a href={mailtoHref(r, link)} class="inline-flex items-center min-h-11 px-3 text-xs font-medium">Email</a>
          </li>
        {/each}
      </ul>
      <textarea readonly rows="5" aria-label="Claim links" class="control-border w-full rounded-2xl bg-transparent p-3 font-mono text-xs text-zen-fg-muted">{links.join('\n')}</textarea>
      <div class="flex flex-wrap gap-3">
        <ZenButton variant="primary" class="rounded-full min-h-11" onclick={copyAll}>{copied ? 'Copied' : 'Copy all'}</ZenButton>
        <ZenButton variant="secondary" class="rounded-full min-h-11" onclick={() => saveFile(`zarf-links-${result!.campaignId}.csv`, `email,amount,link\n${links.join('\n')}\n`, 'text/csv')}>Download as CSV</ZenButton>
        <ZenButton variant="ghost" class="rounded-full min-h-11" onclick={startOver}>Start a new campaign</ZenButton>
      </div>
    </section>
  {:else}
    <div class="flex flex-col lg:flex-row lg:items-start gap-10 lg:gap-12">
      <!-- Form -->
      <section class="w-full lg:max-w-xl lg:shrink-0 flex flex-col gap-4" aria-labelledby="step-h">
        <h2 id="step-h" bind:this={stepHeading} tabindex="-1" class="text-lg font-semibold tracking-tight outline-hidden">{QUESTIONS[step]}</h2>

        {#if step === 0}
          <label for="recipients" class="text-sm text-zen-fg-muted">One per line: <code>email,amount</code> in USDC, with the address they sign in to Google with.</label>
          <textarea id="recipients" bind:value={csv} rows="8" class="control-border w-full rounded-2xl bg-transparent p-4 font-mono text-sm" placeholder={'alice@gmail.com,10\nbob@gmail.com,2.5'} disabled={!!draft}></textarea>
          {#if parsed.rows.length}
            <p class="text-sm"><span class="font-semibold tabular-nums">{formatAmount(parsed.total)} USDC</span> <span class="text-zen-fg-muted">to {parsed.rows.length} recipients</span></p>
          {/if}
          {#if parsed.rejected.length}
            <div class="text-sm text-zen-error" role="alert">
              <p>Fix these lines first:</p>
              <ul class="list-disc pl-5">
                {#each parsed.rejected as r (r.line)}<li>Line {r.line}: {r.reason}</li>{/each}
              </ul>
            </div>
          {/if}
          {@render actions(false, 'Continue', recipientsOk, () => (uiStep = 1))}
        {:else if step === 1}
          <label for="deadline" class="text-sm text-zen-fg-muted">Recipients can claim until then. After it, you can reclaim what is left.</label>
          <input id="deadline" type="datetime-local" bind:value={deadline} disabled={!!draft} class="control-border w-full sm:w-auto min-h-11 rounded-[var(--zen-radius-input)] bg-transparent px-4 py-3 text-sm" />
          {#if minMs !== null && deadline && !deadlineOk}
            <p class="text-sm text-zen-error" role="alert">The deadline must be after {new Date(minMs).toLocaleString()}.</p>
          {/if}
          {@render actions(true, 'Continue', deadlineOk, () => (uiStep = 2))}
        {:else if step === 2}
          {#if config?.network !== 'mainnet'}
            <p class="text-sm text-zen-fg-muted">
              You need a NEAR testnet account and test USDC:
              <a href="https://docs.near.org/getting-started/faucet" target="_blank" rel="noopener noreferrer">NEAR faucet</a> ·
              <a href="https://faucet.circle.com" target="_blank" rel="noopener noreferrer">Circle USDC faucet</a> (NEAR Testnet).
            </p>
          {/if}
          {@render walletBlock()}
          {@render actions(true, 'Generate claim links', ready, prepare)}
        {:else}
          <p class="text-sm">
            You send <span class="font-semibold tabular-nums">{formatAmount(BigInt(draft!.total))} USDC</span> to {draft!.recipients.length} recipients,
            <span class="text-zen-fg-muted">plus a small NEAR storage pre-pay your wallet shows before you sign.</span>
          </p>
          {@render walletBlock()}
          <div class="flex flex-col gap-3 rounded-2xl bg-zen-fg/[0.03] border-[0.5px] border-zen-border-subtle p-4">
            <p class="text-sm">Save the recovery file first. <span class="text-zen-fg-muted">It holds every salt, so you can rebuild the links if this page is lost.</span></p>
            <ZenButton variant="secondary" size="sm" class="rounded-full self-start min-h-11" onclick={saveRecovery}>Download recovery file</ZenButton>
            <label class="flex items-center gap-2 min-h-11 text-sm {recoverySaved ? '' : 'opacity-50'}">
              <input type="checkbox" bind:checked={recoveryAck} disabled={!recoverySaved} class="w-4 h-4" /> I stored the recovery file somewhere private
            </label>
          </div>
          {#if txState === 'checking'}
            <p class="text-sm" role="status">Checking whether your campaign was created… Do not send again until this finishes.</p>
            <div class="flex flex-wrap items-center gap-3">
              <ZenButton variant="secondary" class="rounded-full min-h-11" onclick={recheck} disabled={!!busy}>{busy || 'Check again'}</ZenButton>
              {#if env.PUBLIC_EXPLORER_TX_URL && sentTx}<a href="{env.PUBLIC_EXPLORER_TX_URL}{sentTx}" target="_blank" rel="noopener noreferrer" class="text-sm">View it on the explorer</a>{/if}
            </div>
          {:else if txState === 'settling'}
            <p class="text-sm" role="status">That attempt was refunded. Making sure an earlier attempt did not land (about 90 seconds) before these links can change…</p>
          {:else if txState === 'mismatch'}
            <p class="text-sm text-zen-error" role="alert">The contract holds a campaign for these links that does not match this draft. It is not used. Generate new links.</p>
            <ZenButton variant="secondary" class="rounded-full self-start min-h-11" onclick={startOver}>Generate new links</ZenButton>
          {:else if txState === 'unclear'}
            <p class="text-sm text-zen-error" role="alert">
              The transaction ran but did not create this campaign, and we could not confirm your tokens came back. Do not send again; check it on the explorer first.
            </p>
            {#if env.PUBLIC_EXPLORER_TX_URL && sentTx}<a href="{env.PUBLIC_EXPLORER_TX_URL}{sentTx}" target="_blank" rel="noopener noreferrer" class="text-sm">View it on the explorer</a>{/if}
          {:else}
            <div class="mt-4 pt-6 border-t-[0.5px] border-zen-border-subtle flex items-center {pinned ? 'justify-end' : 'justify-between'} gap-3">
              {#if !pinned}<ZenButton variant="ghost" class="rounded-full min-h-11" onclick={() => (draft = null)} disabled={!!busy}>Edit recipients</ZenButton>{/if}
              <ZenButton variant="primary" class="rounded-full min-h-11" disabled={!recoveryAck || !!busy || !!sentTx || !sendable.ok} onclick={create}>{busy || 'Create campaign'}</ZenButton>
            </div>
          {/if}
        {/if}

        {#if error}<p class="text-sm text-zen-error" role="alert">{error}</p>{/if}

        <details class="group mt-6 text-sm text-zen-fg-muted">
          <summary class="flex items-center gap-2 min-h-11 cursor-pointer list-none hover:text-zen-fg">
            Who sees the emails?
            <ChevronDown class="w-4 h-4 transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <p class="mt-1">
            Emails never go on chain. When someone claims, our verifier, operated by Trion Labs, sees their email once to
            check it matches the claim.
          </p>
        </details>
      </section>

      <!-- What the first recipient will see (desktop only): the claim card in miniature -->
      <aside class="hidden lg:block lg:flex-1 lg:sticky lg:top-24" aria-label="Preview of a claim">
        <p class="mb-4 ml-1 text-xs font-semibold uppercase tracking-wider text-zen-fg-subtle">What they see</p>
        <ZenCard variant="glass" padding="lg" radius="3xl">
          <div class="flex flex-col items-center text-center gap-3" aria-hidden="true">
            <div class="w-14 h-14 rounded-full bg-zen-primary/10 text-zen-primary flex items-center justify-center"><Mail class="w-6 h-6" /></div>
            <span class="text-4xl font-bold tracking-tighter tabular-nums">{previewAmount} USDC</span>
            <span class="text-sm text-zen-fg-muted">is waiting for you</span>
            <span class="text-xs text-zen-fg-subtle">From <span class="font-mono">{account ?? 'your account'}</span>{#if previewDeadline} · claim by {previewDeadline}{/if}</span>
          </div>
        </ZenCard>
      </aside>
    </div>
  {/if}
</div>
