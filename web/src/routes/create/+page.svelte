<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { env } from '$env/dynamic/public';
  import { buildDraft, claimLink, LONG_LINKS_ABOVE, mailtoHref, messageText, readRecoveryFile, recoveryFile, type Draft } from '$lib/create/campaign';
  import { getAccount, getCampaignByRoot, getCampaignView, getConfig, getGasPrice, getPrepayBalance, getStorageCosts, txOutcome, type ContractConfig } from '$lib/create/chain';
  import {
    attachedGas, checkCreation, fundCampaign, fundsShort, LookupPending, mayCreate, minDeadlineMs, nearNeeded, NotCreated, NotSent, OutcomeUnclear, ownerKeySlack,
    prepayShortfall, readMarker, resolveByRoot, settleAfterUncertain, spendableNear, type StorageCosts, type UnresolvedMarker,
  } from '$lib/create/funding';
  import { saveFile } from '$lib/create/publish';
  import { formatAmount, sendCapError } from '$lib/create/recipients';
  import { checkGrid, isBlankRow, parsePaste, type GridRow } from '$lib/create/grid';
  import RecipientGrid from '$lib/create/RecipientGrid.svelte';
  import RecipientImportControls from '$lib/create/RecipientImportControls.svelte';
  import { mayNotSignIn } from '$lib/create/googleSignIn';
  import { nearConnectWallet, type SenderWallet } from '$lib/create/wallet';
  import { deadlineText, timeLeft } from '$lib/claim';
  import { formatNear, sig3 } from '$lib/create/campaigns';
  import { getClaimState, nearView, type ClaimState } from '$lib/services';
  import { CIRCLE_LINE, TESTNET, UNIT } from '$lib/network';
  import { ArrowRight, ArrowUpRight, Check, CheckCircle2, ChevronDown, Copy, Download, ExternalLink, Eye, Info, Lock, Mail, Plus, RefreshCw } from 'lucide-svelte';
  import AmountPanel from '$lib/AmountPanel.svelte';
  import Avatar from '$lib/Avatar.svelte';
  import CopyButton from '$lib/CopyButton.svelte';
  import EmailMark from '$lib/EmailMark.svelte';
  import GoogleG from '$lib/GoogleG.svelte';
  import Steps from '$lib/Steps.svelte';
  import MicroStepProgress from '$lib/create/MicroStepProgress.svelte';
  import Tooltip from '$lib/zen/components/Tooltip.svelte';
  import ZenBadge from '$lib/zen/components/ZenBadge.svelte';
  import ZenInput from '$lib/zen/components/ZenInput.svelte';
  import { markIn, swapIn } from '$lib/motion';
  import Note from '$lib/Note.svelte';
  import ZenAlert from '$lib/zen/components/ZenAlert.svelte';
  import ZenButton from '$lib/zen/components/ZenButton.svelte';
  import ZenCard from '$lib/zen/components/ZenCard.svelte';
  import ZenCheckbox from '$lib/zen/components/ZenCheckbox.svelte';

  const rpc = env.PUBLIC_NEAR_RPC_URL;
  // NEAR's own page for free testnet NEAR (the sender needs a little for storage and fees).
  const TEST_NEAR_URL = 'https://docs.near.org/getting-started/faucet';
  const contract = env.PUBLIC_CONTRACT_ID;
  const token = env.PUBLIC_TOKEN_ID;

  let gridRows = $state<GridRow[]>([{ email: '', amount: '' }]);
  const parsed = $derived(checkGrid(gridRows));
  let grid = $state<{ addRow: () => Promise<void> }>();
  let skipped = $state<string[]>([]);
  // One-step undo for Clear. Raw: it holds a snapshot.
  let cleared = $state.raw<GridRow[] | null>(null);
  /** Pasted or imported rows go after the filled ones; blank rows make way. False when no line had an address. */
  function addPasted(text: string, sameAmount = ''): boolean {
    const { rows, skipped: s } = parsePaste(text, sameAmount);
    skipped = s;
    cleared = null;
    if (!rows.length) return false;
    gridRows = [...gridRows.filter((r) => !isBlankRow(r)), ...rows];
    return true;
  }
  function clearRows() {
    cleared = $state.snapshot(gridRows);
    gridRows = [{ email: '', amount: '' }];
    skipped = [];
  }
  // Rows whose address may not sign in with Google: a calm hint, never a block. Debounced so typing a domain doesn't query each prefix.
  let notGoogle = $state<Set<string>>(new Set());
  $effect(() => {
    const emails = parsed.rows.map((r) => r.email);
    let live = true;
    const t = setTimeout(() => mayNotSignIn(emails).then((s) => live && (notGoogle = s)), 500);
    return () => { live = false; clearTimeout(t); };
  });
  const unsure = $derived(parsed.rows.filter((r) => notGoogle.has(r.email)));
  // One set per keystroke, not a scan per grid row (T-010 review minor 1: O(n²) on a pasted 5k list).
  const unsureLines = $derived(new Set(unsure.map((r) => r.line)));
  const unsureRow = (i: number) => unsureLines.has(i + 1);
  let config = $state<ContractConfig | null>(null);
  let setupError = $state('');
  let setupRetry = $state(false);
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
  let errorCode = $state(''); // a proven refund's contract code: E119/E127 offer "Change the deadline"
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
  // Display only (Create still goes through fundCampaign): the sender's test USDC and NEAR, and what this send
  // needs in NEAR. storage_costs and prepay_balance_of give the storage pre-pay exactly as fundCampaign computes
  // it; the fee margin is all the gas fundingTxs attaches at the current gas price. The NEAR check is advisory.
  let balance = $state<string | null>(null);
  let balanceFailed = $state(false);
  let costs = $state<StorageCosts | null>(null);
  let freePrepay = $state<bigint | null>(null); // the sender's Zarf balance (the contract's free pre-pay)
  let nearHave = $state<bigint | null>(null);
  let nearFailed = $state(false);
  let gasPrice = $state<bigint | null>(null);
  const leafCount = $derived(draft ? draft.recipients.length : parsed.rows.length);
  const storageShort = $derived(
    costs && freePrepay !== null && config && leafCount > 0 ? prepayShortfall(costs, leafCount, freePrepay.toString(), ownerKeySlack(config.storage_byte_cost)) : null,
  );
  const perClaim = $derived(costs ? BigInt(costs.per_claim_storage) : null);
  const feeMax = $derived(storageShort !== null && gasPrice !== null ? attachedGas(storageShort) * gasPrice : null);
  const nearNeed = $derived(storageShort !== null && gasPrice !== null ? nearNeeded(storageShort, gasPrice) : null);
  const nearShort = $derived(nearHave !== null && nearNeed !== null && nearHave < nearNeed ? nearNeed - nearHave : 0n);
  const short = $derived(fundsShort(balance, parsed.total));
  /** NEAR rounded up to the 5 decimals shown: a figure that is needed is never understated. */
  const nearUp = (y: bigint) => formatNear((y + 10n ** 19n - 1n).toString());
  // Read again when the window regains focus or on "Check again": a sender who tops up is not stuck until a reload.
  let balanceTick = $state(0);
  let balanceFor: string | null = null;
  $effect(() => {
    const a = account;
    void balanceTick;
    if (a !== balanceFor) ((balance = nearHave = freePrepay = null), (balanceFailed = nearFailed = false), (balanceFor = a));
    const c = config;
    if (!a || !c || !rpc || !token || !contract) return;
    nearView<string>(rpc, token, 'ft_balance_of', { account_id: a }, 'optimistic').then(
      (b) => { if (account === a) ((balance = b), (balanceFailed = false)); },
      () => { if (account === a && balance === null) balanceFailed = true; },
    );
    getAccount(rpc, a).then(
      (x) => { if (account === a) ((nearHave = spendableNear(x, c.storage_byte_cost)), (nearFailed = false)); },
      () => { if (account === a && nearHave === null) nearFailed = true; },
    );
    getPrepayBalance(rpc, contract, a).then((f) => { if (account === a) freePrepay = BigInt(f); }, () => {});
    getStorageCosts(rpc, contract, token).then((x) => (costs = x), () => {});
    // NEAR's minimum gas price if the read fails (the price only rises from there).
    getGasPrice(rpc).then((g) => (gasPrice = g), () => (gasPrice ??= 100_000_000n));
  });
  // The sender's name for the message: this browser only, never sent on chain or to a server.
  const NAME_KEY = 'zarf-near:sender-name';
  let senderName = $state('');
  let nameLoaded = false;
  $effect(() => {
    const n = senderName;
    if (!nameLoaded) return;
    try {
      if (n.trim()) localStorage.setItem(NAME_KEY, n);
      else localStorage.removeItem(NAME_KEY);
    } catch {
      // the name just isn't remembered
    }
  });

  onMount(async () => {
    if (!rpc || !contract || !token) {
      setupError = 'This site is not fully set up yet (PUBLIC_NEAR_RPC_URL, PUBLIC_CONTRACT_ID, PUBLIC_TOKEN_ID).';
      return;
    }
    try {
      senderName = localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      senderName = '';
    }
    nameLoaded = true;
    try {
      config = await getConfig(rpc, contract);
      if (!config.token_ids.includes(token)) setupError = `${token} is not accepted by this contract.`;
      choose(picks[0] ?? 'date');
      wallet = await nearConnectWallet(config.network, rpc);
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
      setupError = "Couldn't reach NEAR. Nothing was sent.";
      setupRetry = true;
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
    error = errorTitle = errorCode = '';
    draft = await buildDraft(parsed.rows);
    recoverySaved = recoveryAck = false;
  }

  /**
   * "Open a backup file": the recovery file rebuilds the links of a campaign this account already funded.
   * Read-only: it finds the campaign by (sender, merkle_root) and shows the done page; nothing is sent.
   */
  async function openBackup(file: File | undefined) {
    error = errorTitle = errorCode = '';
    if (!file) return;
    try {
      const { draft: d } = await readRecoveryFile(await file.text(), { contractId: contract!, network: config!.network });
      if (!account) await connect();
      if (!account) {
        error = 'Connect the wallet that sent this campaign to open its backup.';
        return;
      }
      const id = await resolveByRoot({ ...byRoot(), sender: account }, { merkleRoot: d.merkleRoot, total: d.total }).catch((e) => {
        throw new Error(e?.message === 'CAMPAIGN_MISMATCH' ? 'The campaign on NEAR does not match this backup.' : 'Could not reach NEAR. Try again in a minute.');
      });
      if (!id) {
        error = `No campaign from ${account} uses this backup. If you sent it from another account, connect that one.`;
        return;
      }
      // The deadline comes from the contract's record, not from the file (the file is only trusted for the links).
      const c = await getCampaignView(rpc!, contract!, id).catch(() => null);
      if (!c) {
        error = 'Could not reach NEAR. Try again in a minute.';
        return;
      }
      draft = d;
      deadline = toLocalInput(Number(BigInt(c.deadline_ns) / 1_000_000n));
      recoverySaved = recoveryAck = true; // the sender holds the file they just opened
      result = { campaignId: id, txHash: '' }; // the funding tx is not in the file; the done page hides its link
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
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
    E128_INSUFFICIENT_STORAGE: 'The NEAR for storage fell short twice in a row. Try again.',
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
      errorCode = e.code;
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
      const c = await checkCreation({ ...lookup, ...byRoot() }, txHash, { merkleRoot: draft!.merkleRoot, total: draft!.total });
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
    error = errorTitle = errorCode = '';
    if (!sendable.ok) {
      error = sendable.reason;
      return;
    }
    const cap = sendCapError(BigInt(draft!.total), TESTNET);
    if (cap) {
      error = cap; // defence in depth: step 1 already refuses this
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
    error = errorTitle = errorCode = '';
    gridRows = [{ email: '', amount: '' }];
    skipped = [];
    cleared = null;
    claims = [];
    previewRow = 0;
    uiStep = 0;
  }

  // Wizard: the first three steps are local; Send and the links follow the draft and the result.
  const STEPS = ['Recipients', 'Deadline', 'Wallet', 'Review'];
  let uiStep = $state(0);
  const step = $derived(result && draft ? 4 : draft ? 3 : uiStep);
  const capError = $derived(sendCapError(parsed.total, TESTNET));
  const recipientsOk = $derived(parsed.rows.length > 0 && parsed.rejected.length === 0 && !capError);
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
  const pickLabel = (d: number) => (d === 7 ? '1 Week' : d === 14 ? '2 Weeks' : `${d} Days`);
  // Radiogroup keys on the deadline pills: arrows move the choice and the focus, as native radios do.
  function pickKey(e: KeyboardEvent) {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const all = [...picks, 'date' as const];
    choose(all[(all.indexOf(pick) + d + all.length) % all.length]);
    tick().then(() => (document.querySelector(`[data-pick="${pick}"]`) as HTMLElement | null)?.focus());
  }
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
    wrongAccount ? ' ' /* the wrong-account warning says it; one message */ : !recoverySaved ? 'Download the backup first.' : !recoveryAck ? "Tick the box once it's saved." : !sendable.ok ? sendable.reason : '',
  );
  const deadlineFix = $derived(!!error && (errorCode.startsWith('E119') || errorCode.startsWith('E127')));
  const explorerAccount = env.PUBLIC_EXPLORER_TX_URL?.includes('/txns/') ? env.PUBLIC_EXPLORER_TX_URL.replace('/txns/', '/address/') : '';
  const claimCounts = $derived.by(() => {
    const n = (k: ClaimState) => claims.filter((c) => c === k).length;
    return claims.length ? { claimed: n('claimed'), paying: n('pending'), open: n('unclaimed') } : null;
  });
  const message = (r: { email: string; amount: string }, link: string) =>
    messageText(r, link, { unit: UNIT, testnet: TESTNET, deadlineMs, from: senderName, home: claimOrigin });
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

{#snippet wrongAccountAlert()}
  <!-- One message: the reason, and the one thing to do -->
  <ZenAlert variant="warning">
    This send was started from <span class="font-mono">{sentFrom}</span>. Reconnect {sentFrom} to finish it.
    {#snippet actions()}
      {#if account}<ZenButton variant="secondary" size="sm" onclick={disconnect} disabled={!!busy}>Disconnect</ZenButton>
      {:else}<ZenButton variant="secondary" size="sm" onclick={connect} disabled={!walletReady}>Connect Wallet</ZenButton>{/if}
    {/snippet}
  </ZenAlert>
{/snippet}

{#snippet accountRow()}
  {#if wrongAccount}{@render wrongAccountAlert()}{/if}
  {#if account}
    <div class="flex items-center justify-between gap-3 py-2 border-y border-zen-border-subtle">
      <span class="min-w-0 flex items-center gap-2 text-sm"><span class="text-zen-fg-subtle">From</span><Avatar name={account} /><span class="font-mono truncate">{account}</span></span>
      {#if !pinned}<ZenButton variant="ghost" size="sm" onclick={disconnect} disabled={!!busy}>Disconnect</ZenButton>{/if}
    </div>
  {/if}
{/snippet}

{#snippet usdcChip()}
  <!-- Zarf's token chip (create wizard step-1:230-250): one token, so no "Change" -->
  <span class="inline-flex items-center gap-2 bg-zen-fg/5 rounded-full pl-1.5 pr-3 py-1 border border-zen-border-subtle">
    <img src="/tokens/usdc.svg" alt="" class="w-4 h-4 rounded-full" />
    <span class="text-xs font-semibold uppercase">{UNIT}</span>
  </span>
{/snippet}

{#snippet stepHeader(title: string, helper: string)}
  <!-- Zarf create step-1:218-253: title and one helper left; token chip and step chips right -->
  <header class="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
    <div class="space-y-2">
      <h1 id="step-h" bind:this={stepHeading} tabindex="-1" class="text-2xl md:text-3xl font-light tracking-tight text-zen-fg outline-hidden">{title}</h1>
      {#if helper}<p class="text-sm md:text-base text-zen-fg-muted font-light leading-relaxed">{helper}</p>{/if}
    </div>
    <div class="flex flex-wrap items-center gap-3">
      {@render usdcChip()}
      <MicroStepProgress segments={STEPS.map((label) => ({ label }))} current={step} />
    </div>
  </header>
{/snippet}

{#snippet figure(label: string, value: string, unit: string, dim = false, exact = '')}
  <!-- The amount block, small: label, figure, the unit beside it; the exact value on hover (spec G6f) -->
  <div class="flex flex-col gap-1 min-w-0">
    <span class="text-[10px] uppercase tracking-[0.3em] text-zen-fg-subtle font-bold">{label}</span>
    <span class="flex flex-wrap items-baseline gap-x-2 {dim ? 'text-zen-fg-muted' : ''}" title={exact ? `${exact} ${unit}` : undefined}>
      <span class="text-3xl font-light tracking-tighter tabular-nums">{value}</span>
      <span class="text-xs font-medium uppercase tracking-widest text-zen-primary whitespace-nowrap">{unit}</span>
    </span>
  </div>
{/snippet}

{#snippet actions(back: boolean, label: string, enabled: boolean, go: () => void, reason = '')}
  <!-- Zarf's action bar (create step-1:293) -->
  <div class="mt-12 pt-6 border-t border-zen-border-subtle flex flex-col gap-2">
    <div class="flex items-center {back ? 'justify-between' : 'justify-end'} gap-3">
      {#if back}<ZenButton variant="ghost" onclick={() => (uiStep -= 1)}>Back</ZenButton>{/if}
      <ZenButton variant="primary" size="lg" class="px-8" disabled={!enabled} onclick={go}>
        {label}
        {#snippet iconRight()}<ArrowRight class="w-4 h-4" />{/snippet}
      </ZenButton>
    </div>
    {#if reason}<p class="text-xs text-zen-fg-muted text-right ml-auto max-w-60">{reason}</p>{/if}
  </div>
{/snippet}

{#snippet explorerLink(hash: string)}
  {#if env.PUBLIC_EXPLORER_TX_URL && hash}
    <a href="{env.PUBLIC_EXPLORER_TX_URL}{hash}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-sm underline underline-offset-2 hover:text-zen-fg">View Transaction<ArrowUpRight class="w-3.5 h-3.5" aria-hidden="true" /></a>
  {/if}
{/snippet}

{#snippet nameField()}
  <ZenInput label="Your Name (Optional)" class="control-border" bind:value={senderName} maxlength={60} autocomplete="name" placeholder="Your name" hint="Signs the message. Stays in this browser." />
{/snippet}

{#snippet messageCard(email: string, m: { subject: string; body: string })}
  <!-- The ready-made message, shaped like an email: an object, so it gets a frame -->
  <ZenCard variant="elevated" padding="md">
    <div class="flex flex-col gap-3 text-sm">
      <div class="flex flex-col gap-0.5 pb-3 border-b border-zen-border-subtle">
        <span class="flex items-center gap-2 min-w-0"><span class="text-zen-fg-subtle">To</span><EmailMark {email} /><span class="truncate">{email}</span></span>
        <span class="truncate"><span class="text-zen-fg-subtle">Subject</span> {m.subject}</span>
      </div>
      <p class="text-sm whitespace-pre-line break-words text-zen-fg/90">{m.body}</p>
    </div>
  </ZenCard>
{/snippet}

{#snippet pipeline()}
  {@const idle = !busy && txState === 'checking'}
  <Steps
    label="Sending"
    rows={['Approve in Wallet', 'Confirming on NEAR', 'Links Ready'].map((label, i) => ({ label, state: i + 1 < phase ? 'done' : i + 1 === phase ? 'active' : 'pending', idle }))}
  >
    {#snippet detail(i, row)}
      {#if i === 0 && txCount === 2 && row.state !== 'done'}
        <span class="text-sm text-zen-fg-muted">Approve 2 transactions: storage, then {UNIT}.</span>
      {/if}
      {#if row.state === 'active' && i === 0}
        <span class="text-sm text-zen-fg-muted" role="status">Waiting for you in the wallet window.</span>
      {:else if row.state === 'active' && i === 1}
        <span class="text-sm text-zen-fg-muted" role="status">{idle ? 'Not confirmed yet.' : sentTx ? 'Sent. Checking it went through.' : 'Checking whether it went through.'}</span>
        {#if sentTx}<span class="text-zen-fg-muted">{@render explorerLink(sentTx)}</span>{/if}
      {/if}
    {/snippet}
  </Steps>
  <p class="text-xs text-zen-fg-subtle">Keep this tab open until the links appear.</p>
{/snippet}

{#snippet ledgerRow(label: string, value: string, exact = '')}
  <!-- DeploymentSummary row: small uppercase label left, value right -->
  <div class="flex items-baseline justify-between gap-4">
    <div class="text-[10px] text-zen-fg-subtle uppercase shrink-0">{label}</div>
    <div class="font-medium text-sm text-right tabular-nums" title={exact || undefined}>{value}</div>
  </div>
{/snippet}

<div class="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 md:py-12">
  {#if otherTab && !draft}
    <ZenAlert variant="warning" class="mb-6">
      Another tab has a send from <span class="font-mono">{otherTab.sender}</span> that has not resolved yet. Finish it there first, or the same money could be sent twice.
      {#snippet actions()}<ZenButton variant="secondary" size="sm" onclick={checkOtherTab} disabled={!config}>Check</ZenButton>{/snippet}
    </ZenAlert>
  {/if}
  {#if otherTabNote}<p class="mb-6 text-sm text-zen-fg-muted" role="status">{otherTabNote}</p>{/if}

  {#if setupError}
    <ZenAlert variant="error">
      {setupError}
      {#snippet actions()}{#if setupRetry}<ZenButton variant="secondary" size="sm" onclick={() => location.reload()}>Try Again</ZenButton>{/if}{/snippet}
    </ZenAlert>
  {:else if result && draft}
    <!-- Done (design spec 3.4): the links are the product of this page -->
    {@const shown = linkRows[previewRow] ?? linkRows[0]}
    <div class="flex flex-col lg:flex-row lg:items-start gap-10 lg:gap-8 xl:gap-12" in:swapIn>
      <section class="w-full lg:max-w-xl lg:shrink-0 space-y-8" aria-labelledby="done-h">
        <div class="flex items-start gap-4">
          <div class="w-12 h-12 rounded-full bg-zen-success/10 text-zen-success flex items-center justify-center shrink-0" in:markIn aria-hidden="true"><CheckCircle2 class="w-6 h-6" /></div>
          <div class="space-y-2 min-w-0">
            <h1 id="done-h" bind:this={stepHeading} tabindex="-1" class="text-2xl md:text-3xl font-light tracking-tight outline-hidden">Your Campaign Is Live</h1>
            <p class="text-sm text-zen-fg-muted tabular-nums">
              Campaign {result.campaignId} · {formatAmount(BigInt(draft.total))} {UNIT} to {people(draft.recipients.length)}
              {#if env.PUBLIC_EXPLORER_TX_URL && result.txHash}<a href="{env.PUBLIC_EXPLORER_TX_URL}{result.txHash}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center align-middle ml-1 text-zen-fg-subtle hover:text-zen-fg" aria-label="View Transaction"><ExternalLink class="w-3.5 h-3.5" aria-hidden="true" /></a>{/if}
            </p>
            {#if claimCounts}
              <div class="flex flex-wrap gap-2" role="status">
                {#if claimCounts.claimed}<ZenBadge variant="success" size="sm">{claimCounts.claimed} Claimed</ZenBadge>{/if}
                {#if claimCounts.paying}<ZenBadge variant="info" size="sm">{claimCounts.paying} Paying</ZenBadge>{/if}
                {#if claimCounts.open}<ZenBadge variant="default" size="sm">{claimCounts.open} Waiting</ZenBadge>{/if}
                {#if linkRows.length > STATUS_ROWS}<span class="text-xs text-zen-fg-subtle">first {STATUS_ROWS}</span>{/if}
              </div>
            {/if}
          </div>
        </div>

        {#if linkRows.length > LONG_LINKS_ABOVE}
          <ZenAlert variant="warning">These links are long; some apps cut them. Send them by email, or copy them carefully.</ZenAlert>
        {/if}

        <div class="space-y-3">
          <div class="flex items-center justify-between gap-3">
            <span class="zen-section-label !text-zen-fg-subtle !mb-0 inline-flex items-center gap-1.5">
              Links
              <Tooltip text="Each link is the only copy its recipient needs. Send it only to them." position="bottom">
                <button type="button" class="inline-flex items-center justify-center w-6 h-6 rounded-full text-zen-fg-subtle hover:text-zen-fg normal-case" aria-label="Keep each link private: each link is the only copy its recipient needs. Send it only to them."><Lock class="w-3.5 h-3.5" aria-hidden="true" /></button>
              </Tooltip>
            </span>
            {#if claimsAt !== null || claimsBusy}
              <span class="flex items-center gap-1 text-xs text-zen-fg-subtle tabular-nums">
                {claimsBusy ? 'Checking…' : `Checked ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(claimsAt!)}`}
                <ZenButton variant="ghost" size="xs" onclick={readClaims} disabled={claimsBusy}>
                  {#snippet iconLeft()}<RefreshCw class="w-3.5 h-3.5" />{/snippet}Refresh
                </ZenButton>
              </span>
            {/if}
          </div>
          <ul class="links divide-y divide-zen-border-subtle border-y border-zen-border-subtle">
            {#each linkRows as { r, link }, i (r.commitment)}
              {@const c = claims[i]}
              <li class="flex items-center gap-2 py-2.5">
                <EmailMark email={r.email} />
                <span class="flex-1 min-w-0 truncate text-sm" title={r.email}>{r.email}</span>
                <span class="shrink-0 whitespace-nowrap text-sm tabular-nums">{formatAmount(BigInt(r.amount))}</span>
                {#if c === 'claimed'}<ZenBadge variant="success" size="sm">Claimed</ZenBadge>
                {:else if c === 'pending'}<ZenBadge variant="info" size="sm">Paying</ZenBadge>
                {:else if c === 'unclaimed'}<ZenBadge variant="default" size="sm">Waiting</ZenBadge>{/if}
                <Tooltip text={copiedRow === i ? 'Copied' : 'Copy Message'} position="top">
                  <button type="button" class="inline-flex items-center justify-center w-8 h-8 rounded-full text-zen-fg-subtle hover:text-zen-fg hover:bg-zen-fg/5" aria-label={copiedRow === i ? 'Copied' : 'Copy Message'} onclick={() => copyOne(i)}>
                    {#if copiedRow === i}<Check class="w-3.5 h-3.5" aria-hidden="true" />{:else}<Copy class="w-3.5 h-3.5" aria-hidden="true" />{/if}
                  </button>
                </Tooltip>
                <Tooltip text="Email" position="top">
                  <a href={mailtoHref(r, message(r, link))} class="inline-flex items-center justify-center w-8 h-8 rounded-full text-zen-fg-subtle hover:text-zen-fg hover:bg-zen-fg/5" aria-label="Email"><Mail class="w-3.5 h-3.5" aria-hidden="true" /></a>
                </Tooltip>
              </li>
            {/each}
          </ul>
          <div class="flex flex-wrap gap-2">
            <ZenButton variant="secondary" size="sm" onclick={copyAll}>
              {#snippet iconLeft()}{#if copied}<Check class="w-3.5 h-3.5" />{:else}<Copy class="w-3.5 h-3.5" />{/if}{/snippet}{copied ? 'Copied' : 'Copy All Links'}
            </ZenButton>
            <ZenButton variant="secondary" size="sm" onclick={() => saveFile(`zarf-links-${result!.campaignId}.csv`, `email,amount,link\n${links.join('\n')}\n`, 'text/csv')}>
              {#snippet iconLeft()}<Download class="w-3.5 h-3.5" />{/snippet}Download CSV
            </ZenButton>
          </div>
        </div>

        <div class="space-y-4 pt-6 border-t border-zen-border-subtle">
          <p class="text-sm text-zen-fg-muted">After {shortWhen(deadlineMs)}, take back the rest in <a href="/campaigns" class="underline underline-offset-2 hover:text-zen-fg">Campaigns</a>.</p>
          <div class="flex flex-wrap gap-2">
            <ZenButton variant="ghost" size="sm" onclick={startOver}>{#snippet iconLeft()}<Plus class="w-3.5 h-3.5" />{/snippet}New Send</ZenButton>
            <ZenButton variant="ghost" size="sm" onclick={saveRecovery}>{#snippet iconLeft()}<Download class="w-3.5 h-3.5" />{/snippet}Download Backup</ZenButton>
          </div>
        </div>
      </section>

      {#if shown}
        <aside class="w-full min-w-0 lg:flex-1 lg:max-w-2xl lg:sticky lg:top-24 space-y-6" aria-label="The message for {shown.r.email}">
          {@render nameField()}
          <div>
            <div class="flex items-center gap-2 mb-4 text-xs font-semibold uppercase tracking-wider text-zen-fg-subtle ml-1"><Eye class="w-3.5 h-3.5" aria-hidden="true" /> Message</div>
            {@render messageCard(shown.r.email, message(shown.r, `${claimHost}/claim/${result.campaignId}/${shown.r.commitment.slice(0, 8)}…`))}
          </div>
        </aside>
      {/if}
    </div>
  {:else}
    <div class="flex flex-col lg:flex-row lg:items-start gap-10 lg:gap-8 xl:gap-12">
      <section class="w-full lg:max-w-xl lg:shrink-0 flex flex-col gap-8" aria-labelledby="step-h">
        {#if step === 0}
          {@render stepHeader('Recipients', 'Their Google sign-in email and amount.')}
          <div class="flex flex-col gap-3">
            <RecipientImportControls
              hasRows={gridRows.some((r) => !isBlankRow(r))}
              backupDisabled={!config || !!busy}
              {skipped}
              onAddRow={() => grid?.addRow()}
              onClear={clearRows}
              onPaste={addPasted}
              onImportFile={async (f) => addPasted(await f.text())}
              onOpenBackup={openBackup}
              onDismissSkipped={() => (skipped = [])}
            />
            <!-- Undo restores a snapshot, so it goes away once anything is typed. -->
            {#if cleared && !gridRows.some((r) => !isBlankRow(r))}
              <div role="status" class="flex items-center justify-between gap-3 rounded-xl bg-zen-fg/[0.03] px-3 py-2 text-sm text-zen-fg-muted">
                <span>List cleared.</span>
                <ZenButton variant="ghost" size="sm" onclick={() => ((gridRows = cleared!), (cleared = null))}>Undo</ZenButton>
              </div>
            {/if}
            <RecipientGrid bind:this={grid} bind:rows={gridRows} problems={parsed.problems} notGoogle={unsureRow} total={parsed.total} count={parsed.rows.length} unit={UNIT} />
            {#if unsure.length}<p class="text-xs text-zen-fg-subtle">{unsure.length === 1 ? 'This person must be able to sign in to Google with this exact address, or the share waits until the deadline.' : 'Each person marked must be able to sign in to Google with that exact address, or their share waits until the deadline.'}</p>{/if}
            {#if capError}<Note tone="error">{capError}</Note>{/if}
          </div>
          {@render actions(false, 'Continue', recipientsOk, () => (uiStep = 1), recipientsOk ? '' : capError ? 'Up to 100 USDC per send.' : parsed.rejected.length ? `Fix row ${parsed.rejected[0].line} first.` : '')}
        {:else if step === 1}
          {@render stepHeader('Deadline', 'Until then, only your list can claim.')}
          <div class="flex flex-col gap-3">
            <!-- Zarf pills (create VestingDurationPicker), radiogroup keys kept -->
            <div class="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Claim deadline" tabindex="-1" onkeydown={pickKey}>
              {#each [...picks, 'date' as const] as p (p)}
                <ZenButton
                  variant={pick === p ? 'primary' : 'ghost'}
                  size="sm"
                  class="px-3 rounded-full text-xs font-medium"
                  role="radio"
                  aria-checked={pick === p}
                  tabindex={pick === p ? 0 : -1}
                  data-pick={p}
                  onclick={() => choose(p)}
                >{p === 'date' ? 'Pick Date' : pickLabel(p)}</ZenButton>
              {/each}
            </div>
            {#if pick === 'date'}
              <label for="deadline" class="sr-only">Claim deadline</label>
              <input id="deadline" type="datetime-local" bind:value={deadline} disabled={!!draft} aria-describedby="deadline-note" class="control-border w-full sm:w-auto rounded-[var(--zen-radius-input)] bg-transparent px-4 py-3 text-sm" />
            {/if}
            <div id="deadline-note">
              {#if minMs !== null && deadline && !deadlineOk}
                <Note tone="error">Pick a time after {shortWhen(minMs)}.</Note>
              {:else if Number.isFinite(deadlineMs)}
                <div class="grid grid-cols-1 gap-3 pt-2" title="Your time zone ({zoneName(deadlineMs)}). Fixed once you send.">
                  {@render ledgerRow('Claims Close', `${shortWhen(deadlineMs)} ${zoneName(deadlineMs)}`)}
                  {@render ledgerRow('Then', 'You take back the rest')}
                </div>
              {/if}
            </div>
          </div>
          {@render actions(true, 'Continue', deadlineOk, () => (uiStep = 2))}
        {:else if step === 2}
          {@render stepHeader('Wallet', account ? '' : 'It pays for this send.')}
          {#if !account}
            {#if TESTNET}
              <div class="flex flex-wrap gap-2">
                <ZenButton variant="ghost" size="sm" href="https://wallet.meteorwallet.app" target="_blank" rel="noopener noreferrer">Get a NEAR Account{#snippet iconRight()}<ArrowUpRight class="w-3.5 h-3.5" />{/snippet}</ZenButton>
                <Tooltip text="On Circle's page choose NEAR Testnet and paste your account name." position="bottom">
                  <ZenButton variant="ghost" size="sm" href="https://faucet.circle.com" target="_blank" rel="noopener noreferrer">Get Test USDC{#snippet iconRight()}<ArrowUpRight class="w-3.5 h-3.5" />{/snippet}</ZenButton>
                </Tooltip>
                <ZenButton variant="ghost" size="sm" href={TEST_NEAR_URL} target="_blank" rel="noopener noreferrer">Get Test NEAR{#snippet iconRight()}<ArrowUpRight class="w-3.5 h-3.5" />{/snippet}</ZenButton>
              </div>
            {/if}
            {@render actions(true, 'Connect Wallet', walletReady, connect, 'This shares your account name. Nothing moves until you send.')}
          {:else}
            {@render accountRow()}
            <!-- Have versus need (Zarf's DeployStep3Connect), for the test USDC and for the NEAR; then one verdict -->
            <div class="grid grid-cols-2 gap-x-4 gap-y-5">
              {@render figure('You Have', balance !== null ? formatAmount(BigInt(balance)) : '…', UNIT, balance === null)}
              {@render figure('This Send', formatAmount(parsed.total), UNIT)}
              {@render figure('You Have', nearHave !== null ? sig3(nearHave) : '…', 'NEAR', nearHave === null, nearHave !== null ? formatNear(nearHave.toString()) : '')}
              {@render figure('Needs Free', nearNeed !== null ? sig3(nearNeed, true) : '…', 'NEAR', nearNeed === null, nearNeed !== null ? formatNear(nearNeed.toString()) : '')}
            </div>
            <div class="flex flex-col gap-2">
              {#if balanceFailed && balance === null}
                <div class="flex flex-wrap items-center justify-between gap-x-3">
                  <Note tone="error">Couldn't read your {UNIT} balance. Nothing was sent.</Note>
                  <ZenButton variant="ghost" size="sm" onclick={() => balanceTick++}>Check Again</ZenButton>
                </div>
              {:else if short > 0n}
                <div class="flex flex-wrap items-center justify-between gap-x-3">
                  <Note tone="error">{formatAmount(short)} {UNIT} short.</Note>
                  <span class="flex items-center gap-1">
                    {#if TESTNET}<ZenButton variant="ghost" size="sm" href="https://faucet.circle.com" target="_blank" rel="noopener noreferrer">Get Test USDC{#snippet iconRight()}<ArrowUpRight class="w-3.5 h-3.5" />{/snippet}</ZenButton>{/if}
                    <ZenButton variant="ghost" size="sm" onclick={() => balanceTick++}>Check Again</ZenButton>
                  </span>
                </div>
              {/if}
              {#if nearFailed && nearHave === null}
                <Note tone="info">Couldn't check your NEAR. Your wallet checks it when you send.</Note>
              {:else if nearShort > 0n}
                <div class="flex flex-wrap items-center justify-between gap-x-3">
                  <Note tone="error">About {nearUp(nearShort)} NEAR short, for storage and the network fee.</Note>
                  <span class="flex items-center gap-1">
                    {#if TESTNET}<ZenButton variant="ghost" size="sm" href={TEST_NEAR_URL} target="_blank" rel="noopener noreferrer">Get Test NEAR{#snippet iconRight()}<ArrowUpRight class="w-3.5 h-3.5" />{/snippet}</ZenButton>{/if}
                    <ZenButton variant="ghost" size="sm" onclick={() => balanceTick++}>Check Again</ZenButton>
                  </span>
                </div>
              {/if}
              {#if nearNeed !== null}
                <p class="text-xs text-zen-fg-subtle">Most of the NEAR comes back. Network fee {feeMax !== null ? `at most ${sig3(feeMax, true)}` : 'a small amount of'} NEAR{storageShort ? ', plus storage' : ''}.</p>
              {/if}
              {#if balance !== null && short === 0n && (nearHave !== null && nearNeed !== null ? nearShort === 0n : !(nearShort > 0n))}
                <p class="flex items-center gap-2 text-sm text-zen-fg" role="status"><CheckCircle2 class="w-4 h-4 text-zen-success shrink-0" aria-hidden="true" />Ready to send</p>
              {/if}
            </div>
            {@render actions(true, 'Continue', ready && short === 0n && balance !== null, prepare, balance === null && balanceFailed ? 'Check your balance first.' : '')}
          {/if}
        {:else}
          {@const d = draft!}
          {@const n = BigInt(d.recipients.length)}
          {@render stepHeader('Review', 'Check it once. A send cannot be undone.')}
          <!-- One DeploymentSummary card (Zarf create deploy/DeploymentSummary.svelte) -->
          <ZenCard variant="elevated" class="overflow-hidden !p-0">
            <div class="p-4 bg-zen-bg-elevated border-b border-zen-border-subtle flex justify-between items-center gap-3">
              <h2 class="font-bold text-sm uppercase tracking-wider text-zen-fg-subtle">Summary</h2>
              <Tooltip text="Emails never go on chain. Our verifier sees each one once, when that person claims." position="left">
                <button type="button" class="inline-flex items-center justify-center w-6 h-6 rounded-full text-zen-fg-subtle hover:text-zen-fg" aria-label="Who sees the emails: emails never go on chain. Our verifier sees each one once, when that person claims."><Info class="w-3.5 h-3.5" aria-hidden="true" /></button>
              </Tooltip>
            </div>
            <div class="p-6 grid grid-cols-1 gap-6">
              <div>
                <div class="text-xs font-semibold uppercase text-zen-fg-subtle mb-1">Asset</div>
                <div class="flex items-center gap-2">
                  <img src="/tokens/usdc.svg" alt="" class="w-8 h-8 rounded-full" />
                  <div class="min-w-0">
                    <div class="font-bold text-lg">{UNIT}</div>
                    {#if token}
                      <div class="flex items-center gap-1 text-xs font-mono text-zen-fg-subtle">
                        {#if explorerAccount}<a href="{explorerAccount}{token}" target="_blank" rel="noopener noreferrer" class="hover:text-zen-fg" title={token}>{token.slice(0, 6)}…{token.slice(-4)}</a>{:else}<span title={token}>{token.slice(0, 6)}…{token.slice(-4)}</span>{/if}
                        <CopyButton value={token} label="Copy token id" />
                      </div>
                    {/if}
                  </div>
                </div>
              </div>
              <div>
                <div class="text-xs font-semibold uppercase text-zen-fg-subtle mb-1">Total Allocation</div>
                <div class="text-xl font-bold tabular-nums">{formatAmount(BigInt(d.total))} <span class="text-sm font-normal text-zen-fg-subtle">{UNIT}</span></div>
                <div class="text-xs text-zen-fg-subtle">{d.recipients.length} {d.recipients.length === 1 ? 'Recipient' : 'Recipients'}</div>
              </div>
              <ul class="divide-y divide-zen-border-subtle border-y border-zen-border-subtle max-h-64 overflow-auto text-sm">
                {#each d.recipients as r (r.commitment)}
                  <li class="flex items-center gap-2 py-2">
                    <EmailMark email={r.email} /><span class="flex-1 min-w-0 break-all">{r.email}</span><span class="shrink-0 whitespace-nowrap tabular-nums text-zen-fg-muted">{formatAmount(BigInt(r.amount))}</span>
                  </li>
                {/each}
              </ul>
              {#if !pinned}<ZenButton variant="ghost" size="sm" class="justify-self-start -mt-3" onclick={() => ((draft = null), (uiStep = 0))} disabled={!!busy}>Edit</ZenButton>{/if}
              <div class="border-t border-zen-border-subtle pt-4 grid grid-cols-1 gap-4">
                {@render ledgerRow('Claims Close', `${shortWhen(deadlineMs)} ${zoneName(deadlineMs)}`)}
                {#if storageShort === null}
                  {@render ledgerRow('Storage', 'checking…')}
                {:else if costs && perClaim !== null && freePrepay !== null}
                  {@render ledgerRow(
                    'Storage',
                    storageShort > 0n ? `≈ ${sig3(storageShort, true)} NEAR` : 'From your Zarf balance',
                    `Up to ${nearUp(BigInt(costs.campaign_bytes_cost))} NEAR records this send; ${formatNear((n * perClaim).toString())} NEAR is held for the links (${formatNear(perClaim.toString())} each) and comes back for links nobody claims. Zarf balance now: ${formatNear(freePrepay.toString())} NEAR.`,
                  )}
                {/if}
                {@render ledgerRow('Network Fee', feeMax !== null ? `≤ ${sig3(feeMax, true)} NEAR` : 'a little NEAR')}
              </div>
              <p class="text-[11px] text-zen-fg-subtle">Unclaimed {UNIT} returns via Campaigns after the deadline.{#if !TESTNET}{' '}{CIRCLE_LINE}{/if}</p>
            </div>
          </ZenCard>

          {@render nameField()}

          <!-- Backup: the checkbox appears only once the file was saved (Zarf's DeployStep2Backup order) -->
          <div class="flex flex-wrap items-center justify-between gap-3" title="It rebuilds every link if this tab closes. It lists every email: keep it private.">
            {#if recoverySaved}<ZenCheckbox bind:checked={recoveryAck} disabled={phase > 0} label="I Saved the Backup" />{:else}<span class="text-sm text-zen-fg-muted">Backup of every link</span>{/if}
            <ZenButton variant="ghost" size="sm" onclick={saveRecovery} disabled={phase > 0}>{#snippet iconLeft()}<Download class="w-3.5 h-3.5" />{/snippet}{recoverySaved ? 'Download Again' : 'Download Backup'}</ZenButton>
          </div>

          <!-- Send. Every sub-state in Zarf's alert, each answering "where is my money?" in plain words, with one thing to do. -->
          {#if wrongAccount}
            {@render wrongAccountAlert()}
          {:else if txState === 'mismatch'}
            <ZenAlert variant="error">
              {#snippet title()}Don't Use These Links{/snippet}
              Zarf already holds a different send under them, so they can't work. Check Campaigns for what you sent, then make new links.
            </ZenAlert>
            <div class="flex flex-wrap items-center gap-3">
              <ZenButton variant="primary" onclick={startOver}>Make New Links</ZenButton>
              <ZenButton href="/campaigns" variant="ghost">Open Campaigns</ZenButton>
            </div>
          {:else if txState === 'unclear'}
            <ZenAlert variant="warning">
              {#snippet title()}Don't Send Again Yet{/snippet}
              Your {UNIT} is either held by Zarf or on its way back to your wallet; this send didn't make the links. Check again in a few minutes.
            </ZenAlert>
            <div class="flex flex-wrap items-center gap-4">
              <ZenButton variant="primary" onclick={recheck} disabled={!!busy}>Check Again</ZenButton>
              <span class="text-zen-fg-muted">{@render explorerLink(sentTx ?? '')}</span>
            </div>
          {:else}
            {#if error}
              <ZenAlert variant="error">
                {#snippet title()}{errorTitle}{/snippet}
                {error}{#if errorTitle.startsWith('Not sent') && storageShort !== null && storageShort > 0n}{' '}Any NEAR it added for storage stays in your Zarf balance for your next send; you can withdraw it in Campaigns.{/if}
                {#snippet actions()}{#if deadlineFix}<ZenButton variant="primary" size="sm" onclick={() => ((draft = null), (uiStep = 1), (error = errorTitle = errorCode = ''))}>Change Deadline</ZenButton>{/if}{/snippet}
              </ZenAlert>
            {/if}
            <!-- Zarf's action bar -->
            <div class="mt-4 pt-6 border-t border-zen-border-subtle flex flex-col gap-2">
              {#if !TESTNET}<Note tone="info">Real USDC. Check the amounts.</Note>{/if}
              <div class="flex items-center {pinned ? 'justify-end' : 'justify-between'} gap-3">
                {#if !pinned}<ZenButton variant="ghost" onclick={() => (draft = null)} disabled={!!busy}>Back</ZenButton>{/if}
                <ZenButton variant={deadlineFix ? 'secondary' : 'primary'} size="lg" class="px-8" disabled={!!sendBlocker || phase > 0} onclick={create}>Send {formatAmount(BigInt(d.total))} {UNIT}</ZenButton>
              </div>
              {#if phase === 0 && sendBlocker.trim()}
                <p class="text-xs text-zen-fg-muted text-right ml-auto max-w-60">{sendBlocker}</p>
              {:else if phase === 0 && txCount}
                <p class="text-xs text-zen-fg-subtle text-right ml-auto">{txCount === 2 ? 'Two wallet approvals.' : 'One wallet approval.'}</p>
              {/if}
            </div>
            {#if phase > 0}{@render pipeline()}{/if}
            {#if txState === 'checking' && !busy}
              <ZenAlert variant="warning">
                {#snippet title()}Checking with NEAR{/snippet}
                Your send may have gone out: your {UNIT} is either in your wallet or held by Zarf. Don't send again until this check finishes.
              </ZenAlert>
              <ZenButton variant="secondary" class="self-start" onclick={recheck}>Check Again</ZenButton>
            {:else if txState === 'settling'}
              <ZenAlert variant="warning">
                {#snippet title()}Making Sure Nothing Was Sent Twice{/snippet}
                The last try was refunded to your wallet. One more check in about 90 seconds, in case an earlier try went through.
              </ZenAlert>
            {/if}
          {/if}
          {#if previewEmail}
            <!-- Phones: the message after the action bar, one tap away; desktop shows it in the right column -->
            <details class="lg:hidden group text-sm">
              <summary class="inline-flex items-center gap-1.5 py-1 cursor-pointer list-none text-zen-fg-muted hover:text-zen-fg">Preview Message <ChevronDown class="w-3.5 h-3.5 transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
              <div class="mt-3">{@render messageCard(previewEmail, message(d.recipients[0], `${claimHost}/claim/…`))}</div>
            </details>
          {/if}
        {/if}

        {#if error && step !== 3}<Note tone="error">{error}</Note>{/if}
      </section>

      {#if step < 3}
        <!-- Live Preview (Zarf create step-1:330-345): what the first recipient will see, the claim card in miniature -->
        <aside class="w-full min-w-0 lg:flex-1 lg:max-w-2xl lg:sticky lg:top-24" aria-label="Preview of a claim">
          <div class="flex items-center gap-2 mb-4 text-xs font-semibold uppercase tracking-wider text-zen-fg-subtle ml-1"><Eye class="w-3.5 h-3.5" aria-hidden="true" /> Live Preview</div>
          <ZenCard variant="elevated" class="!rounded-3xl !p-6 sm:!p-8">
            <div class="space-y-8 {parsed.rows.length ? '' : 'opacity-50'}" aria-hidden="true">
              <div class="flex items-start gap-4">
                <div class="w-12 h-12 rounded-full bg-zen-primary/10 text-zen-primary flex items-center justify-center shrink-0"><Mail class="w-6 h-6" /></div>
                <div class="min-w-0">
                  <div class="text-xl font-semibold">{TESTNET ? 'Claim Your Test USDC' : 'Claim Your USDC'}</div>
                  <div class="text-sm text-zen-fg-muted font-light mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span class="inline-flex items-center gap-1.5 min-w-0">{#if account}<Avatar name={account} /><span class="font-mono truncate">{account}</span>{:else}From you{/if}</span>
                    {#if previewLeft}<span class="tabular-nums whitespace-nowrap">{previewLeft}</span>{/if}
                  </div>
                </div>
              </div>
              <AmountPanel label="Claim Amount" value={previewAmount} unit={UNIT} />
              <div class="space-y-3">
                <div class="pl-1 text-xs font-bold uppercase tracking-widest text-zen-fg-subtle">NEAR Account</div>
                <div class="rounded-[var(--zen-radius-input)] border-[0.5px] border-zen-border px-4 py-3 text-zen-fg-subtle">{TESTNET ? 'their-name.testnet' : 'their-name.near'}</div>
              </div>
              <div class="flex items-center justify-center rounded-full bg-zen-fg text-zen-bg text-sm font-medium h-11"><GoogleG />Sign in with Google</div>
            </div>
          </ZenCard>
        </aside>
      {:else if previewEmail && draft}
        <aside class="hidden lg:block w-full min-w-0 lg:flex-1 lg:max-w-2xl lg:sticky lg:top-24" aria-label="Preview of the message">
          <div class="flex items-center gap-2 mb-4 text-xs font-semibold uppercase tracking-wider text-zen-fg-subtle ml-1"><Eye class="w-3.5 h-3.5" aria-hidden="true" /> Message Preview</div>
          {@render messageCard(previewEmail, message(draft.recipients[0], `${claimHost}/claim/…`))}
          <p class="mt-3 ml-1 text-xs text-zen-fg-subtle">Each person gets their own link after you send.</p>
        </aside>
      {/if}
    </div>
  {/if}
</div>
