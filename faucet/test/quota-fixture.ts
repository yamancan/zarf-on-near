import { QuotaLedger, type QuotaNamespace, type QuotaStorage } from '../src/quota';

/** Transactional storage boundary double: clone for isolation and roll back rejected writes. */
export function memoryQuota() {
  const records = new Map<string, unknown>();
  let tail: Promise<unknown> = Promise.resolve();
  let writeFailures = 0;
  const storage: QuotaStorage = {
    transaction(fn) {
      const run = tail.then(async () => {
        const next = structuredClone(records);
        const result = await fn({
          get: async <T>(key: string) => next.get(key) as T | undefined,
          put: async (key, value) => { if (writeFailures-- > 0) throw new Error('storage unavailable'); next.set(key, structuredClone(value)); },
        });
        records.clear();
        for (const [key, value] of next) records.set(key, value);
        return result;
      });
      tail = run.catch(() => undefined);
      return run;
    },
  };
  const days = new Map<string, QuotaLedger>();
  const namespace: QuotaNamespace = { getByName: (day) => {
    let ledger = days.get(day);
    if (!ledger) {
      const prefixStorage: QuotaStorage = { transaction: (fn) => storage.transaction((tx) => fn({
        get: (key) => tx.get(`${day}:${key}`), put: (key, value) => tx.put(`${day}:${key}`, value),
      })) };
      ledger = new QuotaLedger(prefixStorage);
      days.set(day, ledger);
    }
    return ledger;
  } };
  return { namespace, records, failWrites: (n: number) => { writeFailures = n; } };
}
