// Test-only Worker: one full relay inside workerd (raw Ed25519 verify, pkcs8 sign, the verifier import).
import v from '../../../spec/vectors.json';
import { base58Encode, parseNearKey } from '../../src/near';
import { handleRelay } from '../../src/relay';
import { StarterGate, type GateEnv } from '../../src/starter';
import type { Rpc } from '../../src/rpc';

const unhex = (s: string) => Uint8Array.from(s.match(/../g)!, (x) => parseInt(x, 16));

// Real Durable Object storage/alarms; only the external chain is replaced.
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (String(input) !== 'https://starter-rpc.test') return nativeFetch(input, init);
  const { method, params } = JSON.parse(String(init?.body));
  const ok = (result: unknown) => Response.json({ jsonrpc: '2.0', id: 1, result });
  if (method === 'tx') {
    const log = `EVENT_JSON:${JSON.stringify({ standard: 'zarf-near', event: 'claim_paid', data: [{ commitment: v.claims.valid[0].call_args.commitment }] })}`;
    return ok({ status: { SuccessValue: '' }, receipts_outcome: [{ outcome: { executor_id: v.context.contract_id, logs: [log] } }] });
  }
  if (method === 'status') return ok({ chain_id: 'testnet' });
  if (params.request_type === 'view_account') return ok({ amount: params.account_id === 'gas.testnet' ? '3000000000000000000000000' : '0' });
  if (params.request_type === 'view_access_key') return ok({ nonce: 5, block_hash: base58Encode(new Uint8Array(32).fill(3)), permission: 'FullAccess' });
  if (method === 'send_tx') return ok({ status: { SuccessValue: '' } });
  throw new Error('unexpected test RPC');
};

type Storage = ConstructorParameters<typeof StarterGate>[0]['storage'];
export class TestStarterGate extends StarterGate {
  constructor(private readonly testState: { storage: Storage }, env: GateEnv) {
    super(testState, { ...env, STARTER_NEAR: 'on', NETWORK: v.context.network, CONTRACT_ID: v.context.contract_id, RELAYER_ACCOUNT_ID: 'relayer.testnet', RELAYER_KEY: 'fixture-relayer-key', GAS_KEY: `ed25519:${base58Encode(unhex(v.keys.signer_seed + v.keys.signer))}` });
  }
  override async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === '/result') {
      return Response.json({ mark: await this.testState.storage.get(`dest:${v.claims.valid[0].call_args.destination}`) ?? null });
    }
    return super.fetch(req);
  }
}

export default {
  async fetch(req: Request, env: { STARTER: { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request): Promise<Response> } } }): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path.startsWith('/starter')) {
      const gate = env.STARTER.get(env.STARTER.idFromName('alarm-test'));
      if (path === '/starter-result') return gate.fetch(new Request('https://starter/result'));
      return gate.fetch(new Request('https://starter/claim', { method: 'POST', body: JSON.stringify({
        txHash: 'fake-claim-hash', destination: v.claims.valid[0].call_args.destination,
        commitment: v.claims.valid[0].call_args.commitment, contractId: v.context.contract_id,
        relayerAccountId: 'relayer.testnet', paid: false,
      }) }));
    }
    const rpc: Rpc = {
      async call<T>(method: string, params: { request_type?: string; method_name?: string }): Promise<T> {
        if (method === 'send_tx') {
          const log = `EVENT_JSON:${JSON.stringify({ standard: 'zarf-near', version: '1.0.0', event: 'claim_paid', data: [{ commitment: v.claims.valid[0].call_args.commitment }] })}`;
          return { status: { SuccessValue: '' }, receipts_outcome: [{ outcome: { executor_id: v.context.contract_id, logs: [log] } }] } as T;
        }
        if (params.request_type === 'view_access_key') {
          return { nonce: 1, block_hash: base58Encode(new Uint8Array(32).fill(3)), permission: { FunctionCall: { receiver_id: v.context.contract_id, method_names: ['claim'], allowance: null } } } as T;
        }
        if (params.method_name === 'get_config') return { result: [...new TextEncoder().encode(JSON.stringify({ token_ids: ['usdc.testnet'] }))] } as T;
        if (params.method_name === 'claim_state') return { result: [...new TextEncoder().encode(JSON.stringify('unclaimed'))] } as T;
        if (params.method_name === 'get_campaign') return { result: [...new TextEncoder().encode(JSON.stringify(v.campaigns.main))] } as T;
        return { result: [...new TextEncoder().encode('"150000000000000"')] } as T;
      },
    };
    const allow = { limit: async () => ({ success: true }) };
    const key = await parseNearKey(`ed25519:${base58Encode(unhex(v.keys.signer_seed + v.keys.signer))}`);
    const base = { rpc, network: v.context.network, contractId: v.context.contract_id, relayerAccountId: 'relayer.testnet', key, verifierSigners: [v.keys.signer], perIp: allow, perCommitment: allow, nowMs: Number(BigInt(v.context.now_ns) / 1_000_000n) };
    const good = await handleRelay({ ...v.claims.valid[0].call_args }, 'ip', base);
    const forged = await handleRelay({ ...v.claims.invalid.find((c) => c.name === 'amount-differs-from-signed')!.call_args }, 'ip', base);
    return Response.json({ good, forged });
  },
};
