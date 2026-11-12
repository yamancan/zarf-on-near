// Testnet only (owner decision "gas A"): after a paid claim, a destination with almost no NEAR gets
// 0.02 test NEAR once, so the recipient can move their USDC (an ft_transfer needs gas and 1 yocto).
// It is sent from a separate gas account with its own key (GAS_KEY): the relayer's claim-only key
// never signs it. Off unless STARTER_NEAR=on, and refused outright on anything but testnet.
// Every send goes through one Durable Object (StarterGate), one at a time: that is what makes
// "once per destination", the daily cap and the gas account's nonces hold under concurrent claims.

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
  | { result: 'sent' | 'failed'; tx_hash: string }
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
 * Sends the starter NEAR to `destination` if it needs it and the limits allow. Once per destination,
 * ever: the mark is written before the transfer, so a failed send is never retried for that account
 * (one recorded attempt, not one guaranteed payment). Callers must not run two of these at once on the
 * same storage: StarterGate serialises them.
 */
export async function sendStarter(destination: string, d: StarterDeps): Promise<StarterOutcome> {
  const mark = `dest:${destination}`;
  if (await d.kv.get(mark)) return { result: 'already' };

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
  await d.kv.put(mark, '1');
  await d.kv.put(dayKey, String(sentToday + 1));
  await d.kv.put('nonce', String(nonce));

  const { signed, hash } = await signTransferTx(d.gasKey.key, {
    signerId: d.gasAccountId, publicKey: d.gasKey.publicKey, nonce, receiverId: destination,
    blockHash: base58Decode(ak.block_hash), deposit: STARTER_YOCTO,
  });
  const out = await d.rpc.call<{ status?: object }>('send_tx', { signed_tx_base64: btoa(String.fromCharCode(...signed)), wait_until: 'EXECUTED_OPTIMISTIC' });
  return { result: out.status && 'SuccessValue' in out.status ? 'sent' : 'failed', tx_hash: hash };
}

export interface GateEnv {
  NEAR_RPC_URL: string;
  GAS_ACCOUNT_ID: string;
  GAS_KEY: string;
}
const RPC_TIMEOUT_MS = 8_000;
/** How long a paid claim's answer waits for the starter send; past this it answers without it. */
export const STARTER_WAIT_MS = 8_000;

/**
 * The single Durable Object instance (name "gas") that runs every starter send, one after another.
 * Its storage holds the per-destination marks, the daily counts and the gas account's last nonce.
 */
export class StarterGate {
  private queue: Promise<unknown> = Promise.resolve();
  private gasKey?: { secret: string; key: Promise<NearKey> };
  constructor(
    private readonly state: { storage: { get<T>(k: string): Promise<T | undefined>; put(k: string, v: unknown): Promise<void> } },
    private readonly env: GateEnv,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const destination = new URL(req.url).searchParams.get('d') ?? '';
    const run = this.queue.then(() => this.send(destination));
    this.queue = run.catch(() => {});
    try {
      return Response.json(await run);
    } catch {
      this.gasKey = undefined;
      return Response.json({ result: "error" } satisfies StarterOutcome);
    }
  }

  private async send(destination: string): Promise<StarterOutcome> {
    const { NEAR_RPC_URL, GAS_ACCOUNT_ID, GAS_KEY } = this.env;
    if (this.gasKey?.secret !== GAS_KEY) this.gasKey = { secret: GAS_KEY, key: parseNearKey(GAS_KEY) };
    const storage = this.state.storage;
    // Every RPC call is bounded so one stalled request cannot hold up the queue.
    const rpc = httpRpc(NEAR_RPC_URL, (u, i) => fetch(u, { ...i, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) }));
    return sendStarter(destination, {
      rpc, gasAccountId: GAS_ACCOUNT_ID, gasKey: await this.gasKey.key,
      kv: { get: async (k) => (await storage.get<string>(k)) ?? null, put: (k, v) => storage.put(k, v) },
    });
  }
}
