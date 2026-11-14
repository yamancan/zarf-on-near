import type { Limits } from './limits';

export type QuotaDecision = { ok: true } | { ok: false; code: 'RATE_LIMITED_IP' | 'RATE_LIMITED_EMAIL' | 'DAILY_CAP_REACHED' };
export interface Reservation { id: string; ip: string; email: string; limits: Limits; }
export interface QuotaStub {
  reserve(input: Reservation): Promise<QuotaDecision>;
  commit(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
}
export interface QuotaNamespace { getByName(name: string): QuotaStub; }
interface Ledger {
  total: number;
  ips: Record<string, number>;
  emails: Record<string, number>;
  reservations: Record<string, { email: string; status: 'pending' | 'committed' | 'cancelled' }>;
}
export interface QuotaTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}
export interface QuotaStorage {
  transaction<T>(fn: (txn: QuotaTransaction) => Promise<T>): Promise<T>;
}

/** One ledger per UTC day. Pending creations consume email quota until a definitive cancellation. */
export class QuotaLedger implements QuotaStub {
  constructor(private readonly storage: QuotaStorage) {}

  reserve(input: Reservation): Promise<QuotaDecision> {
    return this.storage.transaction(async (txn) => {
      const state = await txn.get<Ledger>('ledger') ?? { total: 0, ips: {}, emails: {}, reservations: {} };
      const prior = state.reservations[input.id];
      if (prior) return prior.status === 'cancelled' ? { ok: false, code: 'RATE_LIMITED_EMAIL' } : { ok: true };
      const ip = state.ips[input.ip] ?? 0, email = state.emails[input.email] ?? 0;
      if (ip >= input.limits.perIpPerDay) return { ok: false, code: 'RATE_LIMITED_IP' };
      if (email >= input.limits.perEmailPerDay) return { ok: false, code: 'RATE_LIMITED_EMAIL' };
      if (state.total >= input.limits.dailyCap) return { ok: false, code: 'DAILY_CAP_REACHED' };
      state.total++;
      state.ips[input.ip] = ip + 1;
      state.emails[input.email] = email + 1;
      state.reservations[input.id] = { email: input.email, status: 'pending' };
      await txn.put('ledger', state);
      return { ok: true };
    });
  }

  commit(id: string): Promise<void> { return this.finish(id, 'committed'); }
  cancel(id: string): Promise<void> { return this.finish(id, 'cancelled'); }

  private finish(id: string, status: 'committed' | 'cancelled'): Promise<void> {
    return this.storage.transaction(async (txn) => {
      const state = await txn.get<Ledger>('ledger');
      const reservation = state?.reservations[id];
      if (!state || !reservation) throw new Error('Unknown quota reservation');
      // A delayed cancel never releases a committed success, and replaying either operation is a no-op.
      if (reservation.status !== 'pending') return;
      if (status === 'cancelled') state.emails[reservation.email]--;
      reservation.status = status;
      await txn.put('ledger', state);
    });
  }
}

/** Retry only idempotent storage operations, never on-chain creates. */
export async function retryWrite<T>(operation: () => Promise<T>, delayMs = 100): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); } catch (error) {
      if (attempt === 2 || (error as { overloaded?: boolean } | null)?.overloaded) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** attempt));
    }
  }
}
