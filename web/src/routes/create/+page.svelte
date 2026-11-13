<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { env } from '$env/dynamic/public';
  import { takeBackup } from '$lib/create/campaigns';
  import { buildDraft, claimLink, LONG_LINKS_ABOVE, mailtoHref, messageText, readRecoveryFile, recoveryFile, type Draft } from '$lib/create/campaign';
  import { saveSent } from '$lib/create/campaigns';
  import { getAccount, getCampaignByRoot, getCampaignView, getConfig, getGasPrice, getHeight, getPrepayBalance, getStorageCosts, txOutcome, type ContractConfig } from '$lib/create/chain';
  import {
    AccountChanged, attachedGas, checkCreation, fundCampaign, fundsShort, LookupPending, mayCreate, minDeadlineMs, nearNeeded, NotCreated, NotSent, OutcomeUnclear, ownerKeySlack,
    prepayShortfall, readMarker, releaseAfterReject, resolveByRoot, sendHooks, spendableNear, WAITING_FOR_WALLET, walletWaitNote,
    type StorageCosts, type UnresolvedMarker,
  } from '$lib/create/funding';
  import { saveFile } from '$lib/create/publish';
  import { formatAmount, sendCapError } from '$lib/create/recipients';
  import { checkGrid, googleWarning, gridRules, isBlankRow, parsePaste, type GridRow } from '$lib/create/grid';
  import RecipientAllocationGrid from '$lib/zarf-kit/create/RecipientAllocationGrid.svelte';
  import RecipientImportControls from '$lib/zarf-kit/create/RecipientImportControls.svelte';
  import { nearConnectWallet, type SenderWallet } from '$lib/create/wallet';
  import { deadlineText, timeLeft } from '$lib/claim';
  import { formatNear, sig3 } from '$lib/create/campaigns';
  import { getClaimState, nearView, type ClaimState } from '$lib/services';
  import { CIRCLE_LINE, TESTNET, UNIT } from '$lib/network';
  import { ArrowRight, ArrowUpRight, Check, CheckCircle2, ChevronDown, Copy, Download, ExternalLink, Eye, Lock, Mail, Plus, RefreshCw } from 'lucide-svelte';
  import ClaimCard, { type ClaimMode } from '$lib/ClaimCard.svelte';
  import Mark from '$lib/Mark.svelte';
  import { MARKS } from '$lib/chains';
  import { passkeyOffered } from '$lib/passkey';
  import { crossChainOffered } from '$lib/intents';
  import Avatar from '$lib/Avatar.svelte';
  import CopyButton from '$lib/CopyButton.svelte';
  import EmailMark from '$lib/EmailMark.svelte';
  import Steps from '$lib/Steps.svelte';
  import MicroStepProgress from '$lib/create/MicroStepProgress.svelte';
  import Tooltip from '$lib/zarf-kit/components/ui/Tooltip.svelte';
  import ZenBadge from '$lib/zarf-kit/components/ui/ZenBadge.svelte';
  import ZenInput from '$lib/zarf-kit/components/ui/ZenInput.svelte';
  import FundFromChain from '$lib/create/FundFromChain.svelte';
  import { swapIn } from '$lib/motion';
  import Note from '$lib/Note.svelte';
  import ZenAlert from '$lib/zarf-kit/components/ui/ZenAlert.svelte';
  import ZenButton from '$lib/zarf-kit/components/ui/ZenButton.svelte';
  import ZenCard from '$lib/zarf-kit/components/ui/ZenCard.svelte';
  import ZenCheckbox from '$lib/zarf-kit/components/ui/ZenCheckbox.svelte';

  const rpc = env.PUBLIC_NEAR_RPC_URL;
  // NEAR's own page for free testnet NEAR (the sender needs a little for storage and fees).
  const TEST_NEAR_URL = 'https://docs.near.org/getting-started/faucet';
  const contract = env.PUBLIC_CONTRACT_ID;
  const token = env.PUBLIC_TOKEN_ID;

  let gridRows = $state<GridRow[]>([{ email: '', amount: '' }]);
  const parsed = $derived(checkGrid(gridRows));
  let grid = $state<{ focusIdentifier: (i: number) => Promise<void> }>();
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
  /** Zarf's Add Row: a blank row at the end, focused (the grid scrolls it into view). */
  function addRow() {
    const rows = gridRows.length ? gridRows : [{ email: '', amount: '' }];
    gridRows = [...rows, { email: '', amount: '' }];
    void grid?.focusIdentifier(gridRows.length - 1);
  }
  function clearRows() {
    cleared = $state.snapshot(gridRows);
    gridRows = [{ email: '', amount: '' }];
    skipped = [];
  }
  const notGmail = $derived(googleWarning(parsed.rows)); // red team #2: shown before funding, never a block
  let config = $state<ContractConfig | null>(null);
  let setupError = $state('');
  let setupRetry = $state(false);
  let deadline = $state(''); // datetime-local, the sender's time zone
  let wallet: SenderWallet | null = null;
  let walletReady = $state(false); // the wallet module loads after the config; Connect waits for it
  let account = $state<string | null>(null);
  let walletId = $state<string | null>(null); // 'ethereum-wallets' is MetaMask (NEP-518)
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
  let rejectedFree = $state(false); // the wallet was rejected and no campaign exists for this root: offer "Change the list"
  let walletSince = $state<number | null>(null); // when the wallet window opened (phase 1), for the reload hint
  let now = $state(Date.now());
  let txState = $state<'checking' | 'settling' | 'unclear' | 'mismatch' | null>(null);
  // Once a send may have gone out, this draft (its merkle_root) is pinned: re-sending the same root is
  // safe (E132 refunds a duplicate), a new draft is not. Unpinned only by a campaign or a proven refund.
  let pinned = $state(false);
  let hadUncertain = false;
  // A send that may have gone out with no outcome: the chain height when it was lost (null: not read yet). The draft
  // stays pinned until that send can no longer land (funding.ts releaseAfterReject, red team #13).
  let lostAt: number | null | undefined = undefined;
  const HELD = 'An earlier send of this list may still land for up to a day, so until then only this list can be sent. Sending it again is safe.';
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
    lostAt?: number | null; // see lostAt
  }
  /** True if persisted. Before a send it must succeed (see beforeSend); later writes are best effort. */
  const saveFunding = (f: Funding): boolean => {
    try {
      sessionStorage.setItem(FUNDING_KEY, JSON.stringify({ ...f, lostAt }));
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
      choose(PICKS.find((d) => pickOk(d)) ?? 'date'); // 1 Week on testnet; mainnet's 30-day minimum starts at 1 Month
      wallet = await nearConnectWallet(config.network, rpc, { ethereum: true }); // MetaMask senders (T-025)
      walletReady = true;
      account = wallet.accountId();
      walletId = wallet.walletId();
      wallet.onChange((a, id) => ((account = a), (walletId = id))); // sign-in/out NEAR Connect reports in this page
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
        lostAt = f.lostAt ?? (f.uncertain || !f.txHash ? null : undefined); // no hash: reloaded while the wallet was open
        if (f.campaignId) result = { campaignId: f.campaignId, txHash: f.txHash ?? '' };
        else if (f.txHash) await check(f.txHash);
        else await checkByRoot(); // reloaded while the wallet popup was open
      }
      const backup = f ? null : takeBackup();
      if (backup) await openBackup(backup);
    } catch {
      setupError = "Couldn't reach NEAR. Nothing was sent.";
      setupRetry = true;
    }
  });

  async function connect() {
    error = errorTitle = '';
    try {
      account = await wallet!.signIn();
      walletId = wallet!.walletId();
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
   * A backup file chosen on /campaigns (takeBackup): it rebuilds the links of a campaign this account already funded.
   * Read-only: it finds the campaign by (sender, merkle_root) and shows the done page; nothing is sent.
   */
  async function openBackup(text: string) {
    error = errorTitle = errorCode = '';
    try {
      const { draft: d } = await readRecoveryFile(text, { contractId: contract!, network: config!.network });
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
    lostAt = undefined; // the root is taken: a lost send of it can only be refunded (E132)
    setMarker(null);
    saveFunding({ txHash: r.txHash, sender: sentFrom ?? account!, draft: draft!, deadline, campaignId: r.campaignId });
    try {
      saveSent(localStorage, contract!, { campaignId: r.campaignId, firstEmail: draft!.recipients[0].email, count: draft!.recipients.length, createdAt: Date.now() });
    } catch {
      // no localStorage: /campaigns shows the amount line
    }
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
      if (lostAt === null) {
        lostAt = await getHeight(rpc!).catch(() => null); // unread: taken again at release, later, which only holds longer
        if (lostAt !== null && draft && sentFrom) saveFunding({ txHash: null, sender: sentFrom, draft, deadline, uncertain: hadUncertain });
      }
      const id = await resolveByRoot(byRoot(), { merkleRoot: draft!.merkleRoot, total: draft!.total });
      if (id) {
        await created({ campaignId: id, txHash: sentTx ?? '' });
      } else {
        // Not landed (yet). Keep the draft pinned: only the same root may be sent again.
        sentTx = txState = null;
        rejectedFree = true;
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
    } else if (e instanceof AccountChanged) {
      // Refused before signing: nothing was sent. Another tab switched the wallet's account.
      errorTitle = 'Nothing was sent';
      error = `Your wallet switched to another account. Reconnect ${e.expected} to send.`;
      rejectedFree = true; // beforeSend already pinned the list: offer Change the list (it re-checks by root first)
    } else if (e instanceof NotSent) {
      errorTitle = 'Nothing was sent';
      error = 'This browser blocked site storage. Allow it and try again.';
    } else if (e instanceof NotCreated) {
      // Proven for this tx: the tokens are back (or never left).
      const msg = ERRORS[e.code] ?? `The contract refused it (${e.code}).`;
      errorCode = e.code;
      if (hadUncertain || lostAt !== undefined) void unpinAfterSecondLook(msg);
      else unpin(msg);
    } else if (sentTx) {
      txState = 'checking';
    } else {
      // SendUncertain or any other failure without a hash: remember it, then ask the contract.
      hadUncertain = true;
      lostAt ??= null;
      if (draft && sentFrom) saveFunding({ txHash: null, sender: sentFrom, draft, deadline, uncertain: true });
      void checkByRoot();
    }
  }

  /** A proven refund (NotCreated): the tokens are back in the wallet, so the title says so. */
  function unpin(msg: string) {
    sentTx = txState = null;
    pinned = hadUncertain = false;
    lostAt = undefined;
    clearFunding();
    setMarker(null);
    errorTitle = `Not sent: your ${UNIT} is back in your wallet`;
    error = msg;
  }

  const lost = () => ({ lostAt, height: () => getHeight(rpc!) });
  /** A lost send can still land: keep the list pinned and say why (red team #13). */
  function hold(at: number, title: string, msg: string) {
    lostAt = at;
    sentTx = txState = null;
    if (draft && sentFrom) saveFunding({ txHash: null, sender: sentFrom, draft, deadline, uncertain: hadUncertain });
    errorTitle = title;
    error = msg;
  }

  /** "Change the list" after a rejected wallet: let the draft go only once no earlier send can still land. */
  async function changeAfterReject() {
    rejectedFree = false;
    txState = 'settling';
    error = errorTitle = '';
    try {
      const r = await releaseAfterReject(byRoot(), { merkleRoot: draft!.merkleRoot, total: draft!.total }, lost());
      if (r.kind === 'created') {
        await created({ campaignId: r.campaignId, txHash: sentTx ?? '' });
        return;
      }
      if (r.kind === 'held') return hold(r.lostAt, 'This List Stays Locked for Now', HELD);
      sentTx = txState = null;
      pinned = hadUncertain = false;
      lostAt = undefined;
      clearFunding();
      setMarker(null);
      draft = null;
      uiStep = 0; // back to the list, as Edit does
    } catch (e) {
      txState = (e as Error).message === 'CAMPAIGN_MISMATCH' ? 'mismatch' : 'checking';
    }
  }

  /** An earlier send's outcome was lost, so it may still land: look by root once more before unpinning. */
  async function unpinAfterSecondLook(msg: string) {
    txState = 'settling'; // its own state: create()'s finally clears `busy` while this runs
    try {
      const r = await releaseAfterReject(byRoot(), { merkleRoot: draft!.merkleRoot, total: draft!.total }, lost());
      if (r.kind === 'created') await created({ campaignId: r.campaignId, txHash: sentTx ?? '' });
      else if (r.kind === 'held') hold(r.lostAt, `Not sent: your ${UNIT} is back in your wallet`, `${msg} ${HELD}`);
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
    busy = WAITING_FOR_WALLET;
    rejectedFree = false;
    try {
      const d = draft!;
      const hooks = sendHooks({
        set: (p) => {
          if (p.sentTx !== undefined) sentTx = p.sentTx;
          if (p.busy !== undefined) busy = p.busy;
        },
        uncertain: () => hadUncertain,
        save: (r) => saveFunding({ txHash: r.txHash, sender: account!, draft: d, deadline, uncertain: r.uncertain }),
        pin: () => {
          sentFrom = account;
          pinned = true;
          setMarker({ root: d.merkleRoot, sender: account!, total: d.total, at: Date.now() });
        },
      });
      await created(
        await fundCampaign(
          {
            sender: account!, contractId: contract!, tokenId: token!, storageByteCost: config!.storage_byte_cost,
            costs: () => getStorageCosts(rpc!, contract!, token!),
            freePrepay: () => getPrepayBalance(rpc!, contract!, account!),
            send: (txs) => wallet!.send(txs),
            campaignByRoot: byRoot().campaignByRoot,
            campaign: byRoot().campaign,
            ...hooks,
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
    pinned = recoverySaved = recoveryAck = copied = hadUncertain = false;
    lostAt = undefined;
    error = errorTitle = errorCode = '';
    gridRows = [{ email: '', amount: '' }];
    skipped = [];
    cleared = null;
    claims = [];
    previewRow = 0;
    uiStep = 0;
  }

  // Wizard (blue-team UX: the deadline sits under the list, so three steps): the first two are local; Review follows
  // the draft, the links page the result.
  const STEPS = ['Recipients', 'Pay', 'Review'];
  let uiStep = $state(0);
  const step = $derived(result && draft ? 3 : draft ? 2 : uiStep);
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
  // The claim page's own choices (claim/[campaign]/[commitment]/+page.svelte MODES), from the same flags
  const previewModes = $derived([
    ['existing', 'NEAR Account'],
    ...(env.PUBLIC_IMPLICIT_ACCOUNTS === 'on' ? [['new', passkeyOffered(config?.network ?? (TESTNET ? 'testnet' : ''), env.PUBLIC_IMPLICIT_ACCOUNTS, env.PUBLIC_PASSKEY_ACCOUNTS) ? 'Face ID' : 'New Account']] : []),
    ...(crossChainOffered(config?.network ?? (TESTNET ? 'testnet' : 'mainnet'), env.PUBLIC_CROSS_CHAIN) ? [['chain', 'Other Chain']] : []),
  ] as [ClaimMode, string][]);
  const previewAmount = $derived(parsed.rows[0] ? formatAmount(BigInt(parsed.rows[0].amount)) : '10');
  const previewEmail = $derived(draft?.recipients[0]?.email ?? parsed.rows[0]?.email ?? null);
  /** "GMT+3": the sender's own time zone, which every date on this page is in. */
  const zoneName = (ms: number) => new Intl.DateTimeFormat('en-GB', { timeZoneName: 'short' }).formatToParts(ms).find((p) => p.type === 'timeZoneName')?.value ?? '';
  /** "Thu 19 Nov, 06:20" */
  const shortWhen = (ms: number) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(ms);
  const previewLeft = $derived(Number.isFinite(deadlineMs) ? timeLeft(deadlineMs, Date.now()) : '');

  // Deadline (owner rule, 14 Nov): exactly 1 Week · 1 Month · 1 Year, plus Custom Date. A pick shorter than the
  // contract's minimum lifetime (mainnet: 30 days) stays visible but disabled, with one short reason. An hour of slack
  // keeps a pick valid until it lands.
  const DAY = 86_400_000;
  const PICKS = [7, 30, 365] as const;
  const PICK_LABEL: Record<number, string> = { 7: '1 Week', 30: '1 Month', 365: '1 Year' };
  const minLifetimeDays = $derived(config ? Number(BigInt(config.min_lifetime_ns) / 1_000_000n) / DAY : 0);
  const pickOk = (d: number) => !!config && d * DAY >= Number(BigInt(config.min_lifetime_ns) / 1_000_000n);
  const tooShort = $derived(config ? PICKS.filter((d) => !pickOk(d)) : []);
  // Radiogroup keys on the deadline pills: arrows move the choice and the focus over the enabled ones, as native radios do.
  function pickKey(e: KeyboardEvent) {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const all = PICKS.filter((p) => pickOk(p));
    if (!all.length) return;
    const i = pick === 'date' ? (d > 0 ? -1 : all.length) : all.indexOf(pick as (typeof PICKS)[number]);
    choose(all[(i + d + all.length) % all.length]);
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
  const WAITING = WAITING_FOR_WALLET;
  // (T-012 finding 5) a wallet that never answers: after ~2 min in phase 1, suggest a reload (it recovers by root).
  $effect(() => {
    if (busy !== WAITING) {
      walletSince = null;
      return;
    }
    walletSince = Date.now();
    const t = setInterval(() => (now = Date.now()), 5_000);
    return () => clearInterval(t);
  });
  const waitNote = $derived(walletWaitNote(walletSince, now));
  /** The sending pipeline's current row: 1 the wallet, 2 the chain. 0: not sending. */
  const phase = $derived(busy === WAITING ? 1 : busy || sentTx || txState === 'checking' || txState === 'settling' ? 2 : 0);
  const sendBlocker = $derived(
    wrongAccount ? ' ' /* the wrong-account warning says it; one message */ : !recoverySaved ? 'Download the links first.' : !recoveryAck ? "Tick the box once they're saved." : !sendable.ok ? sendable.reason : '',
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
    {#if walletId === 'ethereum-wallets'}<p class="text-xs text-zen-fg-muted">MetaMask opens a NEAR account. It pays with USDC on NEAR.</p>{/if}
  {/if}
{/snippet}

{#snippet usdcChip()}
  <!-- Zarf's token chip (create wizard step-1:230-250): one token, so no "Change" -->
  <span class="inline-flex items-center gap-2 bg-zen-fg/5 rounded-full pl-1.5 pr-3 py-1 border border-zen-border-subtle">
    <Mark svg={MARKS.usdc} class="w-5 h-5" />
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
    <span class="text-sm text-zen-fg-subtle">{label}</span>
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
  <ZenInput label="Your Name (Optional)" bind:value={senderName} maxlength={60} autocomplete="name" placeholder="Your name" hint="Signs the message. Stays in this browser." />
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
        {#if waitNote}<span class="text-sm text-zen-fg-muted">{waitNote}</span>{/if}
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
    <div class="text-sm text-zen-fg-subtle shrink-0">{label}</div>
    <div class="font-medium text-sm text-right tabular-nums" title={exact || undefined}>{value}</div>
  </div>
{/snippet}

{#snippet deadlineRow()}
  <!-- Claims close: Zarf's duration pills (create VestingDurationPicker.svelte:55-75), radiogroup keys kept; Custom Date behind one link -->
  <div class="flex flex-col gap-3 pt-6 border-t border-zen-border-subtle">
    <span id="deadline-l" class="text-sm text-zen-fg-muted">Claims Close In</span>
    <div class="flex flex-wrap items-center gap-2" role="radiogroup" aria-labelledby="deadline-l" tabindex="-1" onkeydown={pickKey}>
      {#each PICKS as p (p)}
        <ZenButton
          variant={pick === p ? 'primary' : 'ghost'}
          size="sm"
          class="px-3 rounded-full text-xs font-medium"
          role="radio"
          aria-checked={pick === p}
          tabindex={pick === p ? 0 : -1}
          disabled={!pickOk(p)}
          data-pick={p}
          onclick={() => choose(p)}
        >{PICK_LABEL[p]}</ZenButton>
      {/each}
      <button type="button" class="text-xs text-zen-fg-muted underline underline-offset-2 hover:text-zen-fg px-2 {pick === 'date' ? 'text-zen-fg' : ''}" aria-pressed={pick === 'date'} onclick={() => choose('date')}>Custom Date</button>
    </div>
    {#if tooShort.length}<p class="text-xs text-zen-fg-subtle">{tooShort.map((d) => PICK_LABEL[d]).join(', ')}: this contract needs at least {Math.round(minLifetimeDays)} days.</p>{/if}
    {#if pick === 'date'}
      <ZenInput id="deadline" type="datetime-local" aria-label="Claims close" bind:value={deadline} disabled={!!draft} aria-describedby="deadline-note" />
    {/if}
    <div id="deadline-note">
      {#if minMs !== null && deadline && !deadlineOk}
        <Note tone="error">Pick a time after {shortWhen(minMs)}.</Note>
      {:else if Number.isFinite(deadlineMs)}
        <p class="text-sm text-zen-fg-muted tabular-nums" title="Your time zone ({zoneName(deadlineMs)}). Fixed once you send.">Claims close {shortWhen(deadlineMs)} {zoneName(deadlineMs)}. Then you take back the rest.</p>
      {/if}
    </div>
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
            <span class="text-sm text-zen-fg-muted inline-flex items-center gap-1.5">
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
            {@render messageCard(shown.r.email, message(shown.r, `${claimHost}/claim/${result.campaignId}/${shown.r.commitment.slice(0, 8)}…`))}
          </div>
        </aside>
      {/if}
    </div>
  {:else}
    <div class="flex flex-col lg:flex-row lg:items-start gap-10 lg:gap-8 xl:gap-12">
      <section class="w-full lg:max-w-xl lg:shrink-0 flex flex-col gap-8" aria-labelledby="step-h">
        {#if step === 0}
          {@render stepHeader('Recipients', '')}
          <div class="flex flex-col gap-3">
            <!-- Zarf's recipients editor as components (apps/create/src/lib/components/recipients/RecipientImportControls.svelte,
                 RecipientAllocationGrid.svelte), used the way DistributionRecipients.svelte:236-269 uses them -->
            <RecipientImportControls
              hasRows={gridRows.some((r) => !isBlankRow(r))}
              pasteHelp="One email and amount per line, or just emails."
              pastePlaceholder="alice@gmail.com,10&#10;bob@gmail.com,25"
              errors={skipped}
              onAddRow={addRow}
              onClear={clearRows}
              onParseText={(t) => addPasted(t)}
              onImportFile={async (f) => addPasted(await f.text())}
              onDismissErrors={() => (skipped = [])}
            />
            <RecipientAllocationGrid
              bind:this={grid}
              bind:rows={gridRows}
              identifierLabel="Email"
              identifierPlaceholder="name@gmail.com"
              identifierInputType="email"
              tokenSymbol={UNIT}
              rules={gridRules}
              withIdentifier={(r, v) => ({ ...r, email: v })}
              withAmount={(r, v) => ({ ...r, amount: v })}
              onRowsEdited={() => (cleared = null)}
              blankRow={{ email: '', amount: '' }}
              undoLabel={cleared && !gridRows.some((r) => !isBlankRow(r)) ? 'List cleared.' : null}
              onUndo={() => ((gridRows = cleared!), (cleared = null))}
              summaryItems={[{ label: 'Recipients', value: parsed.rows.length }, { label: 'Total', value: formatAmount(parsed.total), suffix: UNIT }]}
            />
            {#if notGmail}<ZenAlert variant="warning" icon={Mail}>{notGmail}</ZenAlert>{/if}
            {#if capError}<Note tone="error">{capError}</Note>{/if}
          </div>
          {@render deadlineRow()}
          {@render actions(false, 'Continue', recipientsOk && deadlineOk, () => (uiStep = 1), recipientsOk ? (deadlineOk ? '' : 'Pick when claims close.') : capError ? 'Up to 100 USDC per send.' : parsed.rejected.length ? `Fix row ${parsed.rejected[0].line} first.` : 'Add a recipient first.' /* T-010 review minor 2 */)}
        {:else if step === 1}
          {@render stepHeader('Pay', '')}
          {#if !account}
            {#if TESTNET}
              <div class="flex flex-wrap gap-2">
                <a href="https://wallet.meteorwallet.app" target="_blank" rel="noopener noreferrer"><ZenButton variant="ghost" size="sm" tabindex={-1}>Get a NEAR Account{#snippet iconRight()}<ArrowUpRight class="w-3.5 h-3.5" />{/snippet}</ZenButton></a>
                <a href="https://faucet.circle.com" target="_blank" rel="noopener noreferrer" title="On Circle's page choose NEAR Testnet and paste your account name."><ZenButton variant="ghost" size="sm" tabindex={-1}>Get Test USDC{#snippet iconRight()}<ArrowUpRight class="w-3.5 h-3.5" />{/snippet}</ZenButton></a>
                <a href={TEST_NEAR_URL} target="_blank" rel="noopener noreferrer"><ZenButton variant="ghost" size="sm" tabindex={-1}>Get Test NEAR{#snippet iconRight()}<ArrowUpRight class="w-3.5 h-3.5" />{/snippet}</ZenButton></a>
              </div>
            {/if}
            {@render actions(true, 'Connect Wallet', walletReady, connect, 'This shares your account name. Nothing moves until you send.')}
          {:else}
            {@render accountRow()}
            <!-- One verdict line (blue-team UX gap 7); the have/need figures sit under Details -->
            <div class="flex flex-col gap-2">
              {#if balanceFailed && balance === null}
                <div class="flex flex-wrap items-center justify-between gap-x-3">
                  <Note tone="error">Couldn't read your {UNIT} balance. Nothing was sent.</Note>
                  <ZenButton variant="ghost" size="sm" onclick={() => balanceTick++}>Check Again</ZenButton>
                </div>
              {:else if balance === null}
                <p class="text-sm text-zen-fg-muted" role="status">Checking your balance…</p>
              {:else if short > 0n}
                <div class="flex flex-wrap items-center justify-between gap-x-3">
                  <Note tone="error">Short by {formatAmount(short)} {UNIT} on NEAR.</Note>
                  <span class="flex items-center gap-1">
                    {#if TESTNET}<a href="https://faucet.circle.com" target="_blank" rel="noopener noreferrer"><ZenButton variant="ghost" size="sm" tabindex={-1}>Get Test USDC{#snippet iconRight()}<ArrowUpRight class="w-3.5 h-3.5" />{/snippet}</ZenButton></a>{/if}
                    <ZenButton variant="ghost" size="sm" onclick={() => balanceTick++}>Check Again</ZenButton>
                  </span>
                </div>
              {:else}
                <p class="flex items-center gap-2 text-sm text-zen-fg" role="status"><CheckCircle2 class="w-4 h-4 text-zen-success shrink-0" aria-hidden="true" />Ready · {formatAmount(parsed.total)} {UNIT} on NEAR</p>
              {/if}
              {#if nearFailed && nearHave === null}
                <Note tone="info">Couldn't check your NEAR. Your wallet checks it when you send.</Note>
              {:else if nearShort > 0n}
                <div class="flex flex-wrap items-center justify-between gap-x-3">
                  <Note tone="error">Also about {nearUp(nearShort)} NEAR short, for storage and the network fee.</Note>
                  <span class="flex items-center gap-1">
                    {#if TESTNET}<a href={TEST_NEAR_URL} target="_blank" rel="noopener noreferrer"><ZenButton variant="ghost" size="sm" tabindex={-1}>Get Test NEAR{#snippet iconRight()}<ArrowUpRight class="w-3.5 h-3.5" />{/snippet}</ZenButton></a>{/if}
                    <ZenButton variant="ghost" size="sm" onclick={() => balanceTick++}>Check Again</ZenButton>
                  </span>
                </div>
              {:else}
                <p class="text-xs text-zen-fg-subtle">Storage and the network fee are paid in NEAR from this account, whichever chain the USDC comes from.</p>
              {/if}
              <details class="group text-sm">
                <summary class="inline-flex items-center gap-1.5 py-1 cursor-pointer list-none text-zen-fg-muted hover:text-zen-fg">Details <ChevronDown class="w-3.5 h-3.5 transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
                <div class="mt-3 grid grid-cols-2 gap-x-4 gap-y-5">
                  {@render figure('You Have', balance !== null ? formatAmount(BigInt(balance)) : '…', UNIT, balance === null)}
                  {@render figure('This Send', formatAmount(parsed.total), UNIT)}
                  {@render figure('You Have', nearHave !== null ? sig3(nearHave) : '…', 'NEAR', nearHave === null, nearHave !== null ? formatNear(nearHave.toString()) : '')}
                  {@render figure('Needs Free', nearNeed !== null ? sig3(nearNeed, true) : '…', 'NEAR', nearNeed === null, nearNeed !== null ? formatNear(nearNeed.toString()) : '')}
                </div>
                {#if nearNeed !== null}
                  <p class="mt-3 text-xs text-zen-fg-subtle">Network fee {feeMax !== null ? `at most ${sig3(feeMax, true)}` : 'a small amount of'} NEAR{storageShort ? ', plus storage' : ''}. Storage for links nobody claims comes back to your Zarf balance.</p>
                {/if}
              </details>
            </div>
            {#if balance !== null && contract && config && crossChainOffered(config.network, env.PUBLIC_CROSS_CHAIN)}
              <!-- Pay With: USDC on NEAR, or another chain through 1Click into this account (T-019, T-025); the send itself is unchanged.
                   Mainnet: behind PUBLIC_CROSS_CHAIN, like the claim page (T-032) -->
              <FundFromChain {account} {contract} need={short} testnet={TESTNET} onArrived={() => balanceTick++} />
            {/if}
            {@render actions(true, 'Continue', ready && short === 0n && balance !== null, prepare, balance === null && balanceFailed ? 'Check your balance first.' : '')}
          {/if}
        {:else}
          {@const d = draft!}
          {@const n = BigInt(d.recipients.length)}
          {@render stepHeader('Review', '')}
          <!-- One summary ledger (Zarf create deploy/DeploymentSummary.svelte), its header strip and eyebrows dropped (waste filter) -->
          <ZenCard variant="elevated" padding="md">
            <div class="grid grid-cols-1 gap-5">
              <div class="flex items-baseline gap-2">
                <span class="text-3xl font-light tracking-tighter tabular-nums">{formatAmount(BigInt(d.total))}</span>
                <span class="text-xs font-medium uppercase tracking-widest text-zen-primary">{UNIT}</span>
                <span class="ml-auto text-sm text-zen-fg-muted">{d.recipients.length} {d.recipients.length === 1 ? 'Recipient' : 'Recipients'}</span>
              </div>
              <ul class="divide-y divide-zen-border-subtle border-y border-zen-border-subtle max-h-64 overflow-auto text-sm">
                {#each d.recipients as r (r.commitment)}
                  <li class="flex items-center gap-2 py-2">
                    <EmailMark email={r.email} /><span class="flex-1 min-w-0 break-all">{r.email}</span><span class="shrink-0 whitespace-nowrap tabular-nums text-zen-fg-muted">{formatAmount(BigInt(r.amount))}</span>
                  </li>
                {/each}
              </ul>
              {#if !pinned}<ZenButton variant="ghost" size="sm" class="justify-self-start -mt-3" onclick={() => ((draft = null), (uiStep = 0))} disabled={!!busy}>Edit</ZenButton>{/if}
              <div class="grid grid-cols-1 gap-3">
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
              <details class="group text-xs text-zen-fg-subtle">
                <summary class="inline-flex items-center gap-1.5 py-1 cursor-pointer list-none hover:text-zen-fg">Details <ChevronDown class="w-3.5 h-3.5 transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
                <div class="mt-2 flex flex-col gap-2">
                  {#if token}
                    <span class="flex items-center gap-1 font-mono">
                      {#if explorerAccount}<a href="{explorerAccount}{token}" target="_blank" rel="noopener noreferrer" class="hover:text-zen-fg" title={token}>{token.slice(0, 6)}…{token.slice(-4)}</a>{:else}<span title={token}>{token.slice(0, 6)}…{token.slice(-4)}</span>{/if}
                      <CopyButton value={token} label="Copy token id" />
                    </span>
                  {/if}
                  <span>Emails never go on chain. Our verifier sees each one once, when that person claims.</span>
                  <span>Unclaimed {UNIT} returns via Campaigns after the deadline.{#if !TESTNET}{' '}{CIRCLE_LINE}{/if}</span>
                </div>
              </details>
            </div>
          </ZenCard>

          {@render nameField()}

          <!-- Backup (blue-team UX): one Download Links action and one checkbox; still required before Send -->
          <div class="flex flex-wrap items-center justify-between gap-3" title="It rebuilds every link if this tab closes. It lists every email: keep it private.">
            <ZenCheckbox bind:checked={recoveryAck} disabled={!recoverySaved || phase > 0} label="I Saved the Links" />
            <ZenButton variant="ghost" size="sm" onclick={saveRecovery} disabled={phase > 0}>{#snippet iconLeft()}<Download class="w-3.5 h-3.5" />{/snippet}Download Links</ZenButton>
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
              <a href="/campaigns"><ZenButton variant="ghost" tabindex={-1}>Open Campaigns</ZenButton></a>
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
                {#snippet actions()}{#if deadlineFix}<ZenButton variant="primary" size="sm" onclick={() => ((draft = null), (uiStep = 0), (error = errorTitle = errorCode = ''))}>Change Deadline</ZenButton>{:else if rejectedFree}<ZenButton variant="secondary" size="sm" onclick={changeAfterReject} disabled={!!busy}>Change the List</ZenButton>{/if}{/snippet}
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

        {#if error && step !== 2}<Note tone="error">{error}</Note>{/if}
      </section>

      {#if step < 2}
        <!-- What They See (T-032, owner point 10): the claim page's own card component, inert; nothing in it takes a click -->
        <aside class="w-full min-w-0 lg:flex-1 lg:max-w-2xl lg:sticky lg:top-24" aria-label="What the first recipient sees">
          <div class="mb-4 ml-1 flex items-center gap-1.5 text-sm text-zen-fg-muted"><Eye class="w-4 h-4" aria-hidden="true" />What They See</div>
          <p class="sr-only">The claim card the first recipient sees: {previewAmount} {UNIT}, then Sign in with Google. A picture, not a form.</p>
          <ZenCard variant="elevated" class="overflow-hidden {parsed.rows.length ? '' : 'opacity-50'}">
            <div class="p-4 sm:p-8">
            <ClaimCard
              preview
              title={TESTNET ? 'Claim Your Test USDC' : 'Claim Your USDC'}
              sender={account ?? ''}
              left={previewLeft}
              amount={previewAmount}
              unit={UNIT}
              modes={previewModes}
              mode="existing"
            >
              {#snippet body()}<ZenInput aria-label="NEAR account" placeholder={TESTNET ? 'alice.testnet' : 'alice.near'} disabled />{/snippet}
              {#snippet footer()}<p class="text-xs text-zen-fg-subtle text-center">Use the email this link was sent to.</p>{/snippet}
            </ClaimCard>
            </div>
          </ZenCard>
        </aside>
      {:else if previewEmail && draft}
        <aside class="hidden lg:block w-full min-w-0 lg:flex-1 lg:max-w-2xl lg:sticky lg:top-24" aria-label="Preview of the message">
          <div class="mb-4 ml-1 text-sm text-zen-fg-muted">Message Preview</div>
          {@render messageCard(previewEmail, message(draft.recipients[0], `${claimHost}/claim/…`))}
          <p class="mt-3 ml-1 text-xs text-zen-fg-subtle">Each person gets their own link after you send.</p>
        </aside>
      {/if}
    </div>
  {/if}
</div>
