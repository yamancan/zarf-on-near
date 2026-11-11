// Cross-chain payout through NEAR Intents 1Click (docs/spikes/T9b-plan.md). Mainnet only: the
// origin is mainnet NEAR USDC. The browser calls 1Click directly (CORS *, no key); the verifier
// re-reads the quote before it signs (verifier/src/intents.ts).

import { keccak_256 } from '@noble/hashes/sha3';
import { hex, saveReceipt, type BridgeOutcome, type Receipt } from './claim';

export const ONECLICK_API = 'https://1click.chaindefuser.com';
export const NEAR_USDC_ASSET = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const USDC_DECIMALS = 6;
export const SLIPPAGE_BPS = 100; // the verifier refuses more
export const QUOTE_LIFETIME_MS = 60 * 60_000; // request deadline: refunds begin after it
export const MAX_LOSS_BPS = 200; // refuse a quote whose worst case loses more than 2% of the amount (owner, 12 Nov)
/** Largest cross-chain payout, NEAR USDC base units: 1,000 USDC (owner, 12 Nov). The verifier enforces the same. */
export const MAX_CROSS_CHAIN_PAYOUT = 1_000_000_000n;
/** Over the cap: the sentence to show, before any quote or sign-in; null when within it. */
export const payoutCapError = (amount: string): string | null =>
  BigInt(amount) > MAX_CROSS_CHAIN_PAYOUT ? 'Payouts to another chain are up to 1,000 USDC each. Claim this one to a NEAR account.' : null;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: Fetch = (u, i) => fetch(u, i);

/** EIP-55: all-lower or all-upper is accepted as is; mixed case must match the checksum (a typo guard). */
export function evmAddressError(address: string): string | null {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return 'Enter the full address: 0x followed by 40 letters and digits.';
  if (/^0x0{40}$/i.test(address)) return 'That is the zero address; nobody can use funds sent there.';
  const body = address.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return null;
  const h = hex(keccak_256(body.toLowerCase()));
  for (let i = 0; i < 40; i++) {
    const c = body[i];
    if (/[a-f]/i.test(c) && (c === c.toUpperCase()) !== parseInt(h[i], 16) >= 8) {
      return 'This address has a typo: its capital letters do not match its checksum.';
    }
  }
  return null;
}

/**
 * A chain the recipient can be paid on. Every listed chain must be memo-free: we never send a
 * memo or tag. A chain that needs more checks before a quote (Stellar: account, trustline,
 * memo_required) adds them through `preflight` and its own `note`; the page stays the same.
 */
export interface PayoutChain {
  key: string;
  name: string;
  assetId: string; // pinned: never looked up by symbol (a lookalike 'USDC' could be listed first)
  decimals: number; // pinned, not taken from /v0/tokens
  placeholder: string;
  addressError(address: string): string | null;
  preflight?(address: string, fetchFn?: Fetch): Promise<string | null>;
  note: string;
}

const evmChain = (key: string, name: string, usdc: string): PayoutChain => ({
  key,
  name,
  assetId: `nep141:${key}-${usdc}.omft.near`,
  decimals: 6,
  placeholder: '0x…',
  addressError: evmAddressError,
  note: `Paste your own ${name} wallet address. If it is an exchange address, make sure the exchange credits USDC on ${name} to it without a memo or tag.`,
});

/** Base first (the owner's pick); each is hidden at runtime if 1Click stops listing it. */
// Circle's native USDC contracts; the verifier pins the same three asset ids (verifier/src/intents.ts).
export const PAYOUT_CHAINS: PayoutChain[] = [
  evmChain('base', 'Base', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
  evmChain('arb', 'Arbitrum', '0xaf88d065e77c8cc2239327c5edb3a432268e5831'),
  evmChain('eth', 'Ethereum', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
];

export interface PayoutAsset {
  chain: PayoutChain;
  assetId: string;
  decimals: number;
}

/** GET /v0/tokens only says which pinned assets 1Click routes today; ids and decimals stay ours. */
export async function resolveAssets(fetchFn: Fetch = defaultFetch): Promise<PayoutAsset[]> {
  const res = await fetchFn(`${ONECLICK_API}/v0/tokens`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`tokens: HTTP ${res.status}`);
  const listed = new Set(((await res.json()) as { assetId?: unknown }[]).map((t) => t.assetId));
  return PAYOUT_CHAINS.filter((c) => listed.has(c.assetId)).map((chain) => ({ chain, assetId: chain.assetId, decimals: chain.decimals }));
}

export interface QuoteArgs {
  amount: string; // leaf amount, NEAR USDC base units
  assetId: string;
  recipient: string;
  refundTo: string; // the campaign sender, read from get_campaign
  deadline: string; // ISO; QUOTE_LIFETIME_MS from now
}

export interface Quote {
  amountOut: string;
  amountOutFormatted: string;
  minAmountOut: string;
  timeEstimate: number; // seconds after the deposit
  depositAddress?: string; // real quotes only
}

/** A quote 1Click refused, with its own message (bad address, amount too low, route gone). */
export class QuoteError extends Error {}

/** POST /v0/quote. Only the fields the verifier accepts: no appFees, referral or custom message. */
export async function getQuote(dry: boolean, a: QuoteArgs, fetchFn: Fetch = defaultFetch): Promise<Quote> {
  const res = await fetchFn(`${ONECLICK_API}/v0/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      dry, swapType: 'EXACT_INPUT', slippageTolerance: SLIPPAGE_BPS,
      originAsset: NEAR_USDC_ASSET, depositType: 'ORIGIN_CHAIN',
      destinationAsset: a.assetId, amount: a.amount,
      recipient: a.recipient, recipientType: 'DESTINATION_CHAIN',
      refundTo: a.refundTo, refundType: 'ORIGIN_CHAIN', deadline: a.deadline,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { message?: string; quote?: Quote };
  if (res.status >= 400 && res.status < 500) throw new QuoteError(body.message || 'The quote was refused.');
  if (!res.ok || !body.quote) throw new Error(`quote: HTTP ${res.status}`);
  if (!dry && !/^[0-9a-f]{64}$/.test(body.quote.depositAddress ?? '')) throw new Error('quote: no deposit address');
  return body.quote;
}

/** Whether the worst case keeps at least 98% of the amount (exact, the verifier's check: no rounding to whole bps). */
export function withinLossBound(amount: string, minAmountOut: string, decimals: number): boolean {
  const out = (BigInt(minAmountOut) * 10n ** BigInt(USDC_DECIMALS)) / 10n ** BigInt(decimals);
  return out * 10_000n >= BigInt(amount) * BigInt(10_000 - MAX_LOSS_BPS);
}

/** Worst-case loss in basis points of the amount (display): minAmountOut is after slippage and fees. */
export function lossBps(amount: string, minAmountOut: string, decimals: number): number {
  const a = BigInt(amount);
  const out = (BigInt(minAmountOut) * 10n ** BigInt(USDC_DECIMALS)) / 10n ** BigInt(decimals);
  return a > out ? Number(((a - out) * 10_000n) / a) : 0;
}

export type PayoutStatus = 'PENDING_DEPOSIT' | 'KNOWN_DEPOSIT_TX' | 'PROCESSING' | 'SUCCESS' | 'INCOMPLETE_DEPOSIT' | 'REFUNDED' | 'FAILED';

export interface StatusView {
  status: PayoutStatus;
  amountOutFormatted?: string;
  destinationTx?: { hash: string; explorerUrl?: string };
  refundReason?: string;
}

/** GET /v0/status; null for an address 1Click does not know (404). */
export async function getStatus(depositAddress: string, fetchFn: Fetch = defaultFetch): Promise<StatusView | null> {
  const res = await fetchFn(`${ONECLICK_API}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, { signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`status: HTTP ${res.status}`);
  const b = (await res.json()) as {
    status: PayoutStatus;
    swapDetails?: { amountOutFormatted?: string; destinationChainTxHashes?: { hash: string; explorerUrl?: string }[]; refundReason?: string };
  };
  return {
    status: b.status,
    amountOutFormatted: b.swapDetails?.amountOutFormatted,
    destinationTx: b.swapDetails?.destinationChainTxHashes?.[0],
    refundReason: b.swapDetails?.refundReason,
  };
}

/** Tells 1Click which NEAR tx paid the deposit address (speeds it up). Failures are ignored. */
/**
 * POST /v0/deposit/submit (1Click openapi, 12 Nov 2026: txHash and depositAddress required; nearSenderAccount "used
 * only for NEAR"): the claim tx that paid the deposit address, and its NEAR signer (the relayer), so 1Click can find
 * it at once. Optional speed-up: failures are ignored.
 */
export async function submitDeposit(depositAddress: string, txHash: string, nearSenderAccount?: string, fetchFn: Fetch = defaultFetch): Promise<void> {
  await fetchFn(`${ONECLICK_API}/v0/deposit/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHash, depositAddress, ...(nearSenderAccount ? { nearSenderAccount } : {}) }),
  }).catch(() => undefined);
}

/**
 * Whether the claim card offers "Another chain". Testnet: shown, its chains marked "mainnet only". Mainnet: hidden
 * until PUBLIC_CROSS_CHAIN=on, which the owner sets after his first cross-chain smoke reaches SUCCESS (second audit M1).
 */
export const crossChainOffered = (network: string, flag: string | undefined): boolean => network !== 'mainnet' || flag === 'on';

/** What the receipt needs to resume following a payout after a reload. Nothing here is secret. */
export interface SavedPayout {
  depositAddress: string;
  txHash: string; // the NEAR claim tx
  chainName: string;
  recipient: string;
  refundTo: string;
  amountOutFormatted: string;
  amount: string; // the link's amount, NEAR USDC base units: what the receipt shows until the bridge confirms
}

// The contract id is in the key, as in the receipt key: the same host has served more than one contract.
const payoutKey = (contract: string, campaign: string, commitment: string) => `zarf-near:payout:${contract}/${campaign}/${commitment}`;

export function savePayout(contract: string, campaign: string, commitment: string, p: SavedPayout, store?: Storage): void {
  try {
    (store ?? sessionStorage).setItem(payoutKey(contract, campaign, commitment), JSON.stringify(p));
  } catch {
    // best effort: without it a reload only loses the live status, never the claim
  }
}

export function loadPayout(contract: string, campaign: string, commitment: string, store?: Storage): SavedPayout | null {
  try {
    const p = JSON.parse((store ?? sessionStorage).getItem(payoutKey(contract, campaign, commitment)) ?? 'null') as SavedPayout | null;
    return p && /^[0-9a-f]{64}$/.test(p.depositAddress) && typeof p.chainName === 'string' && typeof p.refundTo === 'string' && /^[1-9]\d{0,38}$/.test(p.amount) ? p : null;
  } catch {
    return null;
  }
}

/**
 * Receipt copy per 1Click status, held to what 1Click's docs say (docs.near-intents.org, 1click-api status table,
 * read 2026-11-12). `outcome` is what may be remembered: only SUCCESS is 'paid', only REFUNDED is 'refunded'
 * ("funds returned to refund address"). FAILED is only "Swap encountered an error": no refund is documented,
 * so nothing here says it goes back. INCOMPLETE_DEPOSIT "is refunded by deadline": 'refunding', polled on until
 * REFUNDED. `done` ends the live polling: SUCCESS, REFUNDED, FAILED. Statuses we do not know: still processing.
 * The bridge's refund reason is never in `text`: the receipt shows it under Details.
 */
export function describeStatus(s: StatusView, chainName: string, refundTo: string): { text: string; done: boolean; ok: boolean; outcome: BridgeOutcome } {
  switch (s.status) {
    case 'PENDING_DEPOSIT':
    case 'KNOWN_DEPOSIT_TX':
      return { text: 'Sent from NEAR, waiting for the bridge.', done: false, ok: true, outcome: 'in-transit' };
    case 'PROCESSING':
      return { text: `Paying out on ${chainName}.`, done: false, ok: true, outcome: 'in-transit' };
    case 'SUCCESS':
      return { text: `Arrived on ${chainName}.`, done: true, ok: true, outcome: 'paid' };
    case 'REFUNDED':
      return { text: `Went back to ${refundTo} on NEAR.`, done: true, ok: false, outcome: 'refunded' };
    case 'FAILED':
      return { text: `The bridge reported an error and has not paid out on ${chainName}.`, done: true, ok: false, outcome: 'failed' };
    case 'INCOMPLETE_DEPOSIT':
      return { text: `The bridge did not accept the deposit. It refunds ${refundTo} on NEAR by its deadline.`, done: false, ok: false, outcome: 'refunding' };
    default: // anything new: not an outcome, keep asking
      return { text: 'Still processing on the bridge.', done: false, ok: true, outcome: 'in-transit' };
  }
}

/**
 * What happens next after a payout that did not arrive, in the recipient's words. Same on the receipt and the record.
 * For 'failed' it never says the USDC goes back: 1Click documents no refund for FAILED.
 */
export function nextStep(outcome: BridgeOutcome): string {
  if (outcome === 'failed') return 'Tell the sender. They can ask NEAR Intents support, with the deposit address under Details.';
  if (outcome === 'refunded' || outcome === 'refunding') return 'The sender can send you a new link.'; // the row above says where it goes
  return '';
}

/** The line under Details for a failed payout: what was true at the last check, never a promise. */
export const notReturnedYet = (refundTo: string, checked: string): string =>
  `Not returned to ${refundTo} as of the last check (${checked}).`;

/**
 * A remembered cross-chain record asks the bridge again: the tab that followed the payout may have closed
 * (round 3 money item 1). Saves what the bridge says and when; `done` once the bridge reports a final status.
 * A failed read throws and changes nothing; an address the bridge does not know is no answer.
 */
export async function recheckReceipt(
  contract: string, campaign: string, commitment: string, r: Receipt, fetchFn: Fetch = defaultFetch, store?: Storage, now = Date.now(),
): Promise<{ r: Receipt; done: boolean }> {
  if (!r.chainName || !r.depositAddress) return { r, done: true };
  const s = await getStatus(r.depositAddress, fetchFn);
  if (!s) return { r, done: false };
  const v = describeStatus(s, r.chainName, r.refundTo ?? 'the sender');
  const next: Receipt = { ...r, bridge: v.outcome, checkedAt: now, ...(v.outcome === 'paid' && s.amountOutFormatted && /^\d+(\.\d+)?$/.test(s.amountOutFormatted) ? { amountOut: s.amountOutFormatted } : {}) };
  saveReceipt(contract, campaign, commitment, next, store, now);
  return { r: next, done: v.done };
}

/** Records worth asking the bridge about again: cross-chain, with a deposit address, and not yet paid or refunded. */
export const needsRecheck = (r: Receipt | null): boolean => !!r?.chainName && !!r.depositAddress && (r.bridge === 'in-transit' || r.bridge === 'refunding' || r.bridge === 'failed');

/** A refused quote in plain words; the bridge's raw message is never shown (critic r2 P2-7). */
export function refusal(message: string, chainName: string): string {
  if (/up to 1,000 USDC/.test(message)) return message; // our own cap, already plain
  if (/too low|too small|minimum/i.test(message)) return `This amount is too low to send to ${chainName}. Claim to a NEAR account instead.`;
  if (/price moved|pay too little/i.test(message)) return 'The bridge would pay too little: the price moved too far.';
  return `The bridge cannot pay this out to ${chainName} right now. Claim to a NEAR account instead.`;
}
