// MailGate: one Durable Object per counter (notify.ts names them: <contract>:campaign:<id>, <contract>:day:<UTC date>,
// <contract>:sender:<account>:<UTC date>). It records, per commitment, whether its email is "pending" (handed to
// Resend, outcome not yet known) or "sent", and how many slots the counter used. The whole record is one storage value, so every change is a single atomic put. It stores commitments only,
// never an email or a salt.

import { CAP } from './notify';
import type { GateResult } from './notify';

export const PENDING_RETRY_MS = 10 * 60_000; // a pending send older than this may be tried again (same Idempotency-Key)
export const PENDING_GIVE_UP_MS = 23 * 3_600_000; // Resend dedupes an Idempotency-Key for 24 h: never retry blindly after

type Mark = { s: 'pending' | 'sent'; t: number; f: number }; // t: last attempt, f: first attempt
type Record_ = { count: number; marks: Record<string, Mark> };
type Storage = { get<T>(k: string): Promise<T | undefined>; put(k: string, v: unknown): Promise<void> };

/**
 * reserve → 'ok' (send it now) | 'sent' (it went out) | 'pending' (another call is sending it) | 'cap'.
 * sent → marks it sent. release → frees a slot whose send definitely failed. A pending mark whose send was cut off
 * (timeout, crash) is retried after PENDING_RETRY_MS with the same Idempotency-Key, so Resend sends it at most once
 * within its 24-hour window; the slot is not counted twice. After PENDING_GIVE_UP_MS it answers 'stale' for good.
 */
export async function gateStep(storage: Storage, op: string, c: string, now: number, cap = CAP): Promise<GateResult> {
  const g = (await storage.get<Record_>('g')) ?? { count: 0, marks: {} };
  const m = g.marks[c];
  const out: GateResult = 'ok';
  if (op === 'reserve') {
    if (m?.s === 'sent') return 'sent';
    if (m?.s === 'pending' && now - m.f >= PENDING_GIVE_UP_MS) return 'stale';
    if (m?.s === 'pending' && now - m.t < PENDING_RETRY_MS) return 'pending';
    if (!m && g.count >= cap) return 'cap';
    if (!m) g.count += 1;
    g.marks[c] = { s: 'pending', t: now, f: m?.f ?? now };
  } else if (op === 'sent' && m) {
    g.marks[c] = { s: 'sent', t: now, f: m.f };
  } else if (op === 'release' && m?.s === 'pending') {
    delete g.marks[c];
    g.count = Math.max(0, g.count - 1);
  } else {
    return out;
  }
  await storage.put('g', g);
  return out;
}

export class MailGate {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly state: { storage: Storage }) {}

  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const op = u.searchParams.get('op') ?? '';
    const c = u.searchParams.get('c') ?? '';
    const cap = Number(u.searchParams.get('cap') ?? CAP);
    if (!/^(reserve|sent|release)$/.test(op) || !/^[0-9a-f]{64}$/.test(c) || !Number.isInteger(cap) || cap < 1) return Response.json({ result: 'bad' }, { status: 400 });
    const run = this.queue.then(() => gateStep(this.state.storage, op, c, Date.now(), cap));
    this.queue = run.catch(() => {});
    return Response.json({ result: await run });
  }
}
