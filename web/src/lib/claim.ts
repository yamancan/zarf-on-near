// Browser-side claim helpers. Byte rules come from spec/claim.md; tests pin them to spec/vectors.json.

const enc = new TextEncoder();

export const hex = (b: ArrayBuffer | Uint8Array): string =>
  Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

// NEAR account id: 2-64 chars, lowercase alphanumerics joined by single '-', '_' or '.'.
const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const isValidAccountId = (id: string): boolean => id.length >= 2 && id.length <= 64 && ACCOUNT_ID.test(id);

/** A NEAR implicit account: the hex of an ed25519 public key. It exists on chain only once NEAR is sent to it. */
export const isImplicitAccount = (id: string): boolean => /^[0-9a-f]{64}$/.test(id);

export type Destination =
  | { kind: 'empty' }
  | { kind: 'wrong'; reason: string } // not a NEAR account id: never sent to the chain
  | { kind: 'named' | 'implicit'; id: string };

/**
 * What the recipient typed in the NEAR field, before any chain read. Foreign addresses are caught on
 * the raw input: lower-casing would turn a Stellar or Ethereum address into a well-formed NEAR name.
 */
export function classifyDestination(input: string): Destination {
  const raw = input.trim();
  if (!raw) return { kind: 'empty' };
  if (/^(G[A-Z2-7]{55}|M[A-Z2-7]{68})$/i.test(raw)) return { kind: 'wrong', reason: 'That looks like a Stellar address, not a NEAR account.' };
  if (/^0x/i.test(raw)) return { kind: 'wrong', reason: 'That looks like an Ethereum address, not a NEAR account.' };
  const id = raw.toLowerCase();
  if (!isValidAccountId(id)) return { kind: 'wrong', reason: 'That is not a valid NEAR account name.' };
  return { kind: isImplicitAccount(id) ? 'implicit' : 'named', id };
}

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

/** OAuth `state`: the claim plus a random per-attempt value, so a callback from another attempt is refused. */
export const claimState = (campaign: string, commitment: string, attemptId: string): string =>
  `${campaign}/${commitment}/${attemptId}`;

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

/** "6 days left", "3 hours left", "less than an hour left"; '' once it has passed. */
export function timeLeft(deadlineMs: number, nowMs: number): string {
  const left = deadlineMs - nowMs;
  if (left <= 0) return '';
  const h = Math.floor(left / 3_600_000);
  return h >= 48 ? `${Math.floor(h / 24)} days left` : h >= 1 ? `${h} hour${h === 1 ? '' : 's'} left` : 'less than an hour left';
}

/** What a finished claim paid, kept so a reload or a reopened link can still show it. Nothing here is secret. */
export interface Receipt {
  amount: string; // USDC base units (the link's amount)
  destination: string; // the NEAR account, or for a cross-chain payout the address on that chain
  txHash: string; // the NEAR claim tx
  chainName?: string; // set for a cross-chain payout
}

const receiptKey = (campaign: string, commitment: string) => `zarf-near:receipt:${campaign}/${commitment}`;

// localStorage, not sessionStorage: the recipient often reopens the link from the email in a new tab.
export function saveReceipt(campaign: string, commitment: string, r: Receipt, store?: Storage): void {
  try {
    (store ?? localStorage).setItem(receiptKey(campaign, commitment), JSON.stringify(r));
  } catch {
    // best effort: without it a reload shows "Already claimed" without the transaction
  }
}

export function loadReceipt(campaign: string, commitment: string, store?: Storage): Receipt | null {
  try {
    const r = JSON.parse((store ?? localStorage).getItem(receiptKey(campaign, commitment)) ?? 'null') as Receipt | null;
    return r && /^[1-9]\d{0,38}$/.test(r.amount) && typeof r.destination === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.txHash) ? r : null;
  } catch {
    return null;
  }
}

/** "0x5aAe…1BeAed": long addresses on one line; the full value stays in a title and on copy. */
export const middle = (s: string, keep = 6): string => (s.length > keep * 2 + 1 ? `${s.slice(0, keep)}…${s.slice(-keep)}` : s);

/** "9.99558" -> "9.99": display only, never rounds up an amount the recipient may not get. */
export const twoDecimals = (s: string): string => s.replace(/^(\d+)(\.\d{1,2})?\d*$/, (_, w, f = '') => w + (f && f !== '.00' ? f : ''));
