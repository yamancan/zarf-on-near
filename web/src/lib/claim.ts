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
