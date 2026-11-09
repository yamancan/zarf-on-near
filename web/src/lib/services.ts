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
export async function nearView<T>(rpcUrl: string, contractId: string, method: string, args: object): Promise<T> {
  const res = await postJson<{ result?: { result?: number[]; error?: string }; error?: unknown }>(rpcUrl, {
    jsonrpc: '2.0',
    id: 'zarf',
    method: 'query',
    params: {
      request_type: 'call_function',
      finality: 'final',
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

/** spec/claim.md "Relayer": POST /claim with exactly the verifier's 200 body → { tx_hash }. */
export async function submitClaim(relayerUrl: string | undefined, args: ClaimArgs): Promise<string> {
  const { tx_hash } = await postJson<{ tx_hash?: string }>(`${need(relayerUrl, 'PUBLIC_RELAYER_URL')}/claim`, args);
  // A NEAR tx hash is base58 of 32 bytes; anything else would end up in the explorer link.
  if (typeof tx_hash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tx_hash)) throw new ClaimError('RELAYER_NO_TX');
  return tx_hash;
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
};

export function describeError(e: unknown): string {
  const code = e instanceof ClaimError ? e.code : 'UNEXPECTED';
  if (code.startsWith('NOT_CONFIGURED:')) return `This site is not fully set up yet (${code.slice(15)}).`;
  return MESSAGES[code] ?? `The claim did not go through (${code}).`;
}
