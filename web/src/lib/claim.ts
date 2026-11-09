// Browser-side claim helpers. Byte rules come from spec/claim.md; tests pin them to spec/vectors.json.

const enc = new TextEncoder();

export const hex = (b: ArrayBuffer | Uint8Array): string =>
  Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

// NEAR account id: 2-64 chars, lowercase alphanumerics joined by single '-', '_' or '.'.
const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const isValidAccountId = (id: string): boolean => id.length >= 2 && id.length <= 64 && ACCOUNT_ID.test(id);

export const isCampaignId = (s: string): boolean => /^(0|[1-9]\d{0,19})$/.test(s) && BigInt(s) < 1n << 64n;
export const isHex32 = (s: string): boolean => /^[0-9a-f]{64}$/.test(s);

/** Google `nonce` = lowercase hex sha256 of the destination account. */
export const destinationNonce = async (destination: string): Promise<string> =>
  hex(await crypto.subtle.digest('SHA-256', enc.encode(destination)));

/** The per-recipient salt from the claim link fragment `#s=<hex32>`, or null. */
export function saltFromFragment(hash: string): string | null {
  const s = new URLSearchParams(hash.replace(/^#/, '')).get('s');
  return s && isHex32(s) ? s : null;
}

export const claimState = (campaign: string, commitment: string): string => `${campaign}/${commitment}`;

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
  destination: string;
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

/** The id_token lives in memory only: a reload means signing in again. */
export const signedIn: { idToken: string | null } = { idToken: null };
