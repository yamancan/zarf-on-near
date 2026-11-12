import { KeyPair, KeyPairEd25519, PublicKey } from '@near-js/crypto';
import { actionCreators, createTransaction, decodeSignedTransaction, encodeTransaction, Signature, SignedTransaction } from '@near-js/transactions';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import vectors from '../../spec/vectors.json';
import worker from '../src/index';
import { base58Encode, encodeTransferTx, parseNearKey, signTransferTx, type NearKey } from '../src/near';
import { RpcError, type Rpc } from '../src/rpc';
import { DAILY_CAP, sendStarter, starterAllowed, STARTER_YOCTO, type KvLike, type StarterConfig } from '../src/starter';

const unhex = (s: string) => Uint8Array.from(s.match(/../g)!, (x) => parseInt(x, 16));
const SECRET = `ed25519:${base58Encode(unhex(vectors.keys.signer_seed + vectors.keys.signer))}`;
const OTHER = KeyPairEd25519.fromRandom().toString(); // the gas account's own key, never the relayer's
const BLOCK = base58Encode(unhex('22'.repeat(32)));
const NEAR = 10n ** 24n;
const IMPLICIT = 'ab'.repeat(32);

const memKv = (): KvLike & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v) };
};

/** Accounts: id → yoctoNEAR balance; missing ids answer UNKNOWN_ACCOUNT, as the RPC does. */
function stubRpc(accounts: Record<string, bigint>) {
  const sent: Uint8Array[] = [];
  const rpc: Rpc = {
    async call<T>(method: string, params: any): Promise<T> {
      if (method === 'query' && params.request_type === 'view_account') {
        if (!(params.account_id in accounts)) throw new RpcError({ name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' } });
        return { amount: accounts[params.account_id].toString() } as T;
      }
      if (method === 'query' && params.request_type === 'view_access_key') return { nonce: 9, block_hash: BLOCK, permission: 'FullAccess' } as T;
      if (method === 'send_tx') {
        sent.push(Uint8Array.from(atob(params.signed_tx_base64), (c) => c.charCodeAt(0)));
        return { status: { SuccessValue: '' } } as T;
      }
      throw new Error(`unexpected rpc ${method}`);
    },
  };
  return { rpc, sent };
}

let key: NearKey;
beforeAll(async () => void (key = await parseNearKey(SECRET)));
const GAS = 'zarf-near-gas.testnet';
const deps = (accounts: Record<string, bigint>, kv = memKv(), nowMs = 1_800_000_000_000) => {
  const s = stubRpc({ [GAS]: 3n * NEAR, ...accounts });
  return { ...s, kv, d: { rpc: s.rpc, gasAccountId: GAS, gasKey: key, kv, nowMs } };
};

describe('transfer encoding (oracle: @near-js/transactions)', () => {
  it('borsh(Transaction) and borsh(SignedTransaction) of one Transfer match byte for byte', async () => {
    const tx = { signerId: GAS, publicKey: key.publicKey, nonce: 77n, receiverId: IMPLICIT, blockHash: unhex('11'.repeat(32)), deposit: STARTER_YOCTO };
    const ref = createTransaction(GAS, PublicKey.fromString(key.publicKeyStr), IMPLICIT, 77n, [actionCreators.transfer(STARTER_YOCTO)], unhex('11'.repeat(32)));
    expect(encodeTransferTx(tx)).toEqual(encodeTransaction(ref));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(encodeTransaction(ref))));
    const refSig = (KeyPair.fromString(SECRET as `ed25519:${string}`) as KeyPairEd25519).sign(digest).signature;
    const refSigned = new SignedTransaction({ transaction: ref, signature: new Signature({ keyType: 0, data: refSig }) }).encode();
    expect((await signTransferTx(key.key, tx)).signed).toEqual(new Uint8Array(refSigned));
  });
});

describe('sendStarter', () => {
  it('sends 0.02 NEAR from the gas account to a new implicit account, once, never twice', async () => {
    const t = deps({});
    expect(await sendStarter(IMPLICIT, t.d)).toMatchObject({ result: 'sent' });
    expect(t.sent).toHaveLength(1);
    const tx = decodeSignedTransaction(t.sent[0]).transaction;
    expect([tx.signerId, tx.receiverId, tx.actions[0].transfer?.deposit]).toEqual([GAS, IMPLICIT, STARTER_YOCTO]);
    expect(await sendStarter(IMPLICIT, t.d)).toEqual({ result: 'already' });
    expect(t.sent).toHaveLength(1);
  });
  it('also creates a NEP-518 0x account; a missing named account is never sent to', async () => {
    expect((await sendStarter('0x' + 'cd'.repeat(20), deps({}).d)).result).toBe('sent');
    const t = deps({});
    expect(await sendStarter('nobody.testnet', t.d)).toEqual({ result: 'not_creatable' });
    expect(t.sent).toHaveLength(0);
  });
  it('a destination holding 0.005 NEAR or more gets nothing; below that it gets the starter', async () => {
    expect((await sendStarter('rich.testnet', deps({ 'rich.testnet': 5n * 10n ** 21n }).d)).result).toBe('funded');
    expect((await sendStarter('poor.testnet', deps({ 'poor.testnet': 5n * 10n ** 21n - 1n }).d)).result).toBe('sent');
  });
  it('stops at the daily cap, and counts again the next UTC day', async () => {
    const kv = memKv();
    for (let i = 0; i < DAILY_CAP; i++) expect((await sendStarter(`${i}`.padStart(64, '0'), deps({}, kv).d)).result).toBe('sent');
    const over = deps({}, kv);
    expect(await sendStarter('f'.repeat(64), over.d)).toEqual({ result: 'cap' });
    expect(over.sent).toHaveLength(0);
    expect((await sendStarter('f'.repeat(64), deps({}, kv, 1_800_000_000_000 + 86_400_000).d)).result).toBe('sent');
  });
  it('stops when the gas account is below 0.5 NEAR, and marks nothing', async () => {
    const t = deps({ [GAS]: NEAR / 2n - 1n });
    expect(await sendStarter(IMPLICIT, t.d)).toEqual({ result: 'low' });
    expect(t.sent).toHaveLength(0);
    expect(t.kv.m.size).toBe(0);
  });
});

describe('starterAllowed: off by default, testnet only', () => {
  const on: StarterConfig = { enabled: 'on', network: 'testnet', contractId: 'zarf-near-1112.testnet', gasAccountId: GAS, gasKeySecret: OTHER, relayerKeySecret: SECRET, kv: memKv() };
  it('needs an explicit "on" and every piece configured', () => {
    expect(starterAllowed(on)).toBe(true);
    for (const over of [{ enabled: undefined }, { enabled: '' }, { enabled: 'true' }, { gasAccountId: undefined }, { gasKeySecret: undefined }, { kv: undefined }])
      expect(starterAllowed({ ...on, ...over })).toBe(false);
  });
  it('mainnet can never enable it, even with "on" set', () => {
    for (const over of [{ network: 'mainnet' }, { contractId: 'zarf.near' }, { gasAccountId: 'gas.near' }])
      expect(starterAllowed({ ...on, ...over })).toBe(false);
  });
  it('the gas key must not be the relayer key', () => expect(starterAllowed({ ...on, gasKeySecret: SECRET })).toBe(false));
});

describe('worker: after a paid claim only', () => {
  afterEach(() => (vi.unstubAllGlobals(), vi.useRealTimers(), vi.restoreAllMocks()));
  const { context, claims } = vectors;
  const valid = claims.valid[0].call_args;
  const allow = { limit: async () => ({ success: true }) };
  const env = (over: Record<string, unknown> = {}) => ({
    NETWORK: context.network, CONTRACT_ID: context.contract_id, RELAYER_ACCOUNT_ID: 'relayer.testnet', NEAR_RPC_URL: 'https://rpc.test',
    VERIFIER_SIGNERS: vectors.keys.signer, CLAIM_ORIGINS: '', RELAYER_KEY: SECRET, PER_IP: allow, PER_COMMITMENT: allow,
    STARTER_NEAR: 'on', GAS_ACCOUNT_ID: GAS, GAS_KEY: OTHER, STARTER_KV: memKv(), ...over,
  });
  // The relayer's RPC: claim-only key, the claim pays; the destination exists with 0 NEAR.
  const net = (paid = true) => {
    const transfers: string[] = [];
    vi.stubGlobal('fetch', async (_u: unknown, init: RequestInit) => {
      const { method, params } = JSON.parse(String(init.body));
      const ok = (result: unknown) => Response.json({ jsonrpc: '2.0', id: 1, result });
      const view = (v: unknown) => ok({ result: [...new TextEncoder().encode(JSON.stringify(v))] });
      if (method === 'query' && params.request_type === 'view_access_key') {
        const relayer = params.account_id === 'relayer.testnet';
        return ok({ nonce: 5, block_hash: BLOCK, permission: relayer ? { FunctionCall: { receiver_id: context.contract_id, method_names: ['claim'], allowance: null } } : 'FullAccess' });
      }
      if (method === 'query' && params.request_type === 'view_account') {
        if (params.account_id === GAS) return ok({ amount: (3n * NEAR).toString() });
        if (params.account_id === valid.destination) return ok({ amount: '0' }); // exists, holds no NEAR
        return Response.json({ jsonrpc: '2.0', id: 1, error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' } } });
      }
      if (method === 'query' && params.method_name === 'get_config') return view({ token_ids: ['usdc.testnet'] });
      if (method === 'query' && params.method_name === 'required_claim_gas') return view('150000000000000');
      if (method === 'send_tx') {
        const tx = decodeSignedTransaction(Uint8Array.from(atob(params.signed_tx_base64), (c) => c.charCodeAt(0))).transaction;
        if (tx.signerId === GAS) return (transfers.push(tx.receiverId), ok({ status: { SuccessValue: '' } }));
        const ev = `EVENT_JSON:${JSON.stringify({ standard: 'zarf-near', version: '1.0.0', event: paid ? 'claim_paid' : 'claim_started', data: [{ campaign_id: '7', commitment: valid.commitment }] })}`;
        return ok({ status: { SuccessValue: '' }, receipts_outcome: [{ outcome: { executor_id: context.contract_id, logs: [ev] } }] });
      }
      throw new Error(`unexpected ${method}`);
    });
    return transfers;
  };
  const post = async (e: Record<string, unknown>) => {
    vi.useFakeTimers({ now: Number(BigInt(context.now_ns) / 1_000_000n), toFake: ['Date'] });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await worker.fetch(new Request('https://r.test/claim', { method: 'POST', body: JSON.stringify(valid) }), e as never);
    return (await res.json()) as Record<string, unknown>;
  };

  it('a paid claim to an account with no NEAR says the starter NEAR was sent', async () => {
    const transfers = net();
    const body = await post(env());
    expect(body).toMatchObject({ status: 'paid', starter_near: '0.02' });
    expect(transfers).toEqual([valid.destination]);
  });
  it('off, on mainnet, or when the claim is not paid yet: no starter, the claim answer is unchanged', async () => {
    for (const [e, paid] of [[env({ STARTER_NEAR: '' }), true], [env({ NETWORK: 'mainnet' }), true], [env(), false]] as const) {
      const transfers = net(paid);
      const body = await post(e);
      expect(body.starter_near).toBeUndefined();
      expect(transfers).toEqual([]);
    }
  });
  it('a starter failure never changes the paid answer', async () => {
    net();
    const body = await post(env({ GAS_KEY: 'ed25519:broken' }));
    expect(body).toMatchObject({ status: 'paid' });
    expect(body.starter_near).toBeUndefined();
  });
});
