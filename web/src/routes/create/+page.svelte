<script lang="ts">
  import { onMount } from 'svelte';
  import { env } from '$env/dynamic/public';
  import { buildDraft, claimLink, LONG_LINKS_ABOVE, mailtoHref, messageText, recoveryFile, type Draft } from '$lib/create/campaign';
  import { getCampaignByRoot, getCampaignView, getConfig, getPrepayBalance, getStorageCosts, txOutcome, type ContractConfig } from '$lib/create/chain';
  import {
    checkCreation, fundCampaign, fundsShort, LookupPending, mayCreate, minDeadlineMs, NotCreated, NotSent, OutcomeUnclear, ownerKeySlack, prepayShortfall,
    readMarker, resolveByRoot, settleAfterUncertain, type UnresolvedMarker,
  } from '$lib/create/funding';
  import { saveFile } from '$lib/create/publish';
  import { formatAmount, parseRecipients } from '$lib/create/recipients';
  import { myNearWallet, type SenderWallet } from '$lib/create/wallet';
  import { deadlineText, timeLeft } from '$lib/claim';
  import { formatNear } from '$lib/create/campaigns';
  import { getClaimState, nearView, type ClaimState } from '$lib/services';
  import { TESTNET, UNIT, USDC_LINES } from '$lib/network';
  import { ArrowRight, ArrowUpRight, Check, ChevronDown, Clock, Info, Loader2, Mail } from 'lucide-svelte';
  import Amount from '$lib/Amount.svelte';
  import Medallion from '$lib/Medallion.svelte';
  import Note from '$lib/Note.svelte';
  import Term from '$lib/Term.svelte';
  import ZenAlert from '$lib/zen/components/ZenAlert.svelte';
  import ZenButton from '$lib/zen/components/ZenButton.svelte';
  import ZenCard from '$lib/zen/components/ZenCard.svelte';
  import ZenCheckbox from '$lib/zen/components/ZenCheckbox.svelte';
  import { themeStore } from '$lib/zen/stores/themeStore.svelte';

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
  let errorTitle = $state(''); // step 4 only: the error as Zarf's alert, title + body
  let result = $state<{ campaignId: string; txHash: string } | null>(null);
  let copied = $state(false);
  let usdcOpen = $state(false);
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
  // Display only: the sender's USDC and the storage the wallet will ask for (Create still goes through fundCampaign).
  let balance = $state<string | null>(null);
  let balanceFailed = $state(false);
  // The storage pre-pay the wallet will be asked for (yoctoNEAR; 0n: already covered) and the per-claim
  // reservation that comes back to the storage deposit for each link nobody claims. Both from storage_costs.
  let storageShort = $state<bigint | null>(null);
  let perClaim = $state<bigint | null>(null);
  const short = $derived(fundsShort(balance, parsed.total));
  // Read again when the window regains focus or on "Check again": a sender who tops up is not stuck until a reload.
  let balanceTick = $state(0);
  let balanceFor: string | null = null;
  $effect(() => {
    const a = account;
    void balanceTick;
    if (a !== balanceFor) ((balance = null), (balanceFailed = false), (balanceFor = a));
    if (!a || !rpc || !token) return;
    nearView<string>(rpc, token, 'ft_balance_of', { account_id: a }, 'optimistic').then(
      (b) => { if (account === a) ((balance = b), (balanceFailed = false)); },
      () => { if (account === a && balance === null) balanceFailed = true; },
    );
  });
  $effect(() => {
    const d = draft, a = account, c = config;
    storageShort = perClaim = null;
    if (!d || !a || !c || !rpc || !contract || !token) return;
    Promise.all([getStorageCosts(rpc, contract, token), getPrepayBalance(rpc, contract, a)]).then(([costs, free]) => {
      if (draft !== d) return;
      storageShort = prepayShortfall(costs, d.recipients.length, free, ownerKeySlack(c.storage_byte_cost));
      perClaim = BigInt(costs.per_claim_storage);
    }, () => {});
  });

  onMount(async () => {
    if (!rpc || !contract || !token) {
      setupError = 'This site is not fully set up yet (PUBLIC_NEAR_RPC_URL, PUBLIC_CONTRACT_ID, PUBLIC_TOKEN_ID).';
      return;
    }
    try {
      config = await getConfig(rpc, contract);
      if (!config.token_ids.includes(token)) setupError = `${token} is not accepted by this contract.`;
      choose(picks[0] ?? 'date');
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
    error = errorTitle = '';
    try {
      account = await wallet!.signIn();
    } catch (e) {
      error = 'The wallet did not connect. Try again.';
    }
  }

  async function disconnect() {
    await wallet!.signOut();
    account = null;
  }

  async function prepare() {
    error = errorTitle = '';
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
    E127_NO_VERIFIER: 'This date is past what the verifier covers. Pick an earlier one.',
    E128_INSUFFICIENT_STORAGE: 'The storage deposit fell short twice in a row. Try again.',
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
        errorTitle = "Your wallet didn't confirm";
        error = 'Sending again is safe: if both go through, the second is refunded.';
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
      errorTitle = 'Nothing was sent';
      error = 'This browser blocked site storage. Allow it and try again.';
    } else if (e instanceof NotCreated) {
      // Proven for this tx: the tokens are back (or never left).
      const msg = ERRORS[e.code] ?? `The contract refused it (${e.code}).`;
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

  /** A proven refund (NotCreated): the tokens are back in the wallet, so the title says so. */
  function unpin(msg: string) {
    sentTx = txState = null;
    pinned = hadUncertain = false;
    clearFunding();
    setMarker(null);
    errorTitle = `Not sent: your ${UNIT} is back in your wallet`;
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
    error = errorTitle = '';
    if (!sendable.ok) {
      error = sendable.reason;
      return;
    }
    busy = WAITING;
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
    csv = error = errorTitle = '';
    claims = [];
    previewRow = 0;
    uiStep = 0;
  }

  // Wizard: the first three steps are local; Send and the links follow the draft and the result.
  const STEPS = ['Recipients', 'Deadline', 'Wallet', 'Send'];
  const QUESTIONS = ['Who gets it?', 'Until when can they claim?', 'Which wallet pays?', 'Check and send'];
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
  // Before any row the preview shows an example figure, dimmed.
  const previewAmount = $derived(parsed.rows[0] ? formatAmount(BigInt(parsed.rows[0].amount)) : '10');
  const previewEmail = $derived(draft?.recipients[0]?.email ?? parsed.rows[0]?.email ?? null);
  /** "GMT+3": the sender's own time zone, which every date on this page is in. */
  const zoneName = (ms: number) => new Intl.DateTimeFormat('en-GB', { timeZoneName: 'short' }).formatToParts(ms).find((p) => p.type === 'timeZoneName')?.value ?? '';
  /** "Thu 19 Nov, 06:20" */
  const shortWhen = (ms: number) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(ms);
  const previewLeft = $derived(Number.isFinite(deadlineMs) ? timeLeft(deadlineMs, Date.now()) : '');

  // Deadline quick picks: the first three lengths the contract's minimum lifetime allows (testnet: 1 week,
  // 2 weeks, 30 days; mainnet, 30-day minimum: 30, 60, 90 days). An hour of slack keeps a pick valid until it lands.
  const DAY = 86_400_000;
  const picks = $derived(config ? [7, 14, 30, 60, 90].filter((d) => d * DAY >= Number(BigInt(config!.min_lifetime_ns) / 1_000_000n)).slice(0, 3) : []);
  const pickLabel = (d: number) => (d === 7 ? '1 week' : d === 14 ? '2 weeks' : `${d} days`);
  let pick = $state<number | 'date'>('date');
  function choose(p: number | 'date') {
    pick = p;
    if (p !== 'date') deadline = toLocalInput(Math.max(Date.now() + p * DAY, minDeadlineMs(Date.now(), config!.min_lifetime_ns) + 3_600_000));
  }

  // Display only: what this send asks the wallet for, mirroring fundingTxs (a pre-pay tx only when short).
  const txCount = $derived(storageShort === null ? null : storageShort > 0n ? 2 : 1);
  const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;
  const WAITING = 'Waiting for your wallet…';
  /** The sending pipeline's current row: 1 the wallet, 2 the chain. 0: not sending. */
  const phase = $derived(busy === WAITING ? 1 : busy || sentTx || txState === 'checking' || txState === 'settling' ? 2 : 0);
  const sendBlocker = $derived(
    !recoverySaved ? 'Save the backup file first.' : !recoveryAck ? "Tick the box once it's saved." : !sendable.ok ? sendable.reason : '',
  );
  const message = (r: { email: string; amount: string }, link: string) => messageText(r, link, { unit: UNIT, testnet: TESTNET, deadlineMs });
  const claimHost = $derived(claimOrigin.replace(/^https?:\/\//, ''));

  // Done page: who has claimed, read from the chain (claim_state per link). Nothing new is stored.
  // shortcut: only the first 100 links are checked, one read each; batch the reads if senders send more.
  const STATUS_ROWS = 100;
  let claims = $state<(ClaimState | null)[]>([]);
  let claimsAt = $state<number | null>(null);
  let claimsBusy = $state(false);
  async function readClaims() {
    if (!result || !draft) return;
    const id = result.campaignId;
    claimsBusy = true;
    claims = await Promise.all(draft.recipients.slice(0, STATUS_ROWS).map((r) => getClaimState(rpc, contract, id, r.commitment).catch(() => null)));
    claimsAt = Date.now();
    claimsBusy = false;
  }
  $effect(() => {
    if (result && draft) void readClaims();
  });
  let previewRow = $state(0); // the message shown on the done page: the row last copied, else the first

  let copyTimer: ReturnType<typeof setTimeout>;
  const settleCopied = () => {
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => ((copied = false), (copiedRow = -1)), 2000);
  };

  async function copyAll() {
    await navigator.clipboard.writeText(links.join('\n'));
    copied = true;
    copiedRow = -1;
    settleCopied();
  }

  async function copyOne(i: number) {
    await navigator.clipboard.writeText(message(linkRows[i].r, linkRows[i].link).body);
    copiedRow = previewRow = i;
    copied = false;
    settleCopied();
  }
</script>

<svelte:head><title>Send USDC · Zarf</title></svelte:head>
<svelte:window onfocus={() => balanceTick++} />

{#snippet accountRow()}
  {#if wrongAccount}
    <ZenAlert variant="warning">This send belongs to <span class="font-mono">{sentFrom}</span>. Reconnect {sentFrom} to continue.</ZenAlert>
  {/if}
  {#if account}
    <div class="flex items-center justify-between gap-3 min-h-11 border-y-[0.5px] border-zen-border-subtle">
      <span class="min-w-0 truncate text-sm"><span class="text-zen-fg-muted">From</span> <span class="font-mono">{account}</span></span>
      {#if !pinned}<ZenButton variant="ghost" size="sm" class="rounded-full min-h-11 !text-zen-fg" onclick={disconnect} disabled={!!busy}>Disconnect</ZenButton>{/if}
    </div>
    {#if pinned && !wrongAccount}<p class="text-xs text-zen-fg-muted">Finish this send before using another account.</p>{/if}
  {/if}
{/snippet}

{#snippet figure(label: string, value: string, dim = false)}
  <!-- The amount block, small: label, figure, the unit beside it (canonical choice 4) -->
  <div class="flex flex-col gap-1 min-w-0">
    <span class="text-[10px] uppercase tracking-[0.3em] text-zen-fg-muted font-bold">{label}</span>
    <span class="flex flex-wrap items-baseline gap-x-2 {dim ? 'text-zen-fg-muted' : ''}">
      <span class="text-3xl font-light tracking-tighter tabular-nums">{value}</span>
      <span class="text-xs font-medium uppercase tracking-widest text-zen-primary whitespace-nowrap">{UNIT}</span>
    </span>
  </div>
{/snippet}

{#snippet actions(back: boolean, label: string, enabled: boolean, go: () => void, reason = '')}
  <div class="mt-4 pt-6 border-t-[0.5px] border-zen-border-subtle flex flex-col gap-2">
    <div class="flex items-center {back ? 'justify-between' : 'justify-end'} gap-3">
      {#if back}<ZenButton variant="ghost" class="rounded-full min-h-11 !text-zen-fg -ml-6" onclick={() => (uiStep -= 1)}>Back</ZenButton>{/if}
      <ZenButton variant="primary" class="rounded-full min-h-11" disabled={!enabled} onclick={go}>
        {label}
        {#snippet iconRight()}<ArrowRight class="w-4 h-4" />{/snippet}
      </ZenButton>
    </div>
    <!-- Why the button is grey, or what it does next (Zarf's launchBlocker spot) -->
    {#if reason}<p class="text-xs text-zen-fg-muted text-right ml-auto max-w-sm">{reason}</p>{/if}
  </div>
{/snippet}

{#snippet explorerLink(hash: string)}
  {#if env.PUBLIC_EXPLORER_TX_URL && hash}
    <a href="{env.PUBLIC_EXPLORER_TX_URL}{hash}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 min-h-11 text-sm underline underline-offset-2 hover:text-zen-fg">View the transaction<ArrowUpRight class="w-3.5 h-3.5" aria-hidden="true" /></a>
  {/if}
{/snippet}

{#snippet messageCard(email: string, m: { subject: string; body: string }, note: string)}
  <!-- The ready-made message, shaped like an email: an object, so it gets a frame -->
  <ZenCard variant="elevated" padding="md">
    <div class="flex flex-col gap-3 text-sm">
      <div class="flex flex-col gap-0.5 pb-3 border-b-[0.5px] border-zen-border-subtle">
        <span class="truncate"><span class="text-zen-fg-muted">To</span> {email}</span>
        <span class="truncate"><span class="text-zen-fg-muted">Subject</span> {m.subject}</span>
      </div>
      <p class="whitespace-pre-line break-words text-zen-fg/90">{m.body}</p>
    </div>
  </ZenCard>
  {#if note}<p class="mt-3 ml-1 text-xs text-zen-fg-muted">{note}</p>{/if}
{/snippet}

{#snippet pipeline()}
  {@const idle = !busy && txState === 'checking'}
  <!-- Zarf's DeploymentPipeline: numbered rows, the current one marked; hairline connector, no boxes -->
  <ol class="flex flex-col" aria-label="Sending">
    {#each ['Approve in MyNearWallet', 'Confirming on NEAR', 'Links ready'] as label, i (label)}
      {@const st = i + 1 < phase ? 'done' : i + 1 === phase ? 'active' : 'pending'}
      <li class="relative flex gap-4 pb-5 last:pb-0 {st === 'pending' ? 'opacity-40' : ''}" aria-current={st === 'active' ? 'step' : undefined}>
        {#if i < 2}<span class="absolute left-4 top-9 bottom-1 w-px bg-zen-border" aria-hidden="true"></span>{/if}
        <span class="w-8 h-8 shrink-0 rounded-full border-[0.5px] flex items-center justify-center text-xs font-medium
          {st === 'done' ? 'bg-zen-fg text-zen-bg border-zen-fg' : st === 'active' ? 'border-zen-border text-zen-fg' : 'border-zen-border-subtle text-zen-fg-muted'}">
          {#if st === 'done'}<Check class="w-4 h-4" aria-hidden="true" />{:else if st === 'active' && idle}<Clock class="w-4 h-4" aria-hidden="true" />{:else if st === 'active'}<Loader2 class="w-4 h-4 animate-spin" aria-hidden="true" />{:else}{i + 1}{/if}
        </span>
        <div class="flex flex-col min-w-0 pt-1.5">
          <span class="text-sm font-medium {st === 'active' ? 'text-zen-fg' : 'text-zen-fg-muted'}">{label}</span>
          {#if st === 'active' && i === 0}
            <span class="text-sm text-zen-fg-muted" role="status">Waiting for you in the wallet window.</span>
          {:else if st === 'active' && i === 1}
            <span class="text-sm text-zen-fg-muted" role="status">{idle ? 'Not confirmed yet.' : sentTx ? 'Sent. Checking it went through.' : 'Checking whether it went through.'}</span>
            {#if sentTx}<span class="text-zen-fg-muted">{@render explorerLink(sentTx)}</span>{/if}
          {/if}
        </div>
      </li>
    {/each}
  </ol>
  <p class="text-xs text-zen-fg-muted">Keep this tab open until the links appear.</p>
{/snippet}

{#if step < 4}
  <!-- WizardSteps (main repo create app): one thin bar and the step name -->
  <div class="w-full border-b border-zen-border-subtle bg-zen-bg">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2 flex items-center gap-4">
      <div class="flex-1 h-1 bg-zen-fg/10 rounded-full overflow-hidden" role="progressbar" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={step + 1} aria-valuetext="Step {step + 1} of {STEPS.length}: {STEPS[step]}">
        <div class="h-full bg-zen-fg rounded-full transition-all duration-500 ease-out" style="width: {((step + 1) / STEPS.length) * 100}%"></div>
      </div>
      <div class="text-xs text-zen-fg-muted whitespace-nowrap">Step {step + 1} of {STEPS.length} · <span class="text-zen-fg font-medium">{STEPS[step]}</span></div>
    </div>
  </div>
{/if}

<div class="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 md:py-12">
  {#if otherTab && !draft}
    <ZenAlert variant="warning" class="mb-6">
      Another tab has a send from <span class="font-mono">{otherTab.sender}</span> that has not resolved yet. Finish it there first, or the same money could be sent twice.
      {#snippet actions()}<ZenButton variant="secondary" size="sm" class="rounded-full min-h-11" onclick={checkOtherTab} disabled={!config}>Check it</ZenButton>{/snippet}
    </ZenAlert>
  {/if}
  {#if otherTabNote}<p class="mb-6 text-sm text-zen-fg-muted" role="status">{otherTabNote}</p>{/if}

  {#if setupError}
    <ZenAlert variant="error">{setupError}</ZenAlert>
  {:else if result && draft}
    <!-- Done: the links are the product of this page -->
    {@const shown = linkRows[previewRow] ?? linkRows[0]}
    <div class="flex flex-col lg:flex-row lg:items-start gap-10 lg:gap-12">
      <section class="w-full lg:max-w-xl lg:shrink-0 flex flex-col gap-6" aria-labelledby="done-h">
        <div class="flex flex-col items-start gap-4">
          <div class="[&>div]:mx-0"><Medallion icon={Check} tone="success" /></div>
          <div class="space-y-1">
            <h1 id="done-h" bind:this={stepHeading} tabindex="-1" class="text-2xl md:text-3xl font-light tracking-tight outline-hidden">
              <span class="tabular-nums">{formatAmount(BigInt(draft.total))}</span>&nbsp;<span class="text-sm font-medium uppercase tracking-widest text-zen-primary whitespace-nowrap align-[0.2em]">{UNIT}</span> is waiting for {people(draft.recipients.length).replace(' ', ' ')}
            </h1>
            <p class="text-sm text-zen-fg-muted">Campaign {result.campaignId}{#if env.PUBLIC_EXPLORER_TX_URL && result.txHash}{' · '}<a href="{env.PUBLIC_EXPLORER_TX_URL}{result.txHash}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-zen-fg">View the transaction<ArrowUpRight class="w-3 h-3" aria-hidden="true" /></a>{/if}</p>
          </div>
        </div>

        <div class="flex flex-col gap-1">
          <h2 class="text-base font-semibold tracking-tight">Send each person their link</h2>
          <p class="text-sm text-zen-fg-muted">From your own email or chat. Zarf doesn't email anyone.</p>
        </div>
        {#if linkRows.length > LONG_LINKS_ABOVE}
          <ZenAlert variant="warning">These links are long; some apps cut them. Send them by email, or copy them carefully.</ZenAlert>
        {/if}

        <div class="flex flex-col gap-1">
          <ul class="links flex flex-col border-y-[0.5px] border-zen-border-subtle">
            {#each linkRows as { r, link }, i (r.commitment)}
              {@const c = claims[i]}
              <li class="flex items-center gap-1 min-h-12 border-b-[0.5px] border-zen-border-subtle last:border-b-0">
                <span class="flex-1 min-w-0 flex flex-col py-1.5 text-sm">
                  <span class="truncate" title={r.email}>{r.email}</span>
                  <span class="flex flex-wrap items-center gap-x-1.5 text-xs text-zen-fg-muted tabular-nums">
                    <span class="whitespace-nowrap">{formatAmount(BigInt(r.amount))} <span class="text-[10px] uppercase tracking-widest">{UNIT}</span></span>
                    {#if c === 'claimed'}
                      <span class="inline-flex items-center gap-1 whitespace-nowrap text-zen-success-content">· <Check class="w-3 h-3" aria-hidden="true" />Claimed</span>
                    {:else if c === 'pending'}
                      <span class="inline-flex items-center gap-1 whitespace-nowrap">· <Clock class="w-3 h-3" aria-hidden="true" />Being paid</span>
                    {:else if c === 'unclaimed'}
                      <span class="whitespace-nowrap">· Not claimed yet</span>
                    {/if}
                  </span>
                </span>
                <ZenButton variant="ghost" size="sm" class="rounded-full min-h-11 !text-zen-fg" onclick={() => copyOne(i)}>{copiedRow === i ? 'Copied' : 'Copy message'}</ZenButton>
                <ZenButton href={mailtoHref(r, message(r, link))} variant="ghost" size="sm" class="rounded-full min-h-11 !text-zen-fg">Email</ZenButton>
              </li>
            {/each}
          </ul>
          {#if claimsAt !== null || claimsBusy}
            <div class="flex items-center justify-between gap-3 text-xs text-zen-fg-muted">
              <span role="status">{claimsBusy ? 'Checking who has claimed…' : `Checked ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(claimsAt!)}${linkRows.length > STATUS_ROWS ? ` · first ${STATUS_ROWS} links` : ''}`}</span>
              <ZenButton variant="ghost" size="sm" class="rounded-full min-h-11 !text-zen-fg" onclick={readClaims} disabled={claimsBusy}>Check again</ZenButton>
            </div>
          {/if}
        </div>

        <div class="flex flex-wrap gap-3">
          <ZenButton variant="primary" class="rounded-full min-h-11" onclick={copyAll}>{copied ? 'Copied' : 'Copy all links'}</ZenButton>
          <ZenButton variant="secondary" class="rounded-full min-h-11" onclick={() => saveFile(`zarf-links-${result!.campaignId}.csv`, `email,amount,link\n${links.join('\n')}\n`, 'text/csv')}>Download as CSV</ZenButton>
          <ZenButton variant="ghost" class="rounded-full min-h-11 !text-zen-fg" onclick={startOver}>Start over</ZenButton>
        </div>

        <section class="flex flex-col gap-3 pt-6 border-t-[0.5px] border-zen-border-subtle" aria-labelledby="next-h">
          <h2 id="next-h" class="text-[11px] font-medium uppercase tracking-[0.15em] text-zen-fg-muted">What happens next</h2>
          <ol class="flex flex-col gap-2 text-sm">
            <li class="flex gap-3"><span class="font-mono text-[11px] text-zen-fg-muted pt-0.5">01</span>They open the link and choose the {TESTNET ? 'NEAR account' : 'account'} it goes to.</li>
            <li class="flex gap-3"><span class="font-mono text-[11px] text-zen-fg-muted pt-0.5">02</span>They sign in with Google as that email, and the {UNIT} arrives.</li>
            <li class="flex gap-3"><span class="font-mono text-[11px] text-zen-fg-muted pt-0.5">03</span><span>After {shortWhen(deadlineMs)} you can take back what's left, in <a href="/campaigns" class="underline underline-offset-2 hover:text-zen-fg">Campaigns</a>.</span></li>
          </ol>
          <p class="text-xs text-zen-fg-muted">Your backup file <span class="font-mono">zarf-recovery-{draft.merkleRoot.slice(0, 8)}.json</span> rebuilds these links.</p>
        </section>

        <details class="group text-sm text-zen-fg-muted">
          <summary class="inline-flex items-center gap-2 min-h-11 cursor-pointer list-none hover:text-zen-fg">
            Keep each link private
            <ChevronDown class="w-4 h-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <p class="mt-1">
            Each link is the only copy of what its recipient needs to claim. Anyone holding a link can test whether it matches
            an email they guess, so send it only to its recipient. Lost them? Your backup file rebuilds them; after the deadline
            you can take back what is left.
          </p>
        </details>
      </section>

      {#if shown}
        <aside class="w-full lg:flex-1 lg:sticky lg:top-24 min-w-0" aria-label="The message for {shown.r.email}">
          <p class="mb-4 ml-1 text-[11px] font-medium uppercase tracking-[0.15em] text-zen-fg-muted truncate">The message for <span class="normal-case tracking-normal text-xs">{shown.r.email}</span></p>
          {@render messageCard(shown.r.email, message(shown.r, `${claimHost}/claim/${result.campaignId}/${shown.r.commitment.slice(0, 8)}…`), '"Copy message" copies it with the full link.')}
        </aside>
      {/if}
    </div>
  {:else}
    <div class="relative isolate flex flex-col lg:flex-row lg:items-start gap-10 lg:gap-12">
      {#if step === 0}
        <!-- Background decor of create step 1 (main repo apps/create/src/routes/wizard/step-0/+page.svelte): the
             same blob. Not clipped to this block (that shows straight edges); the page wrapper clips the overflow
             sideways instead, so a 390 px screen never scrolls and the sticky preview keeps working -->
        <div class="absolute inset-0 -z-10 pointer-events-none" aria-hidden="true">
          <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-125 h-125 bg-zen-fg/5 rounded-full blur-[120px]"></div>
        </div>
      {/if}
      <!-- Form: the step question is the page title -->
      <section class="w-full lg:max-w-xl lg:shrink-0 flex flex-col gap-4" aria-labelledby="step-h">
        <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 mb-2">
          <h1 id="step-h" bind:this={stepHeading} tabindex="-1" class="text-2xl md:text-3xl font-light tracking-tight outline-hidden">{QUESTIONS[step]}</h1>
          {#if step === 0}
            <!-- Zarf's token chip (create wizard step 1): the money has a face. One token, so no "Change"; ⓘ opens the USDC sentence -->
            <button type="button" class="group/chip inline-flex items-center min-h-11 cursor-pointer" aria-expanded={usdcOpen} aria-controls="usdc-what" onclick={() => (usdcOpen = !usdcOpen)}>
              <span class="inline-flex items-center gap-2 bg-zen-fg/5 rounded-full pl-1.5 pr-2 py-1 border border-zen-border-subtle group-hover/chip:border-zen-border transition-colors">
                <img src="/tokens/usdc.svg" alt="" class="w-4 h-4 rounded-full" />
                <span class="text-xs font-semibold uppercase">{UNIT}</span>
                <span class="text-xs text-zen-fg-muted">· {TESTNET ? 'NEAR testnet' : 'NEAR'}</span>
                <Info class="w-3.5 h-3.5 text-zen-fg-muted" aria-hidden="true" />
                <span class="sr-only">What is {UNIT}?</span>
              </span>
            </button>
          {/if}
        </div>

        {#if step === 0}
          {#if usdcOpen}
            <div id="usdc-what" class="-mt-4 flex flex-col gap-1 text-sm text-zen-fg-muted">
              {#each USDC_LINES as l (l)}<p>{l}</p>{/each}
            </div>
          {/if}
          <label for="recipients" class="flex flex-col gap-1">
            <span class="text-sm font-medium">Their Google email and amount</span>
            <span class="text-xs text-zen-fg-muted">One per line, like alice@gmail.com, 10</span>
          </label>
          <textarea id="recipients" bind:value={csv} rows="8" class="control-border w-full rounded-2xl bg-transparent p-4 !font-mono text-sm" placeholder={'alice@gmail.com,10\nbob@gmail.com,2.5'} disabled={!!draft}></textarea>
          {#if parsed.rows.length}
            <p class="text-sm"><span class="font-semibold tabular-nums">{formatAmount(parsed.total)} <span class="uppercase text-xs tracking-widest font-medium">{UNIT}</span></span> <span class="text-zen-fg-muted">to {people(parsed.rows.length)}</span></p>
          {/if}
          {#if parsed.rejected.length}
            <Note tone="error">
              Fix these lines first:
              {#each parsed.rejected as r (r.line)}<span class="block font-normal">Line {r.line}: {r.reason}</span>{/each}
            </Note>
          {/if}
          <Term q="Which email?">The exact address they sign in to Google with. A Gmail +alias can't sign in.</Term>
          {@render actions(false, 'Continue', recipientsOk, () => (uiStep = 1), recipientsOk ? '' : parsed.rejected.length ? `Fix line ${parsed.rejected[0].line} first.` : 'Add at least one line.')}
        {:else if step === 1}
          <div class="control-border grid gap-1 p-1 rounded-full" style="grid-template-columns: repeat({picks.length + 1}, minmax(0, 1fr))" role="radiogroup" aria-label="Claim deadline">
            {#each [...picks, 'date' as const] as p (p)}
              <label
                class="flex items-center justify-center min-h-10 whitespace-nowrap text-sm font-medium rounded-full px-2 cursor-pointer transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-zen-fg
                  {pick === p ? 'bg-zen-fg text-zen-bg' : 'text-zen-fg-muted hover:text-zen-fg'}"
              >
                <input class="sr-only" type="radio" name="pick" value={p} checked={pick === p} onchange={() => choose(p)} />{p === 'date' ? 'Pick a date' : pickLabel(p)}
              </label>
            {/each}
          </div>
          {#if pick === 'date'}
            <label for="deadline" class="sr-only">Claim deadline</label>
            <input id="deadline" type="datetime-local" bind:value={deadline} disabled={!!draft} aria-describedby="deadline-note" class="control-border w-full sm:w-auto min-h-11 rounded-[var(--zen-radius-input)] bg-transparent px-4 py-3 text-sm" />
          {/if}
          <div id="deadline-note">
            {#if minMs !== null && deadline && !deadlineOk}
              <Note tone="error">Pick a time after {deadlineText(minMs, Date.now())}.</Note>
            {:else if Number.isFinite(deadlineMs)}
              <!-- What happens: a two-line timeline on a hairline rule -->
              <ol class="flex flex-col gap-2 pl-4 border-l-[0.5px] border-zen-border text-sm">
                <li><span class="font-medium">Until {shortWhen(deadlineMs)}:</span> <span class="text-zen-fg-muted">only the people on your list can claim.</span></li>
                <li><span class="font-medium">After that:</span> <span class="text-zen-fg-muted">you can take back what's left, from Campaigns.</span></li>
              </ol>
              <p class="mt-3 text-xs text-zen-fg-muted">Your time zone ({zoneName(deadlineMs)}){previewLeft ? ` · ${previewLeft}` : ''}. Fixed once you send.</p>
            {/if}
          </div>
          <Term q="Does it come back by itself?">No. After the deadline you take it back yourself, in Campaigns. Until you do, it stays in the Zarf contract.</Term>
          {@render actions(true, 'Continue', deadlineOk, () => (uiStep = 2))}
        {:else if step === 2}
          <p class="text-sm">Your NEAR wallet holds your {UNIT} and asks you before anything moves.</p>
          {#if !account}
            {#if TESTNET}
              <!-- What you need, in order (numbered like Zarf's pipeline, hairlines, no boxes) -->
              <ol class="flex flex-col border-y-[0.5px] border-zen-border-subtle text-sm">
                <li class="flex gap-3 py-3 border-b-[0.5px] border-zen-border-subtle">
                  <span class="font-mono text-[11px] text-zen-fg-muted pt-0.5">01</span>
                  <span class="flex flex-col gap-0.5">
                    <span class="font-medium">A NEAR testnet account</span>
                    <a href="https://testnet.mynearwallet.com" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 self-start text-zen-fg-muted underline underline-offset-2 hover:text-zen-fg">Create one in MyNearWallet<ArrowUpRight class="w-3.5 h-3.5" aria-hidden="true" /></a>
                  </span>
                </li>
                <li class="flex gap-3 py-3">
                  <span class="font-mono text-[11px] text-zen-fg-muted pt-0.5">02</span>
                  <span class="flex flex-col gap-0.5">
                    <span class="font-medium">Test USDC in it</span>
                    <a href="https://faucet.circle.com" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 self-start text-zen-fg-muted underline underline-offset-2 hover:text-zen-fg">Get free test USDC from Circle<ArrowUpRight class="w-3.5 h-3.5" aria-hidden="true" /></a>
                    <span class="text-xs text-zen-fg-muted">On Circle's page choose NEAR Testnet and paste your account name.</span>
                  </span>
                </li>
              </ol>
            {/if}
            <Term q="What is a NEAR wallet?">NEAR is the network this runs on. MyNearWallet is a free web wallet for it.</Term>
            {@render actions(true, 'Connect MyNearWallet', walletReady, connect, 'This shares your account name. Nothing moves until you send.')}
          {:else}
            {@render accountRow()}
            <!-- Have versus need (Zarf's DeployStep3Connect): two amount blocks, then one verdict line -->
            <div class="grid grid-cols-2 gap-4 py-2">
              {@render figure('You have', balance !== null ? formatAmount(BigInt(balance)) : '…', balance === null)}
              {@render figure('This send', formatAmount(parsed.total))}
            </div>
            {#if balanceFailed && balance === null}
              <div class="flex flex-wrap items-center justify-between gap-x-3">
                <Note tone="error">Couldn't read your balance. Nothing was sent.</Note>
                <ZenButton variant="ghost" size="sm" class="rounded-full min-h-11 !text-zen-fg" onclick={() => balanceTick++}>Check again</ZenButton>
              </div>
            {:else if short > 0n}
              <div class="flex flex-wrap items-center justify-between gap-x-3">
                <Note tone="error">{formatAmount(short)} {UNIT} short.</Note>
                <span class="flex items-center gap-1">
                  {#if TESTNET}<a href="https://faucet.circle.com" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 min-h-11 px-2 text-sm underline underline-offset-2 hover:text-zen-fg">Get test USDC<ArrowUpRight class="w-3.5 h-3.5" aria-hidden="true" /></a>{/if}
                  <ZenButton variant="ghost" size="sm" class="rounded-full min-h-11 !text-zen-fg" onclick={() => balanceTick++}>Check again</ZenButton>
                </span>
              </div>
            {:else if balance !== null}
              <Note tone="success">Enough to send.</Note>
            {/if}
            {@render actions(true, 'Continue', ready && short === 0n, prepare)}
          {/if}
        {:else}
          {@const d = draft!}
          <!-- 1. Who gets what -->
          <div class="flex flex-col gap-2">
            <h2 class="text-sm"><span class="font-semibold">{people(d.recipients.length)} get</span> <span class="font-semibold tabular-nums">{formatAmount(BigInt(d.total))}</span> <span class="text-xs font-medium uppercase tracking-widest text-zen-primary">{UNIT}</span></h2>
            <ul class="flex flex-col text-sm border-y-[0.5px] border-zen-border-subtle max-h-64 overflow-auto">
              {#each d.recipients as r (r.commitment)}
                <li class="flex items-center justify-between gap-3 min-h-10 border-b-[0.5px] border-zen-border-subtle last:border-b-0">
                  <span class="truncate min-w-0">{r.email}</span><span class="shrink-0 whitespace-nowrap tabular-nums text-zen-fg-muted">{formatAmount(BigInt(r.amount))} <span class="text-[10px] uppercase tracking-widest">{UNIT}</span></span>
                </li>
              {/each}
            </ul>
            {#if !pinned}<ZenButton variant="ghost" size="sm" class="rounded-full min-h-11 self-start -ml-4 !text-zen-fg" onclick={() => ((draft = null), (uiStep = 0))} disabled={!!busy}>Edit</ZenButton>{/if}
          </div>

          <!-- 2. Leaves your wallet: one line per item -->
          <section class="flex flex-col gap-2" aria-labelledby="leaves-h">
            <h2 id="leaves-h" class="text-[11px] font-medium uppercase tracking-[0.15em] text-zen-fg-muted">Leaves your wallet{#if account}<span class="normal-case tracking-normal font-mono">&nbsp;·&nbsp;{account}</span>{/if}</h2>
            <dl class="flex flex-col text-sm border-y-[0.5px] border-zen-border-subtle">
              <div class="flex flex-col sm:flex-row sm:items-baseline gap-x-4 py-2.5 border-b-[0.5px] border-zen-border-subtle">
                <dt class="sm:w-36 shrink-0 font-semibold tabular-nums whitespace-nowrap">{formatAmount(BigInt(d.total))} <span class="text-[10px] uppercase tracking-widest">{UNIT}</span></dt>
                <dd class="text-zen-fg-muted">held by the Zarf contract until each person claims</dd>
              </div>
              <div class="flex flex-col sm:flex-row sm:items-baseline gap-x-4 py-2.5 border-b-[0.5px] border-zen-border-subtle">
                {#if storageShort === null}
                  <dt class="sm:w-36 shrink-0 font-semibold">Storage deposit</dt><dd class="text-zen-fg-muted">checking…</dd>
                {:else if storageShort > 0n}
                  <dt class="sm:w-36 shrink-0 font-semibold tabular-nums whitespace-nowrap">{formatNear(storageShort.toString()) === '0' ? 'under 0.00001' : formatNear(storageShort.toString())} <span class="text-[10px] uppercase tracking-widest">NEAR</span></dt>
                  <dd class="text-zen-fg-muted">storage deposit, so NEAR can keep each claim on record</dd>
                {:else}
                  <dt class="sm:w-36 shrink-0 font-semibold">Storage deposit</dt><dd class="text-zen-fg-muted">already covered by NEAR you deposited before</dd>
                {/if}
              </div>
              <div class="flex flex-col sm:flex-row sm:items-baseline gap-x-4 py-2.5">
                <dt class="sm:w-36 shrink-0 font-semibold">Network fee</dt>
                <dd class="text-zen-fg-muted">a small amount of NEAR, charged by the network</dd>
              </div>
            </dl>
            <Term q="Why NEAR as well?">NEAR, the network, charges a small deposit in its own coin to store each claim, and a fee for each transaction. Your wallet pays both from its NEAR.</Term>
          </section>

          <!-- 3. Comes back to you -->
          <section class="flex flex-col gap-2" aria-labelledby="back-h">
            <h2 id="back-h" class="text-[11px] font-medium uppercase tracking-[0.15em] text-zen-fg-muted">Comes back to you</h2>
            <p class="text-sm">
              After {shortWhen(deadlineMs)} you can take back whatever nobody claimed, in Campaigns.{#if perClaim !== null}{' '}<span class="text-zen-fg-muted">Up to {formatNear((BigInt(d.recipients.length) * perClaim).toString())} NEAR of the storage returns to your storage deposit with it.</span>{/if}
            </p>
            <Term q="Can I cancel after sending?">No. Before the deadline only the people on your list can claim. After it, you take back what's left.</Term>
          </section>

          <!-- 4. Backup: the checkbox appears only once the file was saved (Zarf's DeployStep2Backup order) -->
          <section class="flex flex-col gap-2" aria-labelledby="backup-h">
            <h2 id="backup-h" class="text-[11px] font-medium uppercase tracking-[0.15em] text-zen-fg-muted">Backup</h2>
            <p class="text-sm text-zen-fg-muted">It rebuilds every link if this tab closes. It lists every email: keep it private.</p>
            <ZenButton variant="secondary" size="sm" class="rounded-full self-start min-h-11" onclick={saveRecovery} disabled={phase > 0}>{recoverySaved ? 'Save it again' : 'Save the backup file'}</ZenButton>
            {#if recoverySaved}<ZenCheckbox bind:checked={recoveryAck} disabled={phase > 0} label="I saved it somewhere private" />{/if}
          </section>

          {#if wrongAccount}
            <ZenAlert variant="warning">This send belongs to <span class="font-mono">{sentFrom}</span>. Reconnect {sentFrom} to continue.</ZenAlert>
          {:else if pinned}
            <p class="text-xs text-zen-fg-muted">Finish this send before using another account.</p>
          {/if}

          <!-- 5. Send. Every sub-state in Zarf's alert, each answering "where is my money?": warning while it must not be sent again, error when it failed. -->
          {#if txState === 'mismatch'}
            <ZenAlert variant="error">
              {#snippet title()}These links can't be used{/snippet}
              NEAR holds a different campaign under them. Make new links.
            </ZenAlert>
            <ZenButton variant="primary" class="rounded-full self-start min-h-11" onclick={startOver}>Make new links</ZenButton>
          {:else if txState === 'unclear'}
            <ZenAlert variant="warning">
              {#snippet title()}Don't send again yet{/snippet}
              NEAR ran it but made no campaign, and the refund isn't confirmed. Open the transaction to check.
            </ZenAlert>
            {#if env.PUBLIC_EXPLORER_TX_URL && sentTx}
              <ZenButton href="{env.PUBLIC_EXPLORER_TX_URL}{sentTx}" target="_blank" rel="noopener noreferrer" variant="secondary" class="rounded-full self-start min-h-11">
                View the transaction
                {#snippet iconRight()}<ArrowUpRight class="w-3.5 h-3.5" />{/snippet}
              </ZenButton>
            {/if}
          {:else}
            {#if error}
              <ZenAlert variant="error">
                {#snippet title()}{errorTitle}{/snippet}
                {error}{#if errorTitle.startsWith('Not sent') && storageShort !== null && storageShort > 0n}{' '}Any storage deposit it took stays at Zarf for your next send; you can withdraw it in Campaigns.{/if}
              </ZenAlert>
            {/if}
            <div class="mt-4 pt-6 border-t-[0.5px] border-zen-border-subtle flex flex-col gap-2">
              {#if !TESTNET}<Note tone="info">Real USDC. Check the amounts.</Note>{/if}
              <div class="flex items-center {pinned ? 'justify-end' : 'justify-between'} gap-3">
                {#if !pinned}<ZenButton variant="ghost" class="rounded-full min-h-11 !text-zen-fg -ml-6" onclick={() => (draft = null)} disabled={!!busy}>Back</ZenButton>{/if}
                <ZenButton variant="primary" class="rounded-full min-h-11" disabled={!!sendBlocker || phase > 0} onclick={create}>Send {formatAmount(BigInt(d.total))} {UNIT}</ZenButton>
              </div>
              {#if phase === 0}
                <p class="text-xs text-zen-fg-muted text-right ml-auto max-w-sm">
                  {sendBlocker ||
                    `MyNearWallet opens for your approval.${txCount === 2 ? ` This send is 2 transactions: the storage deposit, then the ${UNIT}.` : txCount === 1 ? ` This send is 1 transaction: the ${UNIT}.` : ''}`}
                </p>
              {/if}
            </div>
            {#if phase > 0}{@render pipeline()}{/if}
            {#if txState === 'checking' && !busy}
              <ZenAlert variant="warning">
                {#snippet title()}Checking with NEAR{/snippet}
                Your send may have gone out. Don't send again until this finishes.
              </ZenAlert>
              <div class="flex flex-wrap items-center gap-4">
                <ZenButton variant="secondary" class="rounded-full min-h-11" onclick={recheck}>Check again</ZenButton>
              </div>
            {:else if txState === 'settling'}
              <ZenAlert variant="warning">
                {#snippet title()}Making sure nothing was sent twice{/snippet}
                The last try was refunded. One more check in about 90 seconds.
              </ZenAlert>
            {/if}
          {/if}
        {/if}

        {#if error && step !== 3}<Note tone="error">{error}</Note>{/if}

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

      {#if step < 3}
        <!-- What the first recipient will see: the claim card in miniature. Beside the form on desktop, below it on phones -->
        <aside class="w-full lg:flex-1 lg:sticky lg:top-24 min-w-0" aria-label="Preview of a claim">
          <p class="mb-4 ml-1 text-[11px] font-medium uppercase tracking-[0.15em] text-zen-fg-muted truncate">{#if previewEmail}What <span class="normal-case tracking-normal text-xs">{previewEmail}</span> sees{:else}What they see{/if}</p>
          <ZenCard variant="elevated" padding="lg">
            <div class="flex flex-col items-center text-center gap-4 {parsed.rows.length ? '' : 'opacity-50'}" aria-hidden="true">
              <Medallion icon={Mail} />
              <Amount label="Waiting for you" value={previewAmount} unit={UNIT} glow={false} />
              <span class="text-xs text-zen-fg-muted">From {#if account}<span class="font-mono">{account}</span>{:else}you{/if}{#if previewLeft}{' · '}{previewLeft}{/if}</span>
              <img src={themeStore.isDark ? '/google/signin-dark.svg' : '/google/signin-light.svg'} alt="" width="175" height="40" />
            </div>
          </ZenCard>
          <p class="mt-3 ml-1 text-xs text-zen-fg-muted">They need only their Google email to start.</p>
        </aside>
      {:else}
        <aside class="w-full lg:flex-1 lg:sticky lg:top-24 min-w-0" aria-label="Preview of the message">
          {#if previewEmail && draft}
            <p class="mb-4 ml-1 text-[11px] font-medium uppercase tracking-[0.15em] text-zen-fg-muted truncate">What <span class="normal-case tracking-normal text-xs">{previewEmail}</span> gets</p>
            {@render messageCard(previewEmail, message(draft.recipients[0], `${claimHost}/claim/…`), 'Each person gets their own link after you send.')}
          {/if}
        </aside>
      {/if}
    </div>
  {/if}
</div>
