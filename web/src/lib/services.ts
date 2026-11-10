// Network calls the claim app makes. Every endpoint comes from config; none is hard-coded.

export interface Campaign {
  sender: string;
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

export async function postJson<T>(url: string, body: unknown): Promise<T> {
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

/** view_account: true if the account exists, false on UNKNOWN_ACCOUNT; any other failure throws. */
export async function accountExists(rpcUrl: string | undefined, accountId: string): Promise<boolean> {
  const res = await postJson<{ result?: unknown; error?: { cause?: { name?: string } } }>(need(rpcUrl, 'PUBLIC_NEAR_RPC_URL'), {
    jsonrpc: '2.0',
    id: 'zarf',
    method: 'query',
    params: { request_type: 'view_account', finality: 'final', account_id: accountId },
  });
  if (res.result) return true;
  if (res.error?.cause?.name === 'UNKNOWN_ACCOUNT') return false;
  throw new ClaimError('RPC_ERROR');
}

export const getNetwork = async (rpcUrl: string | undefined, contractId: string | undefined) =>
  nearView<string>(need(rpcUrl, 'PUBLIC_NEAR_RPC_URL'), need(contractId, 'PUBLIC_CONTRACT_ID'), 'get_network', {});

export const getCampaign = async (rpcUrl: string | undefined, contractId: string | undefined, campaignId: string) =>
  nearView<Campaign | null>(need(rpcUrl, 'PUBLIC_NEAR_RPC_URL'), need(contractId, 'PUBLIC_CONTRACT_ID'), 'get_campaign', { campaign_id: campaignId });

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
  COMMITMENT_MISMATCH: 'This link was sent to a different Google account. Sign in with the account it was sent to.',
  E125_CAMPAIGN_ENDED: 'This campaign has ended. Unclaimed funds go back to the sender.',
  E110_UNKNOWN_CAMPAIGN: 'This campaign does not exist.',
  E102_INVALID_MERKLE_PROOF: 'This claim is not in the campaign list.',
  E105_ALREADY_CLAIMED: 'This allocation has already been claimed.',
  E123_CLAIM_PENDING: 'This claim is already being paid. Check back in a minute.',
  EXPIRED: 'Your Google sign-in expired. Open your claim link and sign in again.',
  BAD_NONCE: 'This sign-in was for a different destination. Open your claim link and start again.',
  EMAIL_NOT_VERIFIED: 'Google says this email is not verified.',
  UPSTREAM_UNAVAILABLE: 'A service we depend on is not answering. Try again in a minute.',
  E101_INVALID_SIGNATURE: 'The verifier is not authorised for this campaign right now. Try again later or contact the sender.',
  E129_INSUFFICIENT_BALANCE: 'This campaign is underfunded; contact the sender.',
  BAD_DESTINATION: 'That is not a valid NEAR account. Open your claim link and start again.',
  RATE_LIMITED: 'Too many attempts. Wait a minute and try again.',
  LINK_MISMATCH: 'This claim link does not match the campaign on chain. Ask the sender for your link again.',
  E115_TOKEN_TRANSFER_FAILED: 'The transfer failed and your claim is open again. Open your claim link to try again.',
  INTENTS_QUOTE_EXPIRES_FIRST: 'Your cross-chain quote expired. Open your claim link to get a new one and sign in again.',
  INTENTS_NOT_PENDING: 'This cross-chain quote was already used. Open your claim link to get a new one.',
  QUOTE_EXPIRED: 'Your cross-chain quote expired. Open your claim link to get a new one and sign in again.',
  E114_CLAIM_EXPIRED: 'That took too long. Open your claim link and sign in again.',
  E108_INVALID_INPUT: 'This claim link is damaged. Ask the sender for your link again.',
  E109_INVALID_AMOUNT: 'This claim link is damaged. Ask the sender for your link again.',
  NO_EMAIL: 'Google did not share an email for this account. Sign in with the account the link was sent to.',
  RPC_ERROR: 'NEAR is not answering right now. Try again in a minute.',
};


/** The stable code behind a failure, for a small details line; the sentence never carries it. */
export const errorCode = (e: unknown): string => (e instanceof ClaimError ? e.code : 'UNEXPECTED');

export function describeError(e: unknown): string {
  const code = errorCode(e);
  if (code.startsWith('NOT_CONFIGURED:')) return `This site is not fully set up yet (${code.slice(15)}).`;
  if (!MESSAGES[code] && code.startsWith('INTENTS_')) {
    return "The cross-chain quote doesn't match what you chose. Open your claim link to get a new one.";
  }
  if (!MESSAGES[code] && /^HTTP_5\d\d$/.test(code)) return MESSAGES.RPC_ERROR.replace('NEAR is', 'Our service is');
  return MESSAGES[code] ?? 'Something went wrong. Open your claim link and try again.';
}

/** True when describeError fell back to a generic sentence, so the code is worth showing as a detail. */
export const isUnmapped = (e: unknown): boolean => !MESSAGES[errorCode(e)];

/** Why the claim page could not read the chain before any claim: never 'the claim did not go through'. */
export function describeCheckError(e: unknown): string {
  if (e instanceof ClaimError && e.code.startsWith('NOT_CONFIGURED:')) return describeError(e);
  return 'NEAR is not answering right now.';
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
