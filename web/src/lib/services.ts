// Network calls the claim app makes. Every endpoint comes from config; none is hard-coded.

export interface Campaign {
  merkle_root: string;
  deadline_ns: string;
}

export interface ClaimArgs {
  campaign_id: string;
  commitment: string;
  amount: string;
  proof: string[];
  destination: string;
  expires_at_ns: string;
  signer: string;
  signature: string;
}

/** A refusal with a stable code (verifier/relayer error, or a local one). */
export class ClaimError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const need = (value: string | undefined, name: string): string => {
  if (!value) throw new ClaimError(`NOT_CONFIGURED:${name}`);
  return value;
};

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const out = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ClaimError(out.error ?? `HTTP_${res.status}`);
  return out as T;
}

/** NEAR RPC view call (`query` / `call_function`). */
export async function nearView<T>(rpcUrl: string, contractId: string, method: string, args: object, finality: 'final' | 'optimistic' = 'final'): Promise<T> {
  const res = await postJson<{ result?: { result?: number[]; error?: string }; error?: unknown }>(rpcUrl, {
    jsonrpc: '2.0',
    id: 'zarf',
    method: 'query',
    params: {
      request_type: 'call_function',
      finality,
      account_id: contractId,
      method_name: method,
      args_base64: btoa(JSON.stringify(args)),
    },
  });
  if (res.error || !res.result?.result) throw new ClaimError('RPC_ERROR');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(res.result.result)));
}

export const getCampaign = async (rpcUrl: string | undefined, contractId: string | undefined, campaignId: string) =>
  nearView<Campaign | null>(need(rpcUrl, 'PUBLIC_NEAR_RPC_URL'), need(contractId, 'PUBLIC_CONTRACT_ID'), 'get_campaign', { campaign_id: campaignId });

/** spec/claim.md "Leaf list": `<PUBLIC_LEAVES_URL>/<campaign_id>.json`, published by the create app. */
export interface LeafList {
  campaign_id: string;
  merkle_root: string;
  leaves: { commitment: string; amount: string }[];
}

export async function fetchLeaves(baseUrl: string | undefined, campaignId: string): Promise<LeafList> {
  const res = await fetch(`${need(baseUrl, 'PUBLIC_LEAVES_URL')}/${campaignId}.json`);
  if (!res.ok) throw new ClaimError('LEAVES_UNAVAILABLE');
  const f = await res.json().catch(() => null);
  const ok =
    typeof f?.campaign_id === 'string' &&
    /^[0-9a-f]{64}$/.test(f.merkle_root) &&
    Array.isArray(f.leaves) &&
    f.leaves.length > 0 &&
    f.leaves.every((l: { commitment?: unknown; amount?: unknown }) => /^[0-9a-f]{64}$/.test(String(l?.commitment)) && /^[1-9]\d{0,38}$/.test(String(l?.amount)));
  if (!ok) throw new ClaimError('LEAVES_INVALID');
  if (f.campaign_id !== campaignId) throw new ClaimError('LEAVES_MISMATCH');
  return f;
}

export const requestSignature = async (verifierUrl: string | undefined, body: Record<string, unknown>) =>
  postJson<ClaimArgs>(`${need(verifierUrl, 'PUBLIC_VERIFIER_URL')}/claim`, body);

/**
 * spec/claim.md "Relayer": POST /claim with exactly the verifier's 200 body. 200 `paid` comes from our
 * contract's claim_paid event in the executed receipt; 202 `submitted` means the outcome is not known
 * yet; 409 E115 (claim_reverted) throws.
 */
export async function submitClaim(relayerUrl: string | undefined, args: ClaimArgs): Promise<{ txHash: string; paid: boolean }> {
  const { tx_hash, status } = await postJson<{ tx_hash?: string; status?: string }>(`${need(relayerUrl, 'PUBLIC_RELAYER_URL')}/claim`, args);
  // A NEAR tx hash is base58 of 32 bytes; anything else would end up in the explorer link.
  if (typeof tx_hash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tx_hash)) throw new ClaimError('RELAYER_NO_TX');
  return { txHash: tx_hash, paid: status === 'paid' };
}

const MESSAGES: Record<string, string> = {
  COMMITMENT_MISMATCH: 'This link belongs to a different Google account. Sign in with the address the sender used.',
  E125_CAMPAIGN_ENDED: 'This campaign has ended. Unclaimed funds go back to the sender.',
  E110_UNKNOWN_CAMPAIGN: 'This campaign does not exist.',
  E102_INVALID_MERKLE_PROOF: 'This claim is not in the campaign list.',
  E105_ALREADY_CLAIMED: 'This allocation has already been claimed.',
  E123_CLAIM_PENDING: 'This claim is already being paid. Check back in a minute.',
  EXPIRED: 'Your Google sign-in expired. Open your claim link and sign in again.',
  BAD_NONCE: 'This sign-in was for a different destination. Open your claim link and start again.',
  EMAIL_NOT_VERIFIED: 'Google says this email is not verified.',
  NOT_IN_LIST: 'This claim is not in the published campaign list.',
  LEAVES_MISMATCH: 'The published campaign list does not match the contract. Nothing was sent.',
  LEAVES_INVALID: 'The published campaign list is damaged. Nothing was sent; contact the sender.',
  LEAVES_UNAVAILABLE: 'The campaign list could not be loaded. Try again in a minute.',
  UPSTREAM_UNAVAILABLE: 'A service we depend on is not answering. Try again in a minute.',
  E101_INVALID_SIGNATURE: 'The verifier is not authorised for this campaign right now. Try again later or contact the sender.',
  E129_INSUFFICIENT_BALANCE: 'This campaign is underfunded; contact the sender.',
  BAD_DESTINATION: 'That is not a valid NEAR account. Open your claim link and start again.',
  RATE_LIMITED: 'Too many attempts. Wait a minute and try again.',
  E115_TOKEN_TRANSFER_FAILED: 'The transfer failed and your claim is open again. Open your claim link to try again.',
};

export function describeError(e: unknown): string {
  const code = e instanceof ClaimError ? e.code : 'UNEXPECTED';
  if (code.startsWith('NOT_CONFIGURED:')) return `This site is not fully set up yet (${code.slice(15)}).`;
  return MESSAGES[code] ?? `The claim did not go through (${code}).`;
}

export type ClaimState = 'unclaimed' | 'pending' | 'claimed';

// Optimistic: the freshest state; a lagging `final` read right after the tx would say "unclaimed".
export const getClaimState = async (rpcUrl: string | undefined, contractId: string | undefined, campaignId: string, commitment: string) =>
  nearView<ClaimState>(need(rpcUrl, 'PUBLIC_NEAR_RPC_URL'), need(contractId, 'PUBLIC_CONTRACT_ID'), 'claim_state', { campaign_id: campaignId, commitment }, 'optimistic');

const BACKOFF_MS = [1000, 2000, 3000, 5000, 8000];

/**
 * For a relayer 202: polls claim_state until it settles, or `timeoutMs` passes. A node that has not
 * seen the tx yet still says "unclaimed", so that is final only once "pending" was seen or after
 * `graceMs`. A failed read or an unexpected value counts as pending: never a false success or failure.
 */
export async function settleClaim(
  read: () => Promise<ClaimState>,
  { timeoutMs = 60_000, graceMs = 20_000, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), now = Date.now } = {},
): Promise<ClaimState> {
  const start = now();
  const end = start + timeoutMs;
  let sawPending = false;
  for (let i = 0; ; i++) {
    const state = await read().catch(() => 'pending' as const);
    if (state === 'claimed') return state;
    if (state === 'unclaimed' && (sawPending || now() - start >= graceMs)) return state;
    if (state === 'pending') sawPending = true;
    const wait = BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)];
    if (now() + wait > end) return 'pending';
    await sleep(wait);
  }
}

/** After the relayer: its event-based "paid" is final; otherwise poll the chain. */
export const outcomeAfterRelay = (relay: { paid: boolean }, read: () => Promise<ClaimState>, opts?: Parameters<typeof settleClaim>[1]) =>
  relay.paid ? Promise.resolve<ClaimState>('claimed') : settleClaim(read, opts);

// Codes where opening the link again cannot help: the claim is paid, the campaign ended, or it does not exist.
const FINAL = new Set(['E105_ALREADY_CLAIMED', 'E125_CAMPAIGN_ENDED', 'E110_UNKNOWN_CAMPAIGN']);

/** Whether to suggest opening the claim link again after this failure. */
export const canRetry = (e: unknown): boolean => !(e instanceof ClaimError && FINAL.has(e.code));
