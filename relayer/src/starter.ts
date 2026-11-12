// Testnet only (owner decision "gas A"): after a paid claim, a destination with almost no NEAR gets
// 0.02 test NEAR once, so the recipient can move their USDC (an ft_transfer needs gas and 1 yocto).
// It is sent from a separate gas account with its own key (GAS_KEY): the relayer's claim-only key
// never signs it. Off unless STARTER_NEAR=on, and refused outright on anything but testnet.

import { base58Decode, signTransferTx, type NearKey } from './near';
import { RpcError, viewAccessKey, viewAccount, type Rpc } from './rpc';

export const STARTER_YOCTO = 20_000_000_000_000_000_000_000n; // 0.02 NEAR
export const STARTER_TEXT = '0.02';
const DEST_ENOUGH_YOCTO = 5_000_000_000_000_000_000_000n; // 0.005 NEAR: a destination holding this gets nothing
const GAS_FLOOR_YOCTO = 500_000_000_000_000_000_000_000n; // 0.5 NEAR: below this the gas account stops sending
export const DAILY_CAP = 50;
const DAY_MS = 86_400_000;

/** The subset of Workers KV used here; a Map-backed fake implements it in tests. */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

export interface StarterConfig {
  enabled: string | undefined; // STARTER_NEAR: "on" enables it on testnet
  network: string;
  contractId: string;
  gasAccountId: string | undefined;
  gasKeySecret: string | undefined;
  relayerKeySecret: string;
  kv: KvLike | undefined;
}

/**
 * True only for an explicit "on" on testnet with every piece configured. Mainnet can never enable it:
 * the network, the escrow and the gas account must all be testnet, and the gas key must not be the relayer's.
 */
export const starterAllowed = (c: StarterConfig): boolean =>
  c.enabled === 'on' &&
  c.network === 'testnet' &&
  c.contractId.endsWith('.testnet') &&
  !!c.gasAccountId?.endsWith('.testnet') &&
  !!c.gasKeySecret &&
  c.gasKeySecret !== c.relayerKeySecret &&
  !!c.kv;

export type StarterOutcome =
  | { result: 'sent'; tx_hash: string }
  | { result: 'already' | 'funded' | 'cap' | 'low' | 'not_creatable' };

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
 * ever: the mark is written before the transfer, so a failed send is never retried for that account.
 * shortcut: KV is not atomic; two claims to the same new account within a second could both pass the
 * mark (the second then sees the first 0.02 and stops, unless both land before either is read). Fine for
 * test NEAR; use a Durable Object if this ever moves real money.
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

  await d.kv.put(mark, '1');
  await d.kv.put(dayKey, String(sentToday + 1), { expirationTtl: 2 * 86_400 });

  const ak = await viewAccessKey(d.rpc, d.gasAccountId, d.gasKey.publicKeyStr);
  const { signed, hash } = await signTransferTx(d.gasKey.key, {
    signerId: d.gasAccountId, publicKey: d.gasKey.publicKey, nonce: BigInt(ak.nonce) + 1n, receiverId: destination,
    blockHash: base58Decode(ak.block_hash), deposit: STARTER_YOCTO,
  });
  await d.rpc.call('send_tx', { signed_tx_base64: btoa(String.fromCharCode(...signed)), wait_until: 'EXECUTED_OPTIMISTIC' });
  return { result: 'sent', tx_hash: hash };
}
