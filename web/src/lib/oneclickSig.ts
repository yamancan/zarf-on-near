// 1Click quote signature, checked in the browser: a copy of verifier/src/intents.ts verifyQuoteSignature (T-006),
// for a /v0/quote response (quoteRequest, quote, signature and timestamp at the top level). Keep the two in step.

/**
 * 1Click's quote-signing key, as pinned by @defuse-protocol/one-click-sdk-typescript 0.1.26 (`ONE_CLICK_MANAGER_PUB_KEY`);
 * docs.near-intents.org …/1click-api/verify-quote-signature. If 1Click rotates it, every quote fails closed here.
 */
export const ONECLICK_QUOTE_SIGNER = 'ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc';

/** 'unsigned': no signature or timestamp; 'bad': anything else that does not verify. */
export class SignatureError extends Error {
  constructor(readonly kind: 'unsigned' | 'bad') {
    super(kind === 'unsigned' ? 'INTENTS_QUOTE_UNSIGNED' : 'INTENTS_BAD_SIGNATURE');
  }
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  for (; n > 0n; n /= 58n) out = B58[Number(n % 58n)] + out;
  for (const b of bytes) {
    if (b) break;
    out = '1' + out;
  }
  return out;
}
function b58decode(s: string): Uint8Array<ArrayBuffer> {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new SignatureError('bad');
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

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const orU = (v: unknown) => v || undefined;
// The SDK's field selection (buildSignedQuoteRequest / buildSignedQuote, 0.1.26), as in the verifier.
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

/** The exact bytes 1Click signs: base58(sha256(stable JSON of the signed request + quote fields + timestamp)). */
export async function quoteSignedBytes(resp: unknown): Promise<Uint8Array<ArrayBuffer>> {
  const r = obj(resp);
  const message = signedQuoteMessage(obj(r.quoteRequest), obj(r.quote), r.timestamp);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message)));
  return new TextEncoder().encode(b58encode(digest));
}

/** Throws SignatureError unless the quote response carries 1Click's ed25519 signature by `signer`. */
export async function verifyQuoteSignature(resp: unknown, signer: string = ONECLICK_QUOTE_SIGNER): Promise<void> {
  const { signature, timestamp } = obj(resp);
  if (typeof signature !== 'string' || !signature || typeof timestamp !== 'string' || !timestamp) throw new SignatureError('unsigned');
  const sig = b58decode(signature.replace(/^ed25519:/, ''));
  const pub = b58decode(signer.replace(/^ed25519:/, ''));
  if (sig.length !== 64 || pub.length !== 32) throw new SignatureError('bad');
  const key = await crypto.subtle.importKey('raw', pub, 'Ed25519', false, ['verify']);
  if (!(await crypto.subtle.verify('Ed25519', key, sig, await quoteSignedBytes(resp)))) throw new SignatureError('bad');
}

/** Base58 with an `ed25519:` prefix (tests sign with it). */
export const ed25519B58 = (bytes: Uint8Array): string => `ed25519:${b58encode(bytes)}`;
