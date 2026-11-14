// Testnet only (owner decision "gas A"): after a paid claim, a destination with almost no NEAR gets
// 0.02 test NEAR once, so the recipient can move their USDC (an ft_transfer needs gas and 1 yocto).
// It is sent from a separate gas account with its own key (GAS_KEY): the relayer's claim-only key
// never signs it. Off unless STARTER_NEAR=on, and refused outright on anything but testnet.
// Every send goes through one Durable Object (StarterGate), one at a time: that is what makes
// "once per destination", the daily cap and the gas account's nonces hold under concurrent claims.

import { claimEvent } from './relay';
import { base58Decode, parseNearKey, signTransferTx, type NearKey } from './near';
import { httpRpc, RpcError, viewAccessKey, viewAccount, type Rpc } from './rpc';

export const STARTER_YOCTO = 20_000_000_000_000_000_000_000n; // 0.02 NEAR
export const STARTER_TEXT = '0.02';
const DEST_ENOUGH_YOCTO = 5_000_000_000_000_000_000_000n; // 0.005 NEAR: a destination holding this gets nothing
const GAS_FLOOR_YOCTO = 500_000_000_000_000_000_000_000n; // 0.5 NEAR: below this the gas account stops sending
export const DAILY_CAP = 50;
const DAY_MS = 86_400_000;

/** The storage used here: StarterGate's Durable Object storage; a Map-backed fake in tests. */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface StarterConfig {
  enabled: string | undefined; // STARTER_NEAR: "on" enables it on testnet
  network: string;
  contractId: string;
  gasAccountId: string | undefined;
  gasKeySecret: string | undefined;
  relayerAccountId: string;
  relayerKeySecret: string;
  gate: unknown; // the STARTER Durable Object binding
}

const str = (v: unknown): v is string => typeof v === 'string' && v !== '';

/**
 * True only for an explicit "on" on testnet with every piece configured. Mainnet can never enable it:
 * the network, the escrow and the gas account must all be testnet, the gas account and key must not be
 * the relayer's; and sendStarter also asks the RPC for its chain id before signing anything.
 */
export const starterAllowed = (c: StarterConfig): boolean =>
  c.enabled === 'on' &&
  c.network === 'testnet' &&
  str(c.contractId) && c.contractId.endsWith('.testnet') &&
  str(c.gasAccountId) && c.gasAccountId.endsWith('.testnet') &&
  c.gasAccountId !== c.relayerAccountId &&
  str(c.gasKeySecret) &&
  c.gasKeySecret !== c.relayerKeySecret &&
  !!c.gate;

export type StarterOutcome =
  | { result: 'sent' | 'failed' | 'pending'; tx_hash: string }
  | { result: 'already' | 'funded' | 'cap' | 'low' | 'not_creatable' | 'not_testnet' | 'error' };

/** A 64-hex implicit account or a NEP-518 0x account: a transfer creates it when it does not exist yet. */
const creatable = (id: string) => /^[0-9a-f]{64}$/.test(id) || /^0x[0-9a-f]{40}$/.test(id);
const unknownAccount = (e: unknown) => e instanceof RpcError && /UNKNOWN_ACCOUNT|does not exist/.test(JSON.stringify(e.detail));

export interface StarterDeps {
  rpc: Rpc;
  gasAccountId: string;
  gasKey: NearKey;
  kv: KvLike;
  nowMs?: number;
}

/**
 * Once per successful payment. Persist a pending hash before sending and reconcile it on retry:
 * a timeout is ambiguous, so it must never permit another payment. Legacy '1' marks stay complete.
 * StarterGate serialises calls sharing this storage.
 */
export async function sendStarter(destination: string, d: StarterDeps): Promise<StarterOutcome> {
  const mark = `dest:${destination}`;
  const previous = await d.kv.get(mark);
  if (previous === '1') return { result: 'already' };
  const finish = async (out: { status?: { SuccessValue?: string; Failure?: unknown } }, hash: string): Promise<StarterOutcome> => {
    if (out.status && 'SuccessValue' in out.status) {
      await d.kv.put(mark, '1');
      return { result: 'sent', tx_hash: hash };
    }
    if (out.status && 'Failure' in out.status) {
      await d.kv.put(mark, '');
      return { result: 'failed', tx_hash: hash };
    }
    return { result: 'pending', tx_hash: hash };
  };
  if (previous) {
    const pending = JSON.parse(previous) as { hash: string; sender: string };
    try {
      const out = await d.rpc.call('tx', { tx_hash: pending.hash, sender_account_id: pending.sender, wait_until: 'EXECUTED_OPTIMISTIC' });
      return finish(out as { status?: { SuccessValue?: string; Failure?: unknown } }, pending.hash);
    } catch {
      return { result: 'pending', tx_hash: pending.hash };
    }
  }

  let balance: bigint | null;
  try {
    balance = BigInt((await viewAccount(d.rpc, destination)).amount);
  } catch (e) {
    if (!unknownAccount(e)) throw e;
    balance = null;
  }
  if (balance === null && !creatable(destination)) return { result: 'not_creatable' };
  if (balance !== null && balance >= DEST_ENOUGH_YOCTO) return { result: 'funded' };

  const dayKey = `day:${Math.floor((d.nowMs ?? Date.now()) / DAY_MS)}`;
  const sentToday = Number((await d.kv.get(dayKey)) ?? 0);
  if (sentToday >= DAILY_CAP) return { result: 'cap' };
  if (BigInt((await viewAccount(d.rpc, d.gasAccountId)).amount) < GAS_FLOOR_YOCTO) return { result: 'low' };
  if ((await d.rpc.call<{ chain_id: string }>('status', [])).chain_id !== 'testnet') return { result: 'not_testnet' };

  const ak = await viewAccessKey(d.rpc, d.gasAccountId, d.gasKey.publicKeyStr);
  // A lagging RPC node can show a nonce we already used; never go below our own last one.
  const last = BigInt((await d.kv.get('nonce')) ?? 0);
  const nonce = BigInt(ak.nonce) + 1n > last + 1n ? BigInt(ak.nonce) + 1n : last + 1n;
  await d.kv.put(dayKey, String(sentToday + 1));
  await d.kv.put('nonce', String(nonce));

  const { signed, hash } = await signTransferTx(d.gasKey.key, {
    signerId: d.gasAccountId, publicKey: d.gasKey.publicKey, nonce, receiverId: destination,
    blockHash: base58Decode(ak.block_hash), deposit: STARTER_YOCTO,
  });
  await d.kv.put(mark, JSON.stringify({ hash, sender: d.gasAccountId }));
  const out = await d.rpc.call<{ status?: { SuccessValue?: string; Failure?: unknown } }>('send_tx', { signed_tx_base64: btoa(String.fromCharCode(...signed)), wait_until: 'EXECUTED_OPTIMISTIC' });
  return finish(out, hash);
}

export interface GateEnv {
  STARTER_NEAR?: string;
  NETWORK: string;
  CONTRACT_ID: string;
  RELAYER_ACCOUNT_ID: string;
  RELAYER_KEY: string;
  NEAR_RPC_URL: string;
  GAS_ACCOUNT_ID: string;
  GAS_KEY: string;
}
const RPC_TIMEOUT_MS = 8_000;
/** How long a paid claim's answer waits for the starter send; past this it answers without it. */
export const STARTER_WAIT_MS = 8_000;

export interface ClaimFollowUp {
  txHash: string;
  destination: string;
  commitment: string;
  contractId: string;
  relayerAccountId: string;
  paid: boolean;
}

type ClaimJob = ClaimFollowUp & { expiresAt: number; nextAt: number; attempts: number };
interface GateStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}
const JOB_PREFIX = 'claim:';
const FOLLOW_UP_MS = 24 * 60 * 60 * 1_000;
const RETRY_MAX_MS = 60_000;

/**
 * One Durable Object serialises gas transfers and durable claim follow-ups. Alarms outlive both
 * the HTTP response and the isolate. A claim's own paid receipt, never claim_state alone, permits
 * its destination's top-up. Jobs back off to one minute and expire after 24 hours.
 */
export class StarterGate {
  private queue: Promise<unknown> = Promise.resolve();
  private gasKey?: { secret: string; key: Promise<NearKey> };
  constructor(
    private readonly state: { storage: GateStorage },
    private readonly env: GateEnv,
  ) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => {});
    return run;
  }

  async fetch(req: Request): Promise<Response> {
    try {
      const result = await this.serial(async () => {
        if (req.method === 'POST') return this.follow(await req.json() as ClaimFollowUp);
        return this.send(new URL(req.url).searchParams.get('d') ?? '');
      });
      return Response.json(result);
    } catch {
      this.gasKey = undefined;
      return Response.json({ result: 'error' } satisfies StarterOutcome);
    }
  }

  private rpc(): Rpc {
    return httpRpc(this.env.NEAR_RPC_URL, (u, i) => fetch(u, { ...i, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) }));
  }

  private async follow(claim: ClaimFollowUp): Promise<StarterOutcome> {
    const storage = this.state.storage;
    const key = JOB_PREFIX + claim.txHash;
    const job = await storage.get<ClaimJob>(key) ?? { ...claim, expiresAt: Date.now() + FOLLOW_UP_MS, nextAt: Date.now() + 1_000, attempts: 0 };
    // Arm before persisting: a restart between writes can only leave an extra harmless alarm.
    const alarm = await storage.getAlarm();
    if (alarm === null || alarm > job.nextAt) await storage.setAlarm(job.nextAt);
    await storage.put(key, job);
    if (!job.paid) return { result: 'pending', tx_hash: job.txHash };
    const result = await this.process(key, job);
    await this.schedule();
    return result;
  }

  async alarm(): Promise<void> {
    return this.serial(async () => {
      const storage = this.state.storage;
      // Rearm before external I/O so a restart or an outage cannot strand the remaining jobs.
      await storage.setAlarm(Date.now() + RETRY_MAX_MS);
      const jobs = await storage.list<ClaimJob>({ prefix: JOB_PREFIX });
      let processed = 0;
      for (const [key, job] of jobs) {
        if (job.expiresAt <= Date.now()) {
          await storage.delete(key);
          console.log('starter_expired');
        } else if (job.nextAt <= Date.now() && processed < 10) {
          processed++;
          await this.process(key, job);
        }
      }
      await this.schedule();
    });
  }

  private async process(key: string, job: ClaimJob): Promise<StarterOutcome> {
    const storage = this.state.storage;
    let result: StarterOutcome = { result: 'pending', tx_hash: job.txHash };
    try {
      if (!job.paid) {
        const out = await this.rpc().call<Parameters<typeof claimEvent>[0]>('tx', {
          tx_hash: job.txHash, sender_account_id: job.relayerAccountId, wait_until: 'EXECUTED_OPTIMISTIC',
        });
        const event = claimEvent(out, job.contractId, job.commitment);
        if (event === 'claim_reverted' || (out.status?.Failure && event !== 'claim_started' && event !== 'claim_paid')) {
          await storage.delete(key);
          return { result: 'failed', tx_hash: job.txHash };
        }
        if (event === 'claim_paid') {
          job.paid = true;
          await storage.put(key, job);
        }
      }
      if (job.paid) result = await this.send(job.destination);
    } catch {
      this.gasKey = undefined;
      result = { result: 'error' };
    }
    if (['sent', 'already', 'funded', 'not_creatable', 'not_testnet'].includes(result.result)) {
      await storage.delete(key);
    } else {
      job.attempts++;
      job.nextAt = Date.now() + Math.min(RETRY_MAX_MS, 1_000 * 2 ** Math.min(job.attempts, 6));
      await storage.put(key, job);
    }
    return result;
  }

  private async schedule(): Promise<void> {
    const storage = this.state.storage;
    const jobs = await storage.list<ClaimJob>({ prefix: JOB_PREFIX });
    if (!jobs.size) return storage.deleteAlarm();
    let next = Infinity;
    for (const job of jobs.values()) next = Math.min(next, job.nextAt, job.expiresAt);
    await storage.setAlarm(Math.max(Date.now() + 1_000, next));
  }

  private async send(destination: string): Promise<StarterOutcome> {
    const { GAS_ACCOUNT_ID, GAS_KEY } = this.env;
    // Recheck at execution time: saved jobs and legacy internal GETs must respect later config changes.
    if (!starterAllowed({ enabled: this.env.STARTER_NEAR, network: this.env.NETWORK, contractId: this.env.CONTRACT_ID,
      gasAccountId: GAS_ACCOUNT_ID, gasKeySecret: GAS_KEY, relayerAccountId: this.env.RELAYER_ACCOUNT_ID,
      relayerKeySecret: this.env.RELAYER_KEY, gate: this })) return { result: 'error' };
    if (this.gasKey?.secret !== GAS_KEY) this.gasKey = { secret: GAS_KEY, key: parseNearKey(GAS_KEY) };
    const storage = this.state.storage;
    return sendStarter(destination, {
      rpc: this.rpc(), gasAccountId: GAS_ACCOUNT_ID, gasKey: await this.gasKey.key,
      kv: { get: async (k) => (await storage.get<string>(k)) ?? null, put: (k, v) => storage.put(k, v) },
    });
  }
}
