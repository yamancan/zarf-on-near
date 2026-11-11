import { decodeSignedTransaction } from '@near-js/transactions';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import vectors from '../../spec/vectors.json';
import { base58Encode, parseNearKey, type NearKey } from '../src/near';
import { handleHealth, handleRelay, resetNonce, type RateLimiter, type RelayDeps } from '../src/relay';
import { vi } from 'vitest';
import { RpcError, type Rpc } from '../src/rpc';

const { keys, context, claims } = vectors;
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!, (x) => parseInt(x, 16));
const NOW_MS = Number(BigInt(context.now_ns) / 1_000_000n);
const GAS = '150000000000000';
const BLOCK = base58Encode(unhex('22'.repeat(32)));
const valid = claims.valid[0].call_args;
const fcKey = { FunctionCall: { receiver_id: context.contract_id, method_names: ['claim'], allowance: null } };

const event = (name: string, commitment = valid.commitment, executor = context.contract_id) => ({
  outcome: { executor_id: executor, logs: [`EVENT_JSON:${JSON.stringify({ standard: 'zarf-near', version: '1.0.0', event: name, data: [{ campaign_id: '7', commitment }] })}`] },
});
const executed = (...receipts: unknown[]) => ({ status: { SuccessValue: '' }, receipts_outcome: receipts });

type Sent = { signed: Uint8Array };
function stubRpc(o: { permission?: unknown; nonce?: number; gas?: unknown; send?: (n: number) => unknown } = {}) {
  const sent: Sent[] = [];
  const finalities: string[] = [];
  let calls = 0;
  const rpc: Rpc = {
    async call<T>(method: string, params: any): Promise<T> {
      calls++;
      if (method === 'query' && params.request_type === 'view_access_key') {
        finalities.push(params.finality);
        return { nonce: o.nonce ?? 5, block_hash: BLOCK, permission: o.permission ?? fcKey } as T;
      }
      if (method === 'query' && params.request_type === 'view_account') return { amount: '4200000000000000000000000' } as T;
      if (method === 'query' && params.method_name === 'get_config') {
        return { result: [...new TextEncoder().encode(JSON.stringify({ token_ids: ['usdc.testnet'] }))] } as T;
      }
      if (method === 'query' && params.method_name === 'required_claim_gas') {
        return { result: [...new TextEncoder().encode(JSON.stringify('gas' in o ? o.gas : GAS))] } as T;
      }
      if (method === 'send_tx') {
        sent.push({ signed: Uint8Array.from(atob(params.signed_tx_base64), (c) => c.charCodeAt(0)) });
        const r = o.send ? o.send(sent.length) : executed(event('claim_paid'));
        if (r instanceof RpcError) throw r;
        return r as T;
      }
      throw new Error(`unexpected rpc ${method}`);
    },
  };
  return { rpc, sent, calls: () => calls, finalities };
}
const allow: RateLimiter = { limit: async () => ({ success: true }) };
const deny: RateLimiter = { limit: async () => ({ success: false }) };

let key: NearKey;
const deps = (over: Partial<RelayDeps> = {}): RelayDeps => ({
  rpc: stubRpc().rpc, network: context.network, contractId: context.contract_id, relayerAccountId: 'relayer.testnet', key,
  verifierSigners: [keys.signer], perIp: allow, perCommitment: allow, nowMs: NOW_MS, ...over,
});

beforeAll(async () => {
  // Any well-formed key works for the relayer itself; reuse the spec's test seed.
  key = await parseNearKey(`ed25519:${base58Encode(unhex(keys.signer_seed + keys.signer))}`);
});
// The relayer logs fixed tags (misconfigured, rpc_unavailable, nonce_retry); keep test output clean.
beforeEach(() => {
  resetNonce();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('handleRelay', () => {
  it('submits claim with a function-call tx: our contract, method claim, exact args, required gas, zero deposit', async () => {
    const s = stubRpc();
    const res = await handleRelay({ ...valid }, '1.2.3.4', deps({ rpc: s.rpc }));
    expect(res.status).toBe(200);
    const stx = decodeSignedTransaction(s.sent[0].signed);
    const tx = stx.transaction;
    expect(tx.signerId).toBe('relayer.testnet');
    expect(tx.receiverId).toBe(context.contract_id);
    expect(tx.nonce).toBe(6n);
    expect(Uint8Array.from((tx.publicKey as unknown as { ed25519Key: { data: number[] } }).ed25519Key.data)).toEqual(key.publicKey);
    expect(tx.actions).toHaveLength(1);
    const fc = tx.actions[0].functionCall!;
    expect(fc.methodName).toBe('claim');
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(fc.args as unknown as number[])))).toEqual(valid);
    expect(fc.gas).toBe(BigInt(GAS));
    expect(fc.deposit).toBe(0n);
    const unsigned = s.sent[0].signed.slice(0, -65); // SignedTransaction = tx || KeyType(1) || signature(64)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', unsigned));
    expect(res.body).toEqual({ tx_hash: base58Encode(digest), status: 'paid' });
    expect(s.finalities).toEqual(['optimistic']);
  });

  it('uses a fresh nonce for each claim in the same isolate', async () => {
    const s = stubRpc();
    await handleRelay({ ...valid }, 'ip', deps({ rpc: s.rpc }));
    await handleRelay({ ...valid }, 'ip', deps({ rpc: s.rpc }));
    expect(s.sent.map((x) => decodeSignedTransaction(x.signed).transaction.nonce)).toEqual([6n, 7n]);
  });

  it.each([
    ['an extra field', { ...valid, network: 'mainnet' }, 400, 'E108_INVALID_INPUT'],
    ['a missing field', (({ signature: _, ...r }) => r)(valid), 400, 'E108_INVALID_INPUT'],
    ['an array body', [valid], 400, 'E108_INVALID_INPUT'],
    ['a bad destination', { ...valid, destination: 'Alice.testnet' }, 400, 'BAD_DESTINATION'],
    ['the escrow contract itself as destination', { ...valid, destination: context.contract_id }, 400, 'DESTINATION_IS_CONTRACT'],
    ['amount 0', { ...valid, amount: '0' }, 400, 'E109_INVALID_AMOUNT'],
    ['a short signature', { ...valid, signature: 'ab' }, 400, 'E108_INVALID_INPUT'],
    ['proof over 20', { ...valid, proof: Array(21).fill('00'.repeat(32)) }, 400, 'E108_INVALID_INPUT'],
    ['a signer that is not our verifier', { ...valid, signer: keys.rogue_signer }, 403, 'E101_INVALID_SIGNATURE'],
    ['an expired signature', { ...valid, expires_at_ns: (BigInt(context.now_ns) - 1n).toString() }, 409, 'E114_CLAIM_EXPIRED'],
    ['an expiry beyond 1 h', { ...valid, expires_at_ns: (BigInt(context.now_ns) + 3_600_000_000_001n).toString() }, 400, 'E108_INVALID_INPUT'],
  ])('refuses %s without touching the chain', async (_, body, status, error) => {
    const s = stubRpc();
    expect(await handleRelay(body, 'ip', deps({ rpc: s.rpc }))).toEqual({ status, body: { error } });
    expect(s.calls()).toBe(0);
  });

  const e101 = claims.invalid.filter((c) => c.expect === 'E101_INVALID_SIGNATURE');
  it.each(e101)('refuses spec vector $name before spending gas', async (c) => {
    const s = stubRpc();
    const res = await handleRelay({ ...c.call_args }, 'ip', deps({ rpc: s.rpc }));
    expect(res).toEqual({ status: 403, body: { error: 'E101_INVALID_SIGNATURE' } });
    expect(s.calls()).toBe(0);
  });

  it('relays an honestly signed claim and reports the contract panic code (E102 vector)', async () => {
    const c = claims.invalid.find((x) => x.expect === 'E102_INVALID_MERKLE_PROOF')!;
    const failure = { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E102_INVALID_MERKLE_PROOF' } } } };
    const s = stubRpc({ send: () => ({ status: { Failure: failure } }) });
    const res = await handleRelay({ ...c.call_args }, 'ip', deps({ rpc: s.rpc }));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('E102_INVALID_MERKLE_PROOF');
    expect(res.body.tx_hash).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  });

  it('rate-limits per IP before parsing, and per commitment', async () => {
    const s = stubRpc();
    expect(await handleRelay('garbage', 'ip', deps({ rpc: s.rpc, perIp: deny }))).toEqual({ status: 429, body: { error: 'RATE_LIMITED' } });
    const keysSeen: string[] = [];
    const perCommitment: RateLimiter = { limit: async ({ key }) => (keysSeen.push(key), { success: false }) };
    expect(await handleRelay({ ...valid }, 'ip', deps({ rpc: s.rpc, perCommitment }))).toEqual({ status: 429, body: { error: 'RATE_LIMITED' } });
    expect(keysSeen).toEqual([`${valid.campaign_id}/${valid.commitment}`]);
    expect(s.calls()).toBe(0);
  });

  it.each([
    ['a full-access key', 'FullAccess'],
    ['a key for another contract', { FunctionCall: { ...fcKey.FunctionCall, receiver_id: 'evil.testnet' } }],
    ['a key for more methods', { FunctionCall: { ...fcKey.FunctionCall, method_names: ['claim', 'reclaim'] } }],
    ['a key for one wrong method', { FunctionCall: { ...fcKey.FunctionCall, method_names: ['reclaim'] } }],
    ['a key for any method', { FunctionCall: { ...fcKey.FunctionCall, method_names: [] } }],
  ])('refuses to sign with %s', async (_, permission) => {
    const s = stubRpc({ permission });
    expect(await handleRelay({ ...valid }, 'ip', deps({ rpc: s.rpc }))).toEqual({ status: 500, body: { error: 'RELAYER_MISCONFIGURED' } });
    expect(s.sent).toHaveLength(0);
  });

  it('retries once on InvalidNonce from the ak_nonce in the error, then gives up', async () => {
    const nonceErr = new RpcError({ name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION' }, data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { tx_nonce: 6, ak_nonce: 41 } } } } });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const once = stubRpc({ send: (n) => (n === 1 ? nonceErr : executed(event('claim_paid'))) });
    expect((await handleRelay({ ...valid }, 'ip', deps({ rpc: once.rpc }))).status).toBe(200);
    expect(once.sent.map((x) => decodeSignedTransaction(x.signed).transaction.nonce)).toEqual([6n, 42n]);
    expect(log).toHaveBeenCalledWith('nonce_retry');
    log.mockRestore();
    const always = stubRpc({ send: () => nonceErr });
    expect(await handleRelay({ ...valid }, 'ip', deps({ rpc: always.rpc }))).toEqual({ status: 503, body: { error: 'UPSTREAM_UNAVAILABLE' } });
    expect(always.sent).toHaveLength(2);
  });

  it('returns 202 submitted when the RPC times out after accepting the tx', async () => {
    const s = stubRpc({ send: () => new RpcError({ name: 'TIMEOUT_ERROR' }) });
    const res = await handleRelay({ ...valid }, 'ip', deps({ rpc: s.rpc }));
    expect(res).toEqual({ status: 202, body: { tx_hash: expect.any(String), status: 'submitted' } });
  });

  it('a Failure after this claim_started (stranded callback) is 202 submitted, not a refusal', async () => {
    const failure = { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Exceeded the prepaid gas.' } } } };
    const s = stubRpc({ send: () => ({ status: { Failure: failure }, receipts_outcome: [event('claim_started')] }) });
    expect(await handleRelay({ ...valid }, 'ip', deps({ rpc: s.rpc }))).toEqual({ status: 202, body: { tx_hash: expect.any(String), status: 'submitted' } });
  });
  it('a Failure with claim_started for another commitment is still a refusal', async () => {
    const failure = { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E105_ALREADY_CLAIMED' } } } };
    const s = stubRpc({ send: () => ({ status: { Failure: failure }, receipts_outcome: [event('claim_started', '00'.repeat(32))] }) });
    expect((await handleRelay({ ...valid }, 'ip', deps({ rpc: s.rpc }))).body.error).toBe('E105_ALREADY_CLAIMED');
  });

  it('paid outranks started whatever the receipt order', async () => {
    const s = stubRpc({ send: () => executed(event('claim_paid'), event('claim_started')) });
    expect((await handleRelay({ ...valid }, 'ip', deps({ rpc: s.rpc }))).body.status).toBe('paid');
  });

  it('a reverted transfer (claim_reverted) is 409 E115, not paid, although the tx status is a success', async () => {
    const s = stubRpc({ send: () => executed(event('claim_started'), event('claim_reverted')) });
    expect(await handleRelay({ ...valid }, 'ip', deps({ rpc: s.rpc }))).toEqual({ status: 409, body: { error: 'E115_TOKEN_TRANSFER_FAILED', tx_hash: expect.any(String) } });
  });

  it.each([
    ['no event yet', executed()],
    ['claim_paid for another commitment', executed(event('claim_paid', '00'.repeat(32)))],
    ['claim_paid logged by another account', executed(event('claim_paid', valid.commitment, 'evil.testnet'))],
  ])('%s → 202 submitted (the app polls claim_state)', async (_, outcome) => {
    const s = stubRpc({ send: () => outcome });
    expect(await handleRelay({ ...valid }, 'ip', deps({ rpc: s.rpc }))).toEqual({ status: 202, body: { tx_hash: expect.any(String), status: 'submitted' } });
  });

  it.each([['a number', 150], ['a non-decimal string', '0x10'], ['above u64', (1n << 64n).toString() + '0']])('refuses a required_claim_gas that is %s', async (_, gas) => {
    const s = stubRpc({ gas });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await handleRelay({ ...valid }, 'ip', deps({ rpc: s.rpc }))).toEqual({ status: 503, body: { error: 'UPSTREAM_UNAVAILABLE' } });
    expect(s.sent).toHaveLength(0);
    expect(log).toHaveBeenCalledWith('rpc_unavailable');
    log.mockRestore();
  });

  it('503s when the RPC is down', async () => {
    const down: Rpc = { call: () => Promise.reject(new RpcError('HTTP 502')) };
    expect(await handleRelay({ ...valid }, 'ip', deps({ rpc: down }))).toEqual({ status: 503, body: { error: 'UPSTREAM_UNAVAILABLE' } });
  });
});

describe('handleHealth', () => {
  it('reports allowance (null = unlimited), balance and whether the key is claim-only, and the contract it serves', async () => {
    const s = stubRpc();
    expect(await handleHealth({ rpc: s.rpc, relayerAccountId: 'relayer.testnet', key, perIp: allow, contractId: context.contract_id }, 'ip')).toEqual({
      status: 200, body: { contract_id: context.contract_id, allowance: null, balance: '4200000000000000000000000', claim_only: true },
    });
  });
  it('flags a full-access key', async () => {
    const s = stubRpc({ permission: 'FullAccess' });
    expect((await handleHealth({ rpc: s.rpc, relayerAccountId: 'relayer.testnet', key, perIp: allow, contractId: context.contract_id }, 'ip')).body.claim_only).toBe(false);
  });
  it('flags a claim-only key for another contract', async () => {
    const s = stubRpc({ permission: { FunctionCall: { ...fcKey.FunctionCall, receiver_id: 'evil.testnet' } } });
    expect((await handleHealth({ rpc: s.rpc, relayerAccountId: 'relayer.testnet', key, perIp: allow, contractId: context.contract_id }, 'ip')).body.claim_only).toBe(false);
  });
  it('is rate-limited per IP', async () => {
    expect((await handleHealth({ rpc: stubRpc().rpc, relayerAccountId: 'r', key, perIp: deny, contractId: 'c' }, 'ip')).status).toBe(429);
  });
});

describe('a claim paid to a token contract (second audit S1)', () => {
  it('is refused with DESTINATION_IS_TOKEN after the signature check and before anything is sent', async () => {
    const s = stubRpc();
    const rpc: Rpc = { call: (m: string, p: any) => (m === 'query' && p.method_name === 'get_config'
      ? Promise.resolve({ result: [...new TextEncoder().encode(JSON.stringify({ token_ids: [valid.destination] }))] } as never)
      : s.rpc.call(m, p)) };
    const res = await handleRelay({ ...valid }, 'ip', deps({ rpc }));
    expect(res).toEqual({ status: 400, body: { error: 'DESTINATION_IS_TOKEN' } });
    expect(s.sent.length).toBe(0);
  });
});
