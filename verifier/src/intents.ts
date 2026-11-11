// Cross-chain claim (design §4.4, spike S3). Defence in depth: before signing a claim whose
// destination is a 1Click deposit address, the verifier re-reads that quote and checks it
// agrees with what the recipient asked for. The real bindings are elsewhere: the Google nonce
// binds the deposit address, and the merkle leaf binds the amount. 1Click's quote `signature`
// is not verified (no published key); this check trusts TLS to 1click.chaindefuser.com.
//
// One quote per claim: a deposit address must receive exactly one EXACT_INPUT deposit. A second
// claim paid to the same address is not part of the swap and ends up refunded to the campaign
// sender, not on the destination chain. `status == PENDING_DEPOSIT` narrows this but cannot close the
// race between two in-flight claims, so the claim app must never reuse a deposit address.

export const ONECLICK_API = 'https://1click.chaindefuser.com';
/** Mainnet NEAR USDC as 1Click names it (GET /v0/tokens). Intents has no testnet. */
export const NEAR_USDC_ASSET = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
/** The only `appFees` entry allowed: the 1 bp fee 1Click adds to keyless quotes (seen on every keyless quote, S3). */
export const ONECLICK_KEYLESS_FEE = { recipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd', maxBps: 25 };
/**
 * The only payout assets, with their decimals: Circle's native USDC on Base, Arbitrum and Ethereum
 * (contract addresses 0x8335…2913, 0xaf88…5831, 0xa0b8…eb48). The claim page pins the same ids;
 * a lookalike "USDC" that 1Click lists is never accepted.
 */
export const PAYOUT_ASSETS: ReadonlyMap<string, number> = new Map([
  ['nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', 6],
  ['nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', 6],
  ['nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', 6],
]);
const ORIGIN_DECIMALS = 6; // NEAR USDC
/** Worst case a quote may lose, as `minAmountOut` against the amount: the claim page refuses more too. */
export const MAX_LOSS_BPS = 200n; // 2% (owner, 12 Nov): the claim page refuses the same
/** Largest cross-chain payout, origin base units: 1,000 USDC (owner, 12 Nov). */
export const MAX_CROSS_CHAIN_PAYOUT = 1_000_000_000n;
/** Highest slippage we let a quote carry; above it `minAmountOut` drifts toward zero. */
export const MAX_SLIPPAGE_BPS = 100;
const FETCH_TIMEOUT_MS = 10_000;

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
  campaignSender: string; // get_campaign(id).sender, read from chain by the caller: refunds go back to the payer
  expiresAtNs: string; // u64 decimal
}

// 1Click deposit addresses for a NEAR origin are implicit accounts (S3).
const DEPOSIT_ADDRESS = /^[0-9a-f]{64}$/;

/** GET /v0/status for a deposit address. Keyless (S3). Returns the parsed body; check it with `checkIntentsStatus`. */
export async function fetchIntentsStatus(
  depositAddress: string,
  fetchFn: (url: string, init: RequestInit) => Promise<Response> = (u, i) => fetch(u, i),
  base = ONECLICK_API,
): Promise<unknown> {
  if (!DEPOSIT_ADDRESS.test(depositAddress)) fail('INTENTS_BAD_DEPOSIT_ADDRESS');
  const res = await fetchFn(`${base}/v0/status?depositAddress=${depositAddress}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 404) fail('INTENTS_QUOTE_NOT_FOUND');
  if (!res.ok) throw new Error(`1Click status failed: HTTP ${res.status}`);
  return res.json();
}

const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;

// Every quoteRequest key the status endpoint returned on 2026-11-10, plus customRecipientMsg.
// Any other non-null key fails closed: a new 1Click field must be reviewed before we sign.
const KNOWN_REQUEST_KEYS = new Set([
  'dry', 'swapType', 'depositMode', 'slippageTolerance', 'originAsset', 'depositType', 'destinationAsset',
  'amount', 'refundTo', 'refundType', 'recipient', 'recipientType', 'deadline', 'appFees',
  'virtualChainRecipient', 'virtualChainRefundRecipient', 'referral', 'confidentiality', 'customRecipientMsg',
]);

// EVM hex addresses are case-insensitive (checksum casing is cosmetic); every other format is compared exactly.
const sameAddress = (a: unknown, b: string): boolean =>
  typeof a === 'string' && (EVM.test(a) && EVM.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b);

const isoToNs = (s: unknown): bigint => {
  const ms = typeof s === 'string' ? Date.parse(s) : NaN;
  return Number.isFinite(ms) ? BigInt(ms) * 1_000_000n : fail('INTENTS_BAD_DEADLINE');
};

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : fail('INTENTS_MALFORMED');

function checkAppFees(fees: unknown): void {
  if (fees == null) return;
  if (!Array.isArray(fees) || fees.length > 1) fail('INTENTS_UNEXPECTED_FEE');
  for (const f of fees as unknown[]) {
    const e = obj(f);
    const bps = e.fee;
    if (
      e.recipient !== ONECLICK_KEYLESS_FEE.recipient ||
      typeof bps !== 'number' || !Number.isInteger(bps) || bps < 0 || bps > ONECLICK_KEYLESS_FEE.maxBps
    ) {
      fail('INTENTS_UNEXPECTED_FEE');
    }
  }
}

/**
 * Throws `IntentsError` unless the 1Click status for `claim.depositAddress` is an unfunded
 * EXACT_INPUT swap of exactly `claim.amount` NEAR USDC to `claim.recipient`, refunding on NEAR to
 * the campaign sender, with bounded fees and slippage, and both deadlines
 * outliving the signature.
 */
export function checkIntentsStatus(status: unknown, claim: IntentsClaim): void {
  const s = obj(status);
  const qr = obj(obj(s.quoteResponse).quoteRequest);
  const q = obj(obj(s.quoteResponse).quote);

  for (const [k, v] of Object.entries(qr)) if (v != null && !KNOWN_REQUEST_KEYS.has(k)) fail('INTENTS_UNKNOWN_FIELD');

  if (q.depositAddress !== claim.depositAddress) fail('INTENTS_DEPOSIT_ADDRESS_MISMATCH');
  // Anything already deposited, swapped or refunded must not get a second payment.
  if (s.status !== 'PENDING_DEPOSIT') fail('INTENTS_NOT_PENDING');
  if (qr.dry !== false) fail('INTENTS_MALFORMED');
  if ((qr.confidentiality ?? 'public') !== 'public') fail('INTENTS_MALFORMED');
  // We never set a referral; a future referral payout must not ride on a claim.
  if (qr.referral != null) fail('INTENTS_UNEXPECTED_FEE');

  if (qr.originAsset !== NEAR_USDC_ASSET) fail('INTENTS_WRONG_ORIGIN_ASSET');
  if (qr.depositType !== 'ORIGIN_CHAIN') fail('INTENTS_WRONG_DEPOSIT_TYPE');
  // The contract pays with a plain ft_transfer and no memo.
  if ((qr.depositMode ?? 'SIMPLE') !== 'SIMPLE' || q.depositMemo != null) fail('INTENTS_MEMO_REQUIRED');

  // EXACT_INPUT refunds a deposit below `amount`, so a mismatch would turn the payout into a refund.
  if (qr.swapType !== 'EXACT_INPUT') fail('INTENTS_WRONG_SWAP_TYPE');
  if (!DECIMAL.test(claim.amount)) fail('INTENTS_BAD_AMOUNT');
  if (BigInt(claim.amount) > MAX_CROSS_CHAIN_PAYOUT) fail('INTENTS_AMOUNT_TOO_HIGH');
  if (typeof qr.amount !== 'string' || !DECIMAL.test(qr.amount) || qr.amount !== claim.amount) {
    fail('INTENTS_AMOUNT_MISMATCH');
  }
  const slip = qr.slippageTolerance;
  if (typeof slip !== 'number' || !Number.isInteger(slip) || slip < 0 || slip > MAX_SLIPPAGE_BPS) {
    fail('INTENTS_SLIPPAGE_TOO_HIGH');
  }
  checkAppFees(qr.appFees);

  const decimals = PAYOUT_ASSETS.get(claim.destinationAsset);
  if (decimals === undefined || qr.destinationAsset !== claim.destinationAsset) fail('INTENTS_WRONG_DESTINATION_ASSET');
  // The worst case after fees and slippage, in origin units, must keep 98% of the amount (MAX_LOSS_BPS).
  const minOut = q.minAmountOut;
  if (typeof minOut !== 'string' || !DECIMAL.test(minOut)) fail('INTENTS_MALFORMED');
  // Cross-multiplied, so no unit conversion truncates (a 7-decimal asset at exactly 2% passes).
  if (BigInt(minOut as string) * 10n ** BigInt(ORIGIN_DECIMALS) * 10_000n < BigInt(claim.amount) * 10n ** BigInt(decimals!) * (10_000n - MAX_LOSS_BPS)) {
    fail('INTENTS_LOSS_TOO_HIGH');
  }
  if (qr.recipientType !== 'DESTINATION_CHAIN' || !sameAddress(qr.recipient, claim.recipient) || /^0x0{40}$/i.test(claim.recipient)) {
    fail('INTENTS_WRONG_RECIPIENT');
  }
  // These reroute the output (virtual chains, ft_transfer_call on NEAR); a plain payout never sets them.
  if (qr.virtualChainRecipient != null || qr.virtualChainRefundRecipient != null || qr.customRecipientMsg != null) {
    fail('INTENTS_WRONG_RECIPIENT');
  }

  // A failed swap must return to the payer on NEAR, never to a key the recipient may not hold
  // (an exchange deposit address has no withdrawable Intents account).
  if (qr.refundType !== 'ORIGIN_CHAIN' || qr.refundTo !== claim.campaignSender) fail('INTENTS_WRONG_REFUND');

  // quote.deadline: address goes inactive and "funds may be lost"; quoteRequest.deadline: refunds begin.
  if (!DECIMAL.test(claim.expiresAtNs)) fail('INTENTS_BAD_DEADLINE');
  const exp = BigInt(claim.expiresAtNs);
  if (isoToNs(q.deadline) <= exp || isoToNs(qr.deadline) <= exp) fail('INTENTS_QUOTE_EXPIRES_FIRST');
}
