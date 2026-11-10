// Cross-chain claim (design §4.4, spike S3): before signing a claim whose destination is a
// 1Click deposit address, the verifier re-reads that quote from 1Click and checks it pays
// what the recipient asked for. The nonce binds the deposit address; this binds the quote.

export const ONECLICK_API = 'https://1click.chaindefuser.com';
/** Mainnet NEAR USDC as 1Click names it (GET /v0/tokens). Intents has no testnet. */
export const NEAR_USDC_ASSET = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

export class IntentsError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const fail = (code: string): never => {
  throw new IntentsError(code);
};

/** What the recipient chose before sign-in, plus the expiry the verifier is about to sign. */
export interface IntentsClaim {
  depositAddress: string; // the signed `destination`
  amount: string; // leaf amount, u128 decimal, origin-asset base units
  destinationAsset: string; // 1Click asset id, e.g. nep141:base-0x8335…omft.near
  recipient: string; // address on the destination chain
  refundTo: string; // NEAR Intents account that receives a refund
  expiresAtNs: string; // u64 decimal
}

/** GET /v0/status for a deposit address. Keyless (S3). Returns the parsed body; check it with `checkIntentsStatus`. */
export async function fetchIntentsStatus(
  depositAddress: string,
  fetchFn: (url: string) => Promise<Response> = (u) => fetch(u),
  base = ONECLICK_API,
): Promise<unknown> {
  const res = await fetchFn(`${base}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
  if (res.status === 404) fail('INTENTS_QUOTE_NOT_FOUND');
  if (!res.ok) throw new Error(`1Click status failed: HTTP ${res.status}`);
  return res.json();
}

const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;

// EVM hex addresses are case-insensitive (checksum casing is cosmetic); every other format is compared exactly.
const sameAddress = (a: unknown, b: string): boolean =>
  typeof a === 'string' && (EVM.test(a) && EVM.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b);

const isoToNs = (s: unknown): bigint => {
  const ms = typeof s === 'string' ? Date.parse(s) : NaN;
  return Number.isFinite(ms) ? BigInt(ms) * 1_000_000n : fail('INTENTS_BAD_DEADLINE');
};

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : fail('INTENTS_MALFORMED');

/**
 * Throws `IntentsError` unless the 1Click status for `claim.depositAddress` is an unfunded
 * EXACT_INPUT swap of exactly `claim.amount` NEAR USDC to `claim.recipient`, refunding to
 * `claim.refundTo` inside Intents, and both deadlines outlive the signature.
 */
export function checkIntentsStatus(status: unknown, claim: IntentsClaim): void {
  const s = obj(status);
  const qr = obj(obj(s.quoteResponse).quoteRequest);
  const q = obj(obj(s.quoteResponse).quote);

  if (q.depositAddress !== claim.depositAddress) fail('INTENTS_DEPOSIT_ADDRESS_MISMATCH');
  // Anything already deposited, swapped or refunded must not get a second payment.
  if (s.status !== 'PENDING_DEPOSIT') fail('INTENTS_NOT_PENDING');
  if (qr.dry !== false) fail('INTENTS_MALFORMED');

  if (qr.originAsset !== NEAR_USDC_ASSET) fail('INTENTS_WRONG_ORIGIN_ASSET');
  if (qr.depositType !== 'ORIGIN_CHAIN') fail('INTENTS_WRONG_DEPOSIT_TYPE');
  // The contract pays with a plain ft_transfer and no memo.
  if ((qr.depositMode ?? 'SIMPLE') !== 'SIMPLE' || q.depositMemo != null) fail('INTENTS_MEMO_REQUIRED');

  // EXACT_INPUT refunds a deposit below `amount`, so a mismatch would turn the payout into a refund.
  if (qr.swapType !== 'EXACT_INPUT') fail('INTENTS_WRONG_SWAP_TYPE');
  if (!DECIMAL.test(claim.amount)) fail('INTENTS_BAD_AMOUNT');
  if (typeof qr.amount !== 'string' || !DECIMAL.test(qr.amount) || qr.amount !== claim.amount) {
    fail('INTENTS_AMOUNT_MISMATCH');
  }

  if (qr.destinationAsset !== claim.destinationAsset) fail('INTENTS_WRONG_DESTINATION_ASSET');
  if (qr.recipientType !== 'DESTINATION_CHAIN' || !sameAddress(qr.recipient, claim.recipient)) {
    fail('INTENTS_WRONG_RECIPIENT');
  }
  // These reroute the output (virtual chains, ft_transfer_call on NEAR); a plain payout never sets them.
  if (qr.virtualChainRecipient != null || qr.virtualChainRefundRecipient != null || qr.customRecipientMsg != null) {
    fail('INTENTS_WRONG_RECIPIENT');
  }

  if (qr.refundType !== 'INTENTS' || !sameAddress(qr.refundTo, claim.refundTo)) fail('INTENTS_WRONG_REFUND');

  // quote.deadline: address goes inactive and "funds may be lost"; quoteRequest.deadline: refunds begin.
  if (!DECIMAL.test(claim.expiresAtNs)) fail('INTENTS_BAD_DEADLINE');
  const exp = BigInt(claim.expiresAtNs);
  if (isoToNs(q.deadline) <= exp || isoToNs(qr.deadline) <= exp) fail('INTENTS_QUOTE_EXPIRES_FIRST');
}
