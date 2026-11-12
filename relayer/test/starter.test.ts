import { KeyPair, KeyPairEd25519, PublicKey } from '@near-js/crypto';
import { actionCreators, createTransaction, decodeSignedTransaction, encodeTransaction, Signature, SignedTransaction } from '@near-js/transactions';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import vectors from '../../spec/vectors.json';
import worker from '../src/index';
import { base58Encode, encodeTransferTx, parseNearKey, signTransferTx, type NearKey } from '../src/near';
import { RpcError, type Rpc } from '../src/rpc';
import { DAILY_CAP, sendStarter, StarterGate, starterAllowed, STARTER_WAIT_MS, STARTER_YOCTO, type KvLike, type StarterConfig } from '../src/starter';

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

/** Durable Object storage as StarterGate sees it (absent keys read as undefined). */
const memStorage = () => {
  const m = new Map<string, unknown>();
  return { m, get: async <T>(k: string) => m.get(k) as T | undefined, put: async (k: string, v: unknown) => void m.set(k, v) };
};

/** Accounts: id → yoctoNEAR balance; missing ids answer UNKNOWN_ACCOUNT, as the RPC does. */
function stubRpc(accounts: Record<string, bigint>, chain = 'testnet', outcome: object = { SuccessValue: '' }) {
  const sent: Uint8Array[] = [];
  const rpc: Rpc = {
    async call<T>(method: string, params: any): Promise<T> {
      if (method === 'query' && params.request_type === 'view_account') {
        if (!(params.account_id in accounts)) throw new RpcError({ name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' } });
        return { amount: accounts[params.account_id].toString() } as T;
      }
      if (method === 'query' && params.request_type === 'view_access_key') return { nonce: 9, block_hash: BLOCK, permission: 'FullAccess' } as T;
      if (method === 'status') return { chain_id: chain } as T;
      if (method === 'send_tx') {
        sent.push(Uint8Array.from(atob(params.signed_tx_base64), (c) => c.charCodeAt(0)));
        return { status: outcome } as T;
      }
      throw new Error(`unexpected rpc ${method}`);
    },
  };
  return { rpc, sent };
}

let key: NearKey;
beforeAll(async () => void (key = await parseNearKey(SECRET)));
const GAS = 'zarf-near-gas.testnet';
const deps = (accounts: Record<string, bigint>, kv = memKv(), nowMs = 1_800_000_000_000, chain = 'testnet', outcome?: object) => {
  const s = stubRpc({ [GAS]: 3n * NEAR, ...accounts }, chain, outcome);
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
  it('stops when the gas account is below 0.5 NEAR, and marks nothing; at exactly 0.5 it still sends', async () => {
    const t = deps({ [GAS]: NEAR / 2n - 1n });
    expect(await sendStarter(IMPLICIT, t.d)).toEqual({ result: 'low' });
    expect(t.sent).toHaveLength(0);
    expect(t.kv.m.size).toBe(0);
    expect((await sendStarter(IMPLICIT, deps({ [GAS]: NEAR / 2n }).d)).result).toBe('sent');
  });
  it('refuses to sign when the RPC is not on testnet, and marks nothing', async () => {
    const t = deps({}, memKv(), undefined, 'mainnet');
    expect(await sendStarter(IMPLICIT, t.d)).toEqual({ result: 'not_testnet' });
    expect(t.sent).toHaveLength(0);
    expect(t.kv.m.size).toBe(0);
  });
  it('a transfer that fails on chain is reported as failed, not sent, and is not retried', async () => {
    const t = deps({}, memKv(), undefined, 'testnet', { Failure: { ActionError: {} } });
    expect(await sendStarter(IMPLICIT, t.d)).toMatchObject({ result: 'failed' });
    expect(await sendStarter(IMPLICIT, t.d)).toEqual({ result: 'already' });
  });
  it('never reuses its own last nonce when the RPC shows an older one', async () => {
    const t = deps({});
    await t.kv.put('nonce', '20'); // the RPC still answers 9
    await sendStarter(IMPLICIT, t.d);
    expect(decodeSignedTransaction(t.sent[0]).transaction.nonce).toBe(21n);
    expect(t.kv.m.get('nonce')).toBe('21');
  });
});

describe('StarterGate: one send at a time', () => {
  afterEach(() => vi.unstubAllGlobals());
  // A chain that never shows the starter arriving: only the gate's own marks and counts can stop a repeat.
  const chain = () => {
    const sent: { to: string; nonce: bigint }[] = [];
    vi.stubGlobal('fetch', async (_u: unknown, init: RequestInit) => {
      const { method, params } = JSON.parse(String(init.body));
      const ok = (result: unknown) => Response.json({ jsonrpc: '2.0', id: 1, result });
      await new Promise((r) => setTimeout(r, 1)); // let concurrent requests interleave
      if (method === 'status') return ok({ chain_id: 'testnet' });
      if (params.request_type === 'view_account') return ok({ amount: params.account_id === GAS ? (3n * NEAR).toString() : '0' });
      if (params.request_type === 'view_access_key') return ok({ nonce: 9 + sent.length, block_hash: BLOCK, permission: 'FullAccess' });
      const tx = decodeSignedTransaction(Uint8Array.from(atob(params.signed_tx_base64), (c) => c.charCodeAt(0))).transaction;
      sent.push({ to: tx.receiverId, nonce: tx.nonce });
      return ok({ status: { SuccessValue: '' } });
    });
    return sent;
  };
  const gate = (storage = memStorage()) => ({ storage, g: new StarterGate({ storage }, { NEAR_RPC_URL: 'https://rpc.test', GAS_ACCOUNT_ID: GAS, GAS_KEY: OTHER }) });
  const ask = (g: StarterGate, d: string) => g.fetch(new Request(`https://starter/?d=${d}`)).then((r) => r.json() as Promise<{ result: string }>);

  it('two concurrent claims to the same new account: one transfer, the other is told "already"', async () => {
    const sent = chain();
    const { g } = gate();
    const rs = await Promise.all([ask(g, IMPLICIT), ask(g, IMPLICIT)]);
    expect(rs.map((r) => r.result).sort()).toEqual(['already', 'sent']);
    expect(sent).toHaveLength(1);
  });
  it('a concurrent burst stops exactly at the daily cap, with distinct nonces', async () => {
    const sent = chain();
    const { g, storage } = gate();
    await storage.put(`day:${Math.floor(Date.now() / 86_400_000)}`, String(DAILY_CAP - 2));
    const rs = await Promise.all(['1', '2', '3', '4'].map((x) => ask(g, x.repeat(64))));
    expect(rs.map((r) => r.result).sort()).toEqual(['cap', 'cap', 'sent', 'sent']);
    expect(new Set(sent.map((s) => s.nonce)).size).toBe(2);
  });
  it('a failing send answers "error" and does not block the next one', async () => {
    const sent = chain();
    const { g } = gate();
    vi.stubGlobal('fetch', async () => { throw new Error('rpc down'); });
    expect(await ask(g, IMPLICIT)).toEqual({ result: 'error' });
    chain();
    expect((await ask(g, '0x' + 'cd'.repeat(20))).result).toBe('sent');
    expect(sent).toHaveLength(0); // the first chain saw nothing
  });
});

describe('starterAllowed: off by default, testnet only', () => {
  const on: StarterConfig = { enabled: 'on', network: 'testnet', contractId: 'zarf-near-1112.testnet', gasAccountId: GAS, gasKeySecret: OTHER,
    relayerAccountId: 'relayer.testnet', relayerKeySecret: SECRET, gate: {} };
  it('needs an explicit "on" and every piece configured; odd values are refused, never thrown', () => {
    expect(starterAllowed(on)).toBe(true);
    for (const over of [{ enabled: undefined }, { enabled: '' }, { enabled: 'true' }, { gasAccountId: undefined }, { gasKeySecret: undefined }, { gate: undefined },
      { gasAccountId: { a: 1 } as never }, { contractId: 7 as never }])
      expect(starterAllowed({ ...on, ...over })).toBe(false);
  });
  it('mainnet can never enable it, even with "on" set', () => {
    for (const over of [{ network: 'mainnet' }, { contractId: 'zarf.near' }, { gasAccountId: 'gas.near' }])
      expect(starterAllowed({ ...on, ...over })).toBe(false);
  });
  it('the gas key and the gas account must not be the relayer\'s', () => {
    expect(starterAllowed({ ...on, gasKeySecret: SECRET })).toBe(false);
    expect(starterAllowed({ ...on, gasAccountId: on.relayerAccountId })).toBe(false);
  });
});

it('the main module exports only what workerd accepts (handlers and the Durable Object class)', async () => {
  for (const [name, v] of Object.entries(await import('../src/index'))) expect([name, typeof v]).toEqual([name, name === 'default' ? 'object' : 'function']);
});

describe('worker: after a paid claim only', () => {
  afterEach(() => (vi.unstubAllGlobals(), vi.useRealTimers(), vi.restoreAllMocks()));
  const { context, claims } = vectors;
  const valid = claims.valid[0].call_args;
  const allow = { limit: async () => ({ success: true }) };
  const env = (over: Record<string, unknown> = {}) => {
    const e: Record<string, unknown> = {
      NETWORK: context.network, CONTRACT_ID: context.contract_id, RELAYER_ACCOUNT_ID: 'relayer.testnet', NEAR_RPC_URL: 'https://rpc.test',
      VERIFIER_SIGNERS: vectors.keys.signer, CLAIM_ORIGINS: '', RELAYER_KEY: SECRET, PER_IP: allow, PER_COMMITMENT: allow,
      STARTER_NEAR: 'on', GAS_ACCOUNT_ID: GAS, GAS_KEY: OTHER, ...over,
    };
    const g = new StarterGate({ storage: memStorage() }, e as never); // reads the same env, as the binding would
    return { STARTER: { idFromName: (n: string) => n, get: () => g }, ...e };
  };
  // The relayer's RPC: claim-only key, the claim pays; the destination exists with 0 NEAR.
  const net = (paid = true) => {
    const transfers: string[] = [];
    const signers: string[] = [];
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
      if (method === 'status') return ok({ chain_id: 'testnet' });
      if (method === 'query' && params.method_name === 'get_config') return view({ token_ids: ['usdc.testnet'] });
      if (method === 'query' && params.method_name === 'required_claim_gas') return view('150000000000000');
      if (method === 'query' && params.method_name === 'claim_state') return view('unclaimed');
      if (method === 'send_tx') {
        const tx = decodeSignedTransaction(Uint8Array.from(atob(params.signed_tx_base64), (c) => c.charCodeAt(0))).transaction;
        if (tx.signerId === GAS) return (transfers.push(tx.receiverId), signers.push(base58Encode(Uint8Array.from((tx.publicKey as unknown as { ed25519Key: { data: number[] } }).ed25519Key.data))), ok({ status: { SuccessValue: '' } }));
        const ev = `EVENT_JSON:${JSON.stringify({ standard: 'zarf-near', version: '1.0.0', event: paid ? 'claim_paid' : 'claim_started', data: [{ campaign_id: '7', commitment: valid.commitment }] })}`;
        return ok({ status: { SuccessValue: '' }, receipts_outcome: [{ outcome: { executor_id: context.contract_id, logs: [ev] } }] });
      }
      throw new Error(`unexpected ${method}`);
    });
    return Object.assign(transfers, { signers });
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
    expect([...transfers]).toEqual([valid.destination]);
    expect(transfers.signers).toEqual([KeyPair.fromString(OTHER as `ed25519:${string}`).getPublicKey().toString().slice('ed25519:'.length)]); // the gas key signed it
  });
  it('off, on mainnet, or when the claim is not paid yet: no starter, the claim answer is unchanged', async () => {
    // NETWORK=mainnet with a testnet-signed claim is refused before payment; mainnet itself is covered by starterAllowed and not_testnet above.
    for (const [e, paid] of [[env({ STARTER_NEAR: '' }), true], [env({ GAS_ACCOUNT_ID: 'relayer.testnet' }), true], [env(), false]] as const) {
      const transfers = net(paid);
      const body = await post(e);
      expect(body.starter_near).toBeUndefined();
      expect([...transfers]).toEqual([]);
    }
  });
  it('a starter failure or an odd config never changes the paid answer', async () => {
    for (const over of [{ GAS_KEY: 'ed25519:broken' }, { GAS_ACCOUNT_ID: { a: 1 } }]) {
      net();
      const body = await post(env(over));
      expect(body).toMatchObject({ status: 'paid' });
      expect(body.starter_near).toBeUndefined();
    }
  });
  it('a starter send that hangs never holds the paid answer past STARTER_WAIT_MS', async () => {
    net();
    const e = { ...env(), STARTER: { idFromName: (n: string) => n, get: () => ({ fetch: () => new Promise<Response>(() => {}) }) } };
    vi.useFakeTimers({ now: Number(BigInt(context.now_ns) / 1_000_000n), toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = worker.fetch(new Request('https://r.test/claim', { method: 'POST', body: JSON.stringify(valid) }), e as never);
    let done = false;
    void res.then(() => (done = true));
    // The claim's crypto runs on real time; keep moving the fake clock until the answer arrives (never, without the deadline).
    for (let i = 0; !done && i < 400; i++) {
      await new Promise((r) => (globalThis as unknown as { setImmediate(f: () => void): void }).setImmediate(() => r(null))); // real macrotask, not faked
      await vi.advanceTimersByTimeAsync(STARTER_WAIT_MS / 4);
    }
    expect(done).toBe(true);
    const body = (await (await res).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'paid' });
    expect(body.starter_near).toBeUndefined();
  });
});
