// Funding a send from another chain (T-019): NEAR Intents 1Click turns USDC on Base, Arbitrum or Ethereum into NEAR USDC
// in the sender's own connected account; the send itself (ft_transfer_call to the escrow) is unchanged. EXACT_OUTPUT:
// the sender asks for exactly what is missing and pays what 1Click quotes. Same limits as the payout leg (intents.ts).
// 1Click has no testnet: on testnet only dry quotes (live mainnet prices, no deposit address) are shown.

import {
  describeStatus, evmAddressError, MAX_CROSS_CHAIN_PAYOUT, MAX_LOSS_BPS, NEAR_USDC_ASSET, ONECLICK_API, PAYOUT_CHAINS, QuoteError,
  SLIPPAGE_BPS, type PayoutChain, type PayoutStatus, type StatusView,
} from '../intents';
import { middle } from '../claim';
import { SignatureError, verifyQuoteSignature } from '../oneclickSig';

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: Fetch = (u, i) => fetch(u, i);

/** The chains a send can be funded from: the payout leg's pinned Circle USDC on Base, Arbitrum and Ethereum. */
export const FUNDING_CHAINS: PayoutChain[] = PAYOUT_CHAINS;
const NEAR_USDC_DECIMALS = 6;
export const FUNDING_LIFETIME_MS = 60 * 60_000; // the request deadline: after it 1Click refunds a late deposit
/** 1Click has no testnet: testnet asks a dry mainnet quote for this existing mainnet account instead of the sender's. */
export const TESTNET_PREVIEW_RECIPIENT = 'near';

/** Over the cap: the sentence to show, before any quote; null when within it. */
export const fundingCapError = (amount: bigint): string | null =>
  amount > MAX_CROSS_CHAIN_PAYOUT ? 'Funding from another chain is up to 1,000 USDC per quote.' : null;

/**
 * The worst case keeps at least 98% of what the sender pays (exact, cross-multiplied): amountOut on NEAR against
 * amountIn on the origin chain, the most the deposit address asks for.
 */
export function fundingWithinLossBound(amountIn: string, amountOut: string, inDecimals: number): boolean {
  return BigInt(amountOut) * 10n ** BigInt(inDecimals) * 10_000n >= BigInt(amountIn) * 10n ** BigInt(NEAR_USDC_DECIMALS) * BigInt(10_000 - MAX_LOSS_BPS);
}

/** "Type its last 6 characters": the refund address is the sender's own, read twice. Case does not matter. */
export const refundConfirmed = (address: string, typed: string): boolean =>
  address.length >= 6 && typed.trim().toLowerCase() === address.slice(-6).toLowerCase();

export interface FundingArgs {
  chain: PayoutChain;
  amount: string; // NEAR USDC base units the sender's account must receive
  recipient: string; // the sender's connected NEAR account (testnet: TESTNET_PREVIEW_RECIPIENT)
  refundTo: string; // the sender's own address on the origin chain
  deadline: string; // ISO, FUNDING_LIFETIME_MS from now
}

/** The /v0/quote body. Only these fields: no appFees, referral, virtual-chain or custom recipient message. */
export const fundingRequest = (dry: boolean, a: FundingArgs) => ({
  dry, swapType: 'EXACT_OUTPUT', slippageTolerance: SLIPPAGE_BPS,
  originAsset: a.chain.assetId, depositType: 'ORIGIN_CHAIN',
  destinationAsset: NEAR_USDC_ASSET, amount: a.amount,
  recipient: a.recipient, recipientType: 'DESTINATION_CHAIN',
  refundTo: a.refundTo, refundType: 'ORIGIN_CHAIN', deadline: a.deadline,
});

export interface FundingQuote {
  amountIn: string; // origin-chain USDC base units: what to send
  amountInFormatted: string;
  amountOut: string; // NEAR USDC base units: what arrives
  amountOutFormatted: string;
  fee: string; // amountIn - amountOut, USDC base units (both sides have 6 decimals)
  timeEstimate: number; // seconds after the deposit confirms
  deadline: string; // ISO: send before this (real quotes: the address's own deadline)
  depositAddress?: string; // real quotes only
}

/**
 * POST /v0/quote, then refuse anything we did not ask for: the signature (pinned key), every signed request field,
 * the exact output, the loss bound and, for a real quote, an EVM deposit address. Refusals are QuoteError with a
 * sentence for the sender.
 */
export async function getFundingQuote(dry: boolean, a: FundingArgs, fetchFn: Fetch = defaultFetch, signer?: string): Promise<FundingQuote> {
  const cap = fundingCapError(BigInt(a.amount));
  if (cap) throw new QuoteError(cap); // before any quote
  const want = fundingRequest(dry, a);
  const res = await fetchFn(`${ONECLICK_API}/v0/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify(want),
  });
  const body = (await res.json().catch(() => ({}))) as { message?: string; quote?: Record<string, unknown>; quoteRequest?: Record<string, unknown> };
  if (res.status >= 400 && res.status < 500) throw new QuoteError(fundingRefusal(body.message ?? ''));
  if (!res.ok || !body.quote || !body.quoteRequest) throw new Error(`quote: HTTP ${res.status}`);
  try {
    await verifyQuoteSignature(body, signer);
  } catch (e) {
    if (e instanceof SignatureError) throw new QuoteError(CANNOT_CHECK);
    throw e;
  }
  const qr = body.quoteRequest;
  for (const [k, v] of Object.entries(want)) if (k !== 'deadline' && qr[k] !== v) throw new QuoteError(CANNOT_CHECK);
  if (qr.virtualChainRecipient != null || qr.virtualChainRefundRecipient != null || qr.customRecipientMsg != null) throw new QuoteError(CANNOT_CHECK);
  const q = body.quote;
  const amountIn = String(q.amountIn ?? ''), amountOut = String(q.amountOut ?? ''), minOut = String(q.minAmountOut ?? '');
  if (![amountIn, amountOut, minOut].every((x) => /^[1-9]\d{0,30}$/.test(x))) throw new QuoteError(CANNOT_CHECK);
  if (amountOut !== a.amount || BigInt(minOut) < BigInt(a.amount)) throw new QuoteError(CANNOT_CHECK);
  if (!fundingWithinLossBound(amountIn, amountOut, a.chain.decimals)) throw new QuoteError(TOO_COSTLY);
  const depositAddress = typeof q.depositAddress === 'string' ? q.depositAddress : undefined;
  if (!dry && (!depositAddress || evmAddressError(depositAddress))) throw new QuoteError(CANNOT_CHECK);
  return {
    amountIn, amountInFormatted: String(q.amountInFormatted ?? ''), amountOut, amountOutFormatted: String(q.amountOutFormatted ?? ''),
    fee: (BigInt(amountIn) > BigInt(amountOut) ? BigInt(amountIn) - BigInt(amountOut) : 0n).toString(),
    timeEstimate: Number(q.timeEstimate) || 0,
    deadline: !dry && typeof q.deadline === 'string' ? q.deadline : a.deadline,
    ...(dry ? {} : { depositAddress }),
  };
}

export const CANNOT_CHECK = 'The exchange quote could not be checked. Try again, or fund with USDC on NEAR.';
export const TOO_COSTLY = 'The exchange would cost more than 2% of this amount. Try a larger amount, or fund with USDC on NEAR.';

/** 1Click's own refusal in plain words; its raw message is never shown. */
export function fundingRefusal(message: string): string {
  if (/too low|too small|minimum/i.test(message)) return 'This amount is too low to fund from another chain. Fund with USDC on NEAR instead.';
  return 'The exchange cannot fund this right now. Try again later, or fund with USDC on NEAR.';
}

/**
 * The funding screen's line per 1Click status. done/ok/outcome come from the payout leg's describeStatus (same
 * statuses, same finality); only the words differ, because the money moves the other way. FAILED never promises a
 * refund: 1Click documents none, it handles the case by hand.
 */
export function describeFunding(s: StatusView, chainName: string, account: string, refundTo: string, depositAddress: string) {
  const { done, ok, outcome } = describeStatus(s, chainName, refundTo);
  const text: Record<PayoutStatus, string> = {
    PENDING_DEPOSIT: `Waiting for your USDC on ${chainName}.`,
    KNOWN_DEPOSIT_TX: `Your deposit is on ${chainName}. Waiting for it to confirm.`,
    PROCESSING: 'Converting it to USDC on NEAR.',
    SUCCESS: `Arrived: the USDC is in ${account} on NEAR.`,
    INCOMPLETE_DEPOSIT: `The deposit was less than the quote. 1Click refunds it to ${middle(refundTo, 6)} on ${chainName} by its deadline.`,
    REFUNDED: `Refunded to ${middle(refundTo, 6)} on ${chainName}.`,
    FAILED: `1Click is handling this manually, reference ${depositAddress}.`,
  };
  return { text: text[s.status] ?? 'Still processing at 1Click.', done, ok, outcome };
}

/** GET /v0/status every 5 s until a final status or `stop()`, for at most an hour; each answer goes to `onStatus`. */
export async function followFunding(
  depositAddress: string, onStatus: (s: StatusView) => boolean | void, isStopped: () => boolean,
  getStatusFn: (a: string) => Promise<StatusView | null>, wait = (ms: number) => new Promise((r) => setTimeout(r, ms)),
): Promise<'done' | 'stopped' | 'timeout'> {
  for (let i = 0; i < 720; i++) {
    if (isStopped()) return 'stopped';
    try {
      const s = await getStatusFn(depositAddress);
      if (s && onStatus(s)) return 'done';
    } catch {
      // a failed read says nothing about the deposit: ask again
    }
    await wait(5000);
  }
  return 'timeout';
}

/** A funding in flight, kept across reloads (nothing secret: the address and amounts are on chain anyway). */
export interface SavedFunding {
  chainKey: string;
  depositAddress: string;
  refundTo: string;
  amountIn: string;
  amountInFormatted: string;
  amountOut: string;
  deadline: string;
  status?: PayoutStatus;
}
const fundingKey = (contract: string, account: string) => `zarf-near:funding:${contract}/${account}`;

export function saveFunding(contract: string, account: string, f: SavedFunding | null, store?: Storage): void {
  try {
    const s = store ?? localStorage;
    if (f) s.setItem(fundingKey(contract, account), JSON.stringify(f));
    else s.removeItem(fundingKey(contract, account));
  } catch {
    // best effort: without it a reload loses the live status, never the deposit (1Click still has it)
  }
}

export function loadFunding(contract: string, account: string, store?: Storage): SavedFunding | null {
  try {
    const f = JSON.parse((store ?? localStorage).getItem(fundingKey(contract, account)) ?? 'null') as SavedFunding | null;
    return f && !evmAddressError(f.depositAddress) && FUNDING_CHAINS.some((c) => c.key === f.chainKey) && /^[1-9]\d*$/.test(f.amountIn) ? f : null;
  } catch {
    return null;
  }
}
