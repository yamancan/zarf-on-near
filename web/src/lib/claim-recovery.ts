import { isValidAccountId, loadReceipt, RECEIPT_TTL_MS, saveReceipt, type Attempt, type Receipt } from './claim';
import { settleClaim } from './services';

// Only public payment metadata. No OAuth token/state, link salt/proof, signature or account keys.
// Like receipts, keep this for 30 days so a recipient can reopen the email in another tab.
export type PendingClaim = Pick<Receipt, 'amount' | 'destination' | 'txHash' | 'passkey' | 'chainName' | 'depositAddress' | 'refundTo'> & { savedAt: number };
const key = (network: string, contract: string, campaign: string, commitment: string) => `zarf-near:pending:${network}/${contract}/${campaign}/${commitment}`;
const text = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

export function loadPendingClaim(network: string, contract: string, campaign: string, commitment: string, store?: Storage, now = Date.now()): PendingClaim | null {
  try {
    const s = store ?? localStorage;
    const p = JSON.parse(s.getItem(key(network, contract, campaign, commitment)) ?? 'null');
    if (!p || typeof p.amount !== 'string' || !/^[1-9]\d{0,38}$/.test(p.amount) || BigInt(p.amount) >= 1n << 128n ||
      !text(p.destination) || typeof p.txHash !== 'string' || (p.txHash !== '' && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p.txHash)) ||
      typeof p.savedAt !== 'number' || !Number.isFinite(p.savedAt) || p.savedAt > now) return null;
    if (now - p.savedAt >= RECEIPT_TTL_MS) {
      s.removeItem(key(network, contract, campaign, commitment));
      return null;
    }
    if (p.depositAddress !== undefined && (typeof p.depositAddress !== 'string' || !/^[0-9a-f]{64}$/.test(p.depositAddress))) return null;
    if (p.chainName !== undefined && (!text(p.chainName, 80) || !p.depositAddress || !text(p.refundTo, 64) || !isValidAccountId(p.refundTo))) return null;
    if (!p.chainName && !isValidAccountId(p.destination)) return null;
    return { amount: p.amount, destination: p.destination, txHash: p.txHash, savedAt: p.savedAt,
      ...(p.passkey === true ? { passkey: true } : {}),
      ...(p.chainName ? { chainName: p.chainName, depositAddress: p.depositAddress, refundTo: p.refundTo } : {}) };
  } catch { return null; }
}

/** Must succeed before sending: a disabled/full browser store must not create an untrackable payment. */
export function savePendingClaim(network: string, contract: string, a: Attempt, txHash = '', store?: Storage, now = Date.now()): void {
  const s = store ?? localStorage;
  const old = loadPendingClaim(network, contract, a.campaign, a.commitment, s, now);
  const p: PendingClaim = { amount: a.amount, destination: a.intents?.recipient ?? a.destination, txHash,
    savedAt: old?.savedAt ?? now, ...(a.passkey ? { passkey: true } : {}),
    ...(a.intents ? { chainName: a.intents.chainName, depositAddress: a.destination, refundTo: a.intents.refundTo } : {}) };
  s.setItem(key(network, contract, a.campaign, a.commitment), JSON.stringify(p));
}

export function clearPendingClaim(network: string, contract: string, campaign: string, commitment: string, store?: Storage): void {
  try { (store ?? localStorage).removeItem(key(network, contract, campaign, commitment)); } catch { /* best effort */ }
}

/**
 * Recovery has no submit/sign-in capability: reloads only read the chain, never replay a payment.
 * An unclaimed view, even past the polling grace, is not exact transaction failure evidence. Keep the
 * context until confirmation or its 30-day expiry; only an explicit live refusal can release it sooner.
 */
export async function recoverPendingClaim(
  network: string, contract: string, campaign: string, commitment: string, pending: PendingClaim,
  read: Parameters<typeof settleClaim>[0], store?: Storage, opts?: Parameters<typeof settleClaim>[1],
): Promise<{ state: 'claimed' | 'pending'; receipt: Receipt | null }> {
  const state = await settleClaim(read, opts);
  const now = opts?.now?.() ?? Date.now();
  let receipt: Receipt | null = null;
  if (state === 'claimed') {
    receipt = loadReceipt(contract, campaign, commitment, store, now) ??
      { ...pending, savedAt: now, at: now, ...(pending.chainName ? { bridge: 'in-transit' as const } : {}) };
    saveReceipt(contract, campaign, commitment, receipt, store, now);
    if (loadReceipt(contract, campaign, commitment, store, now)) clearPendingClaim(network, contract, campaign, commitment, store);
  }
  return { state: state === 'claimed' ? 'claimed' : 'pending', receipt };
}
