// Cross-chain claim (design §4.4, spike S3). Defence in depth: before signing a claim whose
// destination is a 1Click deposit address, the verifier re-reads that quote and checks it
// agrees with what the recipient asked for. The real bindings are elsewhere: the Google nonce
// binds the deposit address, and the merkle leaf binds the amount. 1Click's quote `signature`
// is verified too (`verifyQuoteSignature`), so the fields it covers do not rest on TLS alone.
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
 * The only payout assets: Circle's native USDC, each 1Click id checked on 14 Nov 2026 against Circle's contract list
 * (developers.circle.com/stablecoins/usdc-contract-addresses). The claim page pins the same ids
 * (web/src/lib/intents.ts PAYOUT_CHAINS); a lookalike "USDC" that 1Click lists is never accepted.
 * Each entry: decimals, and the address format a recipient on that chain must have.
 */
type AddressKind = 'evm' | 'solana' | 'hex64';
const PAYOUT: ReadonlyArray<[string, number, AddressKind]> = [
  ['nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', 6, 'evm'],
  ['nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', 6, 'evm'],
  ['nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', 6, 'evm'],
  ['nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ', 6, 'evm'], // Optimism 0x0b2c…ff85
  ['nep141:pol-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omdep.near', 6, 'evm'], // Polygon PoS
  ['nep141:avax-0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e.omdep.near', 6, 'evm'], // Avalanche C-Chain
  ['nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx', 6, 'evm'], // Monad 0x7547…b603
  ['nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', 6, 'solana'], // EPjF…Dt1v
  ['nep141:sui-c1b81ecaf27933252d31a963bc5e9458f13c18ce.omft.near', 6, 'hex64'], // 0xdba3…::usdc::USDC
  ['nep141:aptos-34ee497f210c5a511e8d5b53bc56d75b63612bb5.omft.near', 6, 'hex64'], // 0xbae2…6f3b
];
export const PAYOUT_ASSETS: ReadonlyMap<string, number> = new Map(PAYOUT.map(([id, d]) => [id, d]));
const PAYOUT_ADDRESS: ReadonlyMap<string, AddressKind> = new Map(PAYOUT.map(([id, , k]) => [id, k]));
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

const HEX64 = /^0x[0-9a-fA-F]{64}$/;
const BASE58_32 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// Hex addresses (EVM, Sui, Aptos) are case-insensitive; every other format (Solana base58) is compared exactly.
const sameAddress = (a: unknown, b: string): boolean =>
  typeof a === 'string' && ((EVM.test(a) && EVM.test(b)) || (HEX64.test(a) && HEX64.test(b)) ? a.toLowerCase() === b.toLowerCase() : a === b);

const P25519 = 2n ** 255n - 19n;
const D25519 = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const powP = (b: bigint, e: bigint): bigint => {
  let r = 1n;
  for (b %= P25519; e > 0n; e >>= 1n, b = (b * b) % P25519) if (e & 1n) r = (r * b) % P25519;
  return r;
};
/** Solana's on-curve test (curve25519-dalek decompression). Off-curve addresses (token accounts, PDAs) have no key. */
function ed25519OnCurve(key: Uint8Array): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? key[i] & 0x7f : key[i]);
  const y2 = (y * y) % P25519;
  const x2 = (((y2 - 1n + P25519) % P25519) * powP((D25519 * y2 + 1n) % P25519, P25519 - 2n)) % P25519;
  return x2 === 0n || powP(x2, (P25519 - 1n) / 2n) === 1n;
}
const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Whether `address` can be a wallet on the chain of payout asset `assetId` (never all zeros; web/src/lib/intents.ts agrees). */
export function recipientFits(assetId: string, address: string): boolean {
  switch (PAYOUT_ADDRESS.get(assetId)) {
    case 'evm':
      return EVM.test(address) && !/^0x0{40}$/i.test(address);
    case 'hex64':
      return HEX64.test(address) && !/^0x0{64}$/i.test(address);
    case 'solana':
      if (!BASE58_32.test(address) || /^1+$/.test(address) || address === SOLANA_USDC_MINT) return false;
      const key = b58decode(address);
      return key.length === 32 && ed25519OnCurve(key);
    default:
      return false;
  }
}

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
  if (qr.recipientType !== 'DESTINATION_CHAIN' || !sameAddress(qr.recipient, claim.recipient) || !recipientFits(claim.destinationAsset, claim.recipient)) {
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

/**
 * 1Click's quote-signing key, as pinned by @defuse-protocol/one-click-sdk-typescript 0.1.26
 * (`ONE_CLICK_MANAGER_PUB_KEY`); docs: docs.near-intents.org …/1click-api/verify-quote-signature.
 * If 1Click rotates it, every cross-chain claim fails closed with INTENTS_BAD_SIGNATURE until this is updated.
 */
export const ONECLICK_QUOTE_SIGNER = 'ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  for (; n > 0n; n /= 58n) out = B58[Number(n % 58n)] + out;
  for (const b of bytes) { if (b) break; out = '1' + out; }
  return out;
}
function b58decode(s: string): Uint8Array<ArrayBuffer> {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) fail('INTENTS_BAD_SIGNATURE');
    n = n * 58n + BigInt(i);
  }
  const body: number[] = [];
  for (; n > 0n; n >>= 8n) body.unshift(Number(n & 0xffn));
  const lead = s.length - s.replace(/^1+/, '').length;
  return Uint8Array.from([...new Array<number>(lead).fill(0), ...body]);
}

/** json-stable-stringify 1.3: keys sorted, `undefined` members dropped, no whitespace. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : stableStringify(x))).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

// The SDK's field selection (buildSignedQuoteRequest / buildSignedQuote, 0.1.26). Falsy optional
// fields become undefined and drop out, exactly as there. appFees, depositMode and confidentiality
// are not signed; checkIntentsStatus bounds them.
const orU = (v: unknown) => v || undefined;
function signedQuoteMessage(qr: Record<string, unknown>, q: Record<string, unknown>, timestamp: unknown): string {
  const req = {
    dry: qr.dry, swapType: qr.swapType, slippageTolerance: qr.slippageTolerance, originAsset: qr.originAsset,
    depositType: qr.depositType, destinationAsset: qr.destinationAsset, amount: qr.amount, refundTo: qr.refundTo,
    refundType: qr.refundType, recipient: qr.recipient, recipientType: qr.recipientType, deadline: qr.deadline,
    quoteWaitingTimeMs: orU(qr.quoteWaitingTimeMs), referral: orU(qr.referral), virtualChainRecipient: orU(qr.virtualChainRecipient),
    virtualChainRefundRecipient: orU(qr.virtualChainRefundRecipient), customRecipientMsg: orU(qr.customRecipientMsg),
  };
  const priced = {
    amountIn: q.amountIn, amountInFormatted: q.amountInFormatted, amountInUsd: q.amountInUsd, minAmountIn: q.minAmountIn,
    amountOut: q.amountOut, amountOutFormatted: q.amountOutFormatted, amountOutUsd: q.amountOutUsd, minAmountOut: q.minAmountOut,
  };
  const quote = qr.dry
    ? priced
    : {
        ...priced, depositAddress: orU(q.depositAddress), depositMemo: orU(q.depositMemo), deadline: orU(q.deadline),
        timeWhenInactive: orU(q.timeWhenInactive), timeEstimate: orU(q.timeEstimate), refundFee: orU(q.refundFee), withdrawFee: orU(q.withdrawFee),
      };
  return stableStringify({ ...req, ...quote, timestamp });
}

/**
 * Throws `IntentsError` unless `status.quoteResponse` carries 1Click's ed25519 signature over
 * base58(sha256(stable JSON of the signed request + quote fields + timestamp)), by `signer`.
 * No signature or timestamp: INTENTS_QUOTE_UNSIGNED. Any other mismatch: INTENTS_BAD_SIGNATURE.
 */
export async function verifyQuoteSignature(status: unknown, signer: string = ONECLICK_QUOTE_SIGNER): Promise<void> {
  const resp = obj(obj(status).quoteResponse);
  const { signature, timestamp } = resp;
  if (typeof signature !== 'string' || !signature || typeof timestamp !== 'string' || !timestamp) fail('INTENTS_QUOTE_UNSIGNED');
  const sig = b58decode((signature as string).replace(/^ed25519:/, ''));
  const pub = b58decode(signer.replace(/^ed25519:/, ''));
  if (sig.length !== 64 || pub.length !== 32) fail('INTENTS_BAD_SIGNATURE');
  const key = await crypto.subtle.importKey('raw', pub, 'Ed25519', false, ['verify']);
  if (!(await crypto.subtle.verify('Ed25519', key, sig, await quoteSignedBytes(status)))) fail('INTENTS_BAD_SIGNATURE');
}

/** The exact bytes 1Click signs for `status.quoteResponse` (exported for tests that re-sign a quote). */
export async function quoteSignedBytes(status: unknown): Promise<Uint8Array<ArrayBuffer>> {
  const resp = obj(obj(status).quoteResponse);
  const message = signedQuoteMessage(obj(resp.quoteRequest), obj(resp.quote), resp.timestamp);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message)));
  return new TextEncoder().encode(b58encode(digest));
}

/** Base58 with an `ed25519:` prefix, the format 1Click uses for keys and signatures (tests sign with it). */
export const ed25519B58 = (bytes: Uint8Array): string => `ed25519:${b58encode(bytes)}`;
