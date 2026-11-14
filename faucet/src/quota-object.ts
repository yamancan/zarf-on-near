import { DurableObject } from 'cloudflare:workers';
import { QuotaLedger, type Reservation } from './quota';

/** Global daily cap requires all three quota dimensions to share the same daily object. */
export class FaucetQuota extends DurableObject {
  private readonly ledger = new QuotaLedger(this.ctx.storage);

  async reserve(input: Reservation) {
    // Retain the ledger for at least two days. Do not expire pending creations during their quota day.
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 2 * 86_400_000);
    return this.ledger.reserve(input);
  }
  commit(id: string) { return this.ledger.commit(id); }
  cancel(id: string) { return this.ledger.cancel(id); }
  async alarm() { await this.ctx.storage.deleteAll(); }
}
