// Cross-chain payout through NEAR Intents 1Click (docs/spikes/T9b-plan.md). Mainnet only: the
// origin is mainnet NEAR USDC. The browser calls 1Click directly (CORS *, no key); the verifier
// re-reads the quote before it signs (verifier/src/intents.ts).

import { keccak_256 } from '@noble/hashes/sha3';
import { hex } from './claim';

export const ONECLICK_API = 'https://1click.chaindefuser.com';
export const NEAR_USDC_ASSET = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const USDC_DECIMALS = 6;
export const SLIPPAGE_BPS = 100; // the verifier refuses more
export const QUOTE_LIFETIME_MS = 60 * 60_000; // request deadline: refunds begin after it
export const MAX_LOSS_BPS = 500; // refuse a quote whose worst case loses more than 5% of the amount

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: Fetch = (u, i) => fetch(u, i);

/** EIP-55: all-lower or all-upper is accepted as is; mixed case must match the checksum (a typo guard). */
export function evmAddressError(address: string): string | null {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return 'Enter the full address: 0x followed by 40 letters and digits.';
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
  blockchain: string; // 1Click /v0/tokens `blockchain`
  placeholder: string;
  addressError(address: string): string | null;
  preflight?(address: string, fetchFn?: Fetch): Promise<string | null>;
  note: string;
}

const evmChain = (key: string, name: string): PayoutChain => ({
  key,
  name,
  blockchain: key,
  placeholder: '0x…',
  addressError: evmAddressError,
  note: `Paste your own ${name} wallet address. If it is an exchange address, make sure the exchange credits USDC on ${name} to it without a memo or tag.`,
});

/** Base first (the owner's pick); each is hidden at runtime if 1Click stops listing it. */
export const PAYOUT_CHAINS: PayoutChain[] = [evmChain('base', 'Base'), evmChain('arb', 'Arbitrum'), evmChain('eth', 'Ethereum')];

export interface PayoutAsset {
  chain: PayoutChain;
  assetId: string;
  decimals: number;
}

/** GET /v0/tokens → the allow-listed chains' USDC, in list order. */
export async function resolveAssets(fetchFn: Fetch = defaultFetch): Promise<PayoutAsset[]> {
  const res = await fetchFn(`${ONECLICK_API}/v0/tokens`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`tokens: HTTP ${res.status}`);
  const tokens = (await res.json()) as { assetId: string; blockchain: string; symbol: string; decimals: number }[];
  return PAYOUT_CHAINS.flatMap((chain) => {
    const t = tokens.find((x) => x.blockchain === chain.blockchain && x.symbol === 'USDC');
    return t && typeof t.assetId === 'string' && Number.isInteger(t.decimals) ? [{ chain, assetId: t.assetId, decimals: t.decimals }] : [];
  });
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

/** Worst-case loss in basis points of the amount: minAmountOut is after slippage and fees. */
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
export async function submitDeposit(depositAddress: string, txHash: string, fetchFn: Fetch = defaultFetch): Promise<void> {
  await fetchFn(`${ONECLICK_API}/v0/deposit/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ depositAddress, txHash }),
  }).catch(() => undefined);
}

/** What the receipt needs to resume following a payout after a reload. Nothing here is secret. */
export interface SavedPayout {
  depositAddress: string;
  txHash: string; // the NEAR claim tx
  chainName: string;
  recipient: string;
  refundTo: string;
  amountOutFormatted: string;
}

const payoutKey = (campaign: string, commitment: string) => `zarf-near:payout:${campaign}/${commitment}`;

export function savePayout(campaign: string, commitment: string, p: SavedPayout, store?: Storage): void {
  try {
    (store ?? sessionStorage).setItem(payoutKey(campaign, commitment), JSON.stringify(p));
  } catch {
    // best effort: without it a reload only loses the live status, never the claim
  }
}

export function loadPayout(campaign: string, commitment: string, store?: Storage): SavedPayout | null {
  try {
    const p = JSON.parse((store ?? sessionStorage).getItem(payoutKey(campaign, commitment)) ?? 'null') as SavedPayout | null;
    return p && /^[0-9a-f]{64}$/.test(p.depositAddress) && typeof p.chainName === 'string' && typeof p.refundTo === 'string' ? p : null;
  } catch {
    return null;
  }
}

/** Receipt copy per 1Click status (UI/UX audit, finding 10). */
export function describeStatus(s: StatusView, chainName: string, refundTo: string): { text: string; done: boolean; ok: boolean } {
  switch (s.status) {
    case 'PENDING_DEPOSIT':
    case 'KNOWN_DEPOSIT_TX':
      return { text: 'Sent from NEAR, waiting for the bridge.', done: false, ok: true };
    case 'PROCESSING':
      return { text: `Paying out on ${chainName}.`, done: false, ok: true };
    case 'SUCCESS':
      return { text: `Arrived on ${chainName}${s.amountOutFormatted ? `: ${s.amountOutFormatted} USDC` : ''}.`, done: true, ok: true };
    case 'REFUNDED':
      return { text: `Not delivered. The USDC went back to ${refundTo} on NEAR.${s.refundReason ? ` (${s.refundReason})` : ''}`, done: true, ok: false };
    default: // INCOMPLETE_DEPOSIT, FAILED, anything new
      return { text: 'Not delivered. Keep this page and contact the sender.', done: true, ok: false };
  }
}
