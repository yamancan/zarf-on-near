// Browser-side claim helpers. Byte rules come from spec/claim.md; tests pin them to spec/vectors.json.

import type { StatusView } from './intents';

const enc = new TextEncoder();

export const hex = (b: ArrayBuffer | Uint8Array): string =>
  Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

// NEAR account id: 2-64 chars, lowercase alphanumerics joined by single '-', '_' or '.'.
const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const isValidAccountId = (id: string): boolean => id.length >= 2 && id.length <= 64 && ACCOUNT_ID.test(id);

/** A NEAR implicit account: the hex of an ed25519 public key. It exists on chain only once NEAR is sent to it. */
export const isImplicitAccount = (id: string): boolean => /^[0-9a-f]{64}$/.test(id);
/** NEP-518 (MetaMask) id: exists on NEAR only once it has received NEAR, which deploys its wallet contract (T-016). */
export const isEthAccount = (id: string): boolean => /^0x[0-9a-f]{40}$/.test(id);

export type Destination =
  | { kind: 'empty' }
  | { kind: 'wrong'; reason: string } // not a NEAR account id: never sent to the chain
  | { kind: 'named' | 'implicit'; id: string };

/** Shared NEAR contracts: a plain ft_transfer to them credits nobody (intents.near needs ft_transfer_call + msg). */
const SHARED_CONTRACTS = ['intents.near', 'wrap.near', 'intents.testnet', 'wrap.testnet'];

/**
 * What the recipient typed in the NEAR field, before any chain read. Foreign addresses are caught on
 * the raw input: lower-casing would turn a Stellar or Ethereum address into a well-formed NEAR name.
 */
export function classifyDestination(input: string, contracts: { escrow?: string; token?: string; eth?: boolean } = {}): Destination {
  const raw = input.trim();
  if (!raw) return { kind: 'empty' };
  if (/^(G[A-Z2-7]{55}|M[A-Z2-7]{68})$/i.test(raw)) return { kind: 'wrong', reason: 'That looks like a Stellar address, not a NEAR account.' };
  // NEP-518 eth-implicit id (MetaMask on NEAR); off until a real claim to one is proven spendable (T-002 item 3).
  if (contracts.eth && /^0x[0-9a-f]{40}$/i.test(raw)) return { kind: 'implicit', id: raw.toLowerCase() };
  if (/^0x/i.test(raw)) return { kind: 'wrong', reason: 'That looks like an Ethereum address, not a NEAR account.' };
  const id = raw.toLowerCase();
  if (!isValidAccountId(id)) return { kind: 'wrong', reason: 'That is not a valid NEAR account name.' };
  // The relayer and verifier refuse these too (DESTINATION_IS_CONTRACT / _TOKEN); say so before sign-in.
  if (id === contracts.escrow) return { kind: 'wrong', reason: 'That is the Zarf contract itself, not your account. USDC sent there could never be taken out.' };
  if (id === contracts.token) return { kind: 'wrong', reason: 'That is the USDC token contract, not your account. USDC sent there would be lost.' };
  if (SHARED_CONTRACTS.includes(id)) return { kind: 'wrong', reason: `That is ${id}, a shared NEAR contract, not your account. USDC sent there would credit nobody.` };
  return { kind: isImplicitAccount(id) ? 'implicit' : 'named', id };
}

export type AccountCheck = { id: string; state: 'checking' | 'found' | 'missing' | 'error' } | null;

/**
 * The NEAR-account path may go to Google only for the account the recipient confirmed: it must exist on chain
 * (or be an implicit id whose key holder said so), and "Is this your account?" was answered for this exact id.
 */
export const nearAccountReady = (dest: Destination, acct: AccountCheck, unfundedAck: boolean, confirmedFor: string): boolean =>
  (dest.kind === 'named' || dest.kind === 'implicit') &&
  acct?.id === dest.id &&
  (acct.state === 'found' || (acct.state === 'missing' && dest.kind === 'implicit' && !isEthAccount(dest.id) && unfundedAck)) &&
  confirmedFor === dest.id;

/** The line under the field when the typed account is not on chain yet. A new 0x id can't spend until it holds NEAR. */
export const missingAccountLine = (dest: Destination): string =>
  dest.kind !== 'named' && dest.kind !== 'implicit'
    ? ''
    : dest.kind === 'named'
      ? 'No such account. Check the spelling.'
      : isEthAccount(dest.id)
        ? 'This MetaMask address is new on NEAR: send it a little test NEAR first, then claim.'
        : 'Not on NEAR yet. Check every character.';

export const isCampaignId = (s: string): boolean => /^(0|[1-9]\d{0,19})$/.test(s) && BigInt(s) < 1n << 64n;
export const isHex32 = (s: string): boolean => /^[0-9a-f]{64}$/.test(s);

/** Google `nonce` = lowercase hex sha256 of the destination account. */
export const destinationNonce = async (destination: string): Promise<string> =>
  hex(await crypto.subtle.digest('SHA-256', enc.encode(destination)));

/** spec "claim link": the proof is the sibling hashes concatenated (32 bytes each), base64url, no padding. */
export function encodeProof(proof: string[]): string {
  const bytes = Uint8Array.from(proof.join('').match(/../g) ?? [], (x) => parseInt(x, 16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Inverse of encodeProof; null if it is not base64url of whole 32-byte siblings, or longer than 20. */
export function decodeProof(p: string): string[] | null {
  if (!/^[A-Za-z0-9_-]*$/.test(p)) return null;
  let raw: string;
  try {
    raw = atob(p.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null;
  }
  if (raw.length % 32 !== 0 || raw.length > 20 * 32) return null;
  const h = hex(Uint8Array.from(raw, (c) => c.charCodeAt(0)));
  if (encodeProof(h.match(/.{64}/g) ?? []) !== p) return null; // canonical encoding only
  return h.match(/.{64}/g) ?? [];
}

export interface LinkSecret {
  salt: string; // hex32
  amount: string; // u128, decimal, > 0
  proof: string[]; // hex32 siblings
}

/** The claim link fragment `#s=<hex32>&a=<u128>&p=<base64url>`, or null if any part is missing or malformed. */
export function parseLinkFragment(hash: string): LinkSecret | null {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const salt = q.get('s'), amount = q.get('a'), p = q.get('p');
  if (!salt || !isHex32(salt) || !amount || !/^[1-9]\d{0,38}$/.test(amount) || BigInt(amount) >> 128n || p === null) return null;
  const proof = decodeProof(p);
  return proof ? { salt, amount, proof } : null;
}

/** The link's fragment for one recipient (the order of spec/vectors.json `links`). */
export const linkFragment = (l: LinkSecret): string => `s=${l.salt}&a=${l.amount}&p=${encodeProof(l.proof)}`;

/**
 * OAuth `state` is the random per-attempt id alone (red team #5): Google never learns which link is being claimed.
 * The campaign and commitment stay in this tab's sessionStorage (saveAttempt). A callback matches only the attempt
 * this tab started, and only one with a destination.
 */
export const stateMatches = (a: Attempt | null, state: string): a is Attempt => !!a?.destination && !!a.attemptId && a.attemptId === state;

export const newAttemptId = (): string => hex(crypto.getRandomValues(new Uint8Array(16)));

export function googleAuthUrl(o: { clientId: string; redirectUri: string; nonce: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: 'id_token',
    scope: 'openid email',
    nonce: o.nonce,
    state: o.state,
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export type Callback = { idToken: string; state: string } | { error: string };

/** Reads Google's redirect fragment: `#id_token=…&state=…`, or `#error=…`. */
export function parseCallback(hash: string): Callback {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const idToken = p.get('id_token'), state = p.get('state');
  return idToken && state ? { idToken, state } : { error: p.get('error') ?? 'missing_token' };
}

/** What survives the Google redirect: this tab's sessionStorage only, never a server. */
export interface Attempt {
  campaign: string;
  commitment: string;
  salt: string;
  amount: string;
  proof: string[];
  destination: string; // for a cross-chain payout: the 1Click deposit address
  attemptId: string;
  intents?: PayoutAttempt;
  passkey?: true; // T-021: the destination is a passkey account (Face ID reopens it)
}

/** A real 1Click quote the sign-in is bound to (its deposit address is the destination). */
export interface PayoutAttempt {
  chainName: string;
  assetId: string;
  recipient: string;
  refundTo: string; // the campaign sender
  requestDeadline: string; // ISO: the app refuses to start the claim after it
  amountOutFormatted: string;
}

/**
 * The NEAR account typed before a failed sign-in (another Google account, expired), so "Back to Claim" keeps it.
 * A cross-chain attempt's destination is a 1Click deposit address, never something the recipient typed.
 */
export const typedBefore = (a: Attempt | null, campaign: string, commitment: string): string =>
  a && a.campaign === campaign && a.commitment === commitment && !a.intents ? a.destination : '';

/** A sign-in for this link started in this tab (the claim page saved an attempt id): a reload mid-claim, not "nothing yet". */
export const claimStartedHere = (a: Attempt | null, campaign: string, commitment: string): boolean =>
  !!a && a.campaign === campaign && a.commitment === commitment && !!a.attemptId;

/** Claimed on chain, and this browser has no record of it: never implies theft (red-team UX #3). */
export const CLAIMED_NO_RECORD = 'This link was claimed. If you just tried, check your wallet. If not, contact the sender.';
/** No secret part in the address: the usual cause is "Open in browser" from a chat app, which drops it (#4). */
export const INCOMPLETE_LINE = 'Part is missing. Open the link from your message in Safari or Chrome, not inside another app. Still broken? Ask the sender to send it again.';
/** While a claim runs, leaving asks first: the sign-in lives in this tab only (#3). Returns the remover. */
export function holdPage(target: EventTarget): () => void {
  const ask = (e: Event) => {
    e.preventDefault();
    (e as BeforeUnloadEvent).returnValue = ''; // older browsers show the prompt only with this set
  };
  target.addEventListener('beforeunload', ask);
  return () => target.removeEventListener('beforeunload', ask);
}
/** The receipt's button opens an explorer, not a wallet (#10). */
export const EXPLORER_LABEL = 'View on Explorer';

const KEY = 'zarf-near:attempt';
export const saveAttempt = (a: Attempt, store: Storage = sessionStorage) => store.setItem(KEY, JSON.stringify(a));
export function loadAttempt(store: Storage = sessionStorage): Attempt | null {
  try {
    return JSON.parse(store.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
}

export const clearAttempt = (store: Storage = sessionStorage) => store.removeItem(KEY);

/** The id_token lives in memory only: a reload means signing in again. */
export const signedIn: { idToken: string | null } = { idToken: null };

/** "17 Nov 2026, 21:55 GMT+3, 6 days left": absolute in the reader's own zone, plus what is left. */
export function deadlineText(deadlineMs: number, nowMs: number, timeZone?: string): string {
  const when = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short', timeZone,
  }).format(deadlineMs);
  const rest = timeLeft(deadlineMs, nowMs);
  return rest ? `${when}, ${rest}` : when;
}

/**
 * "7 days left", "3 hours left", "less than an hour left"; '' once it has passed. Whole days count from
 * 48 h and allow one hour, so a deadline picked as "1 week" reads "7 days left" a moment later, never 6;
 * it never overstates by more than that hour.
 */
export function timeLeft(deadlineMs: number, nowMs: number): string {
  const left = deadlineMs - nowMs;
  if (left <= 0) return '';
  const h = Math.floor(left / 3_600_000);
  return h >= 48 ? `${Math.floor((left + 3_600_000) / 86_400_000)} days left` : h >= 1 ? `${h} hour${h === 1 ? '' : 's'} left` : 'less than an hour left';
}

/**
 * What a finished claim paid, kept so a reload or a reopened link can still show it. Nothing here is secret.
 * It never says more than was confirmed: a cross-chain payout stays 'in-transit' until the bridge reports
 * an outcome, and the page shows the record only after the chain says the claim is claimed.
 */
export interface Receipt {
  amount: string; // USDC base units (the link's amount)
  destination: string; // the NEAR account, or for a cross-chain payout the address on that chain
  txHash: string; // the NEAR claim tx; '' when the relayer's answer was lost (the chain still said claimed)
  passkey?: true; // T-021: the destination is a passkey account (Face ID reopens it)
  at?: number; // when this browser saw the claim land (ms)
  chainName?: string; // set for a cross-chain payout
  bridge?: BridgeOutcome; // set for a cross-chain payout
  amountOut?: string; // cross-chain: what the bridge reported paying, "9.99558" (display only)
  depositAddress?: string; // cross-chain: the 1Click deposit address (public), so a reopened link can ask the bridge again
  refundTo?: string; // cross-chain: where a refund goes (the campaign sender)
  checkedAt?: number; // cross-chain: when the bridge last answered (ms)
  bridgeStatus?: StatusView; // last bridge step, error and destination transaction, preserved across reloads
  savedAt?: number; // when this browser first saved the record; it expires RECEIPT_TTL_MS later
}

/** A remembered receipt is cleared when read 30 days after it was saved (it names a destination and an amount). */
export const RECEIPT_TTL_MS = 30 * 86_400_000;

/**
 * A cross-chain payout as last reported by the bridge. Only 'paid' means it arrived, only 'refunded' that it went
 * back. 'refunding': 1Click did not accept the deposit (INCOMPLETE_DEPOSIT), which its docs say is refunded by the
 * deadline. 'failed': 1Click reported an error; its docs promise nothing about where that money goes.
 */
export type BridgeOutcome = 'in-transit' | 'paid' | 'refunded' | 'refunding' | 'failed';
const OUTCOMES: BridgeOutcome[] = ['in-transit', 'paid', 'refunded', 'refunding', 'failed'];

// The contract id is in the key: the same host has served more than one contract.
const receiptKey = (contract: string, campaign: string, commitment: string) => `zarf-near:receipt:${contract}/${campaign}/${commitment}`;

// localStorage, not sessionStorage: the recipient often reopens the link from the email in a new tab.
export function saveReceipt(contract: string, campaign: string, commitment: string, r: Receipt, store?: Storage, now = Date.now()): void {
  try {
    (store ?? localStorage).setItem(receiptKey(contract, campaign, commitment), JSON.stringify({ ...r, bridgeStatus: safeBridgeStatus(r.bridgeStatus), savedAt: r.savedAt ?? now }));
  } catch {
    // best effort: without it a reload shows "Already claimed" without the transaction
  }
}

export function loadReceipt(contract: string, campaign: string, commitment: string, store?: Storage, now = Date.now()): Receipt | null {
  try {
    const s = store ?? localStorage;
    const key = receiptKey(contract, campaign, commitment);
    const r = JSON.parse(s.getItem(key) ?? 'null') as Receipt | null;
    if (!r || !/^[1-9]\d{0,38}$/.test(r.amount) || typeof r.destination !== 'string' || typeof r.txHash !== 'string' || (r.txHash !== '' && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.txHash))) return null;
    if (!(typeof r.savedAt === 'number' && now - r.savedAt < RECEIPT_TTL_MS)) {
      s.removeItem(key); // expired, or from before records had a date
      return null;
    }
    if (r.amountOut !== undefined && !/^\d+(\.\d+)?$/.test(r.amountOut)) delete r.amountOut;
    if (r.depositAddress !== undefined && !/^[0-9a-f]{64}$/.test(r.depositAddress)) delete r.depositAddress;
    if (r.refundTo !== undefined && typeof r.refundTo !== 'string') delete r.refundTo;
    if (r.checkedAt !== undefined && typeof r.checkedAt !== 'number') delete r.checkedAt;
    r.bridgeStatus = safeBridgeStatus(r.bridgeStatus);
    // A cross-chain record without a known outcome is still in transit, whatever else it says.
    return r.chainName ? { ...r, bridge: OUTCOMES.includes(r.bridge!) ? r.bridge : 'in-transit' } : r;
  } catch {
    return null;
  }
}

/** Records the bridge's outcome on a cross-chain receipt already saved; nothing happens without one. */
export function settleReceipt(contract: string, campaign: string, commitment: string, bridge: BridgeOutcome, amountOut?: string, store?: Storage, now = Date.now(), status?: StatusView): Receipt | null {
  const r = loadReceipt(contract, campaign, commitment, store, now);
  if (!r?.chainName) return r;
  const next = { ...r, bridge, checkedAt: now, ...(status ? { bridgeStatus: safeBridgeStatus(status) } : {}), ...(bridge === 'paid' && amountOut ? { amountOut } : {}) };
  saveReceipt(contract, campaign, commitment, next, store, now);
  return next;
}

/** Browser storage and upstream transaction URLs are untrusted; never restore an executable link. */
export function safeBridgeStatus(value: unknown): StatusView | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const s = value as StatusView;
  if (!['PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'PROCESSING', 'SUCCESS', 'INCOMPLETE_DEPOSIT', 'REFUNDED', 'FAILED'].includes(s.status)) return undefined;
  const out: StatusView = { status: s.status };
  if (typeof s.refundReason === 'string') out.refundReason = s.refundReason.slice(0, 2000);
  if (typeof s.amountOutFormatted === 'string' && /^\d{1,39}(\.\d{1,39})?$/.test(s.amountOutFormatted)) out.amountOutFormatted = s.amountOutFormatted;
  if (typeof s.destinationTx?.hash === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(s.destinationTx.hash)) {
    out.destinationTx = { hash: s.destinationTx.hash };
    try {
      const url = new URL(s.destinationTx.explorerUrl ?? '');
      if (url.protocol === 'https:' && !url.username && !url.password) out.destinationTx.explorerUrl = url.href;
    } catch { /* a hash can still be displayed without an explorer URL */ }
  }
  return out;
}

/**
 * The one amount a claim shows, on its receipt and on "Already claimed" alike: what the bridge paid once it
 * confirmed the payout, otherwise the link's amount (on its way, returned or not delivered).
 */
export function shownAmount(r: Pick<Receipt, 'chainName' | 'bridge' | 'amountOut'>, linkValue: string, linkUnit: string): { value: string; unit: string } {
  return r.chainName && r.bridge === 'paid' && r.amountOut ? { value: twoDecimals(r.amountOut), unit: 'USDC' } : { value: linkValue, unit: linkUnit };
}

/** A remembered receipt is shown only once the chain says this claim is claimed (security review m1). */
export async function confirmRemembered(remembered: Receipt | null, readState: () => Promise<string>): Promise<Receipt | null> {
  if (!remembered) return null;
  return (await readState()) === 'claimed' ? remembered : null; // a failed read throws: the page offers "Check again"
}

/** "12 Nov 2026, 14:02": when a remembered claim landed, in the reader's own zone. */
export const claimedAt = (ms: number, timeZone?: string): string =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone }).format(ms);

/** "0x5aAe…1BeAed": long addresses on one line; the full value stays in a title and on copy. */
export const middle = (s: string, keep = 6): string => (s.length > keep * 2 + 1 ? `${s.slice(0, keep)}…${s.slice(-keep)}` : s);

/** "9.99558" -> "9.99": display only, never rounds up an amount the recipient may not get. */
export const twoDecimals = (s: string): string => s.replace(/^(\d+)(\.\d{1,2})?\d*$/, (_, w, f = '') => w + (f && f !== '.00' ? f : ''));

