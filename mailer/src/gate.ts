// MailGate: one Durable Object per campaign (idFromName(campaign_id)). It holds which commitments already got
// their email and how many went out, and runs one request at a time, so a double click or a replay never sends
// twice and a campaign never passes CAP. It stores commitments only, never an email or a salt.

import { CAP } from './notify';

type Storage = { get<T>(k: string): Promise<T | undefined>; put(k: string, v: unknown): Promise<void>; delete(k: string): Promise<boolean> };

export async function gateStep(storage: Storage, op: string, commitmentHex: string, cap = CAP): Promise<string> {
  const key = `c:${commitmentHex}`;
  const count = (await storage.get<number>('count')) ?? 0;
  if (op === 'reserve') {
    if (await storage.get(key)) return 'already';
    if (count >= cap) return 'cap';
    await storage.put(key, 1);
    await storage.put('count', count + 1);
    return 'ok';
  }
  if (op === 'release' && (await storage.get(key))) {
    await storage.delete(key);
    await storage.put('count', Math.max(0, count - 1));
  }
  return 'ok';
}

export class MailGate {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly state: { storage: Storage }) {}

  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const op = u.searchParams.get('op') ?? '';
    const c = u.searchParams.get('c') ?? '';
    if (!/^(reserve|release)$/.test(op) || !/^[0-9a-f]{64}$/.test(c)) return Response.json({ result: 'bad' }, { status: 400 });
    const run = this.queue.then(() => gateStep(this.state.storage, op, c));
    this.queue = run.catch(() => {});
    return Response.json({ result: await run });
  }
}
