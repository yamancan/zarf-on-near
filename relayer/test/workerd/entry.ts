// Test-only Worker: one full relay inside workerd (raw Ed25519 verify, pkcs8 sign, the verifier import).
import v from '../../../spec/vectors.json';
import { base58Encode, parseNearKey } from '../../src/near';
import { handleRelay } from '../../src/relay';
import type { Rpc } from '../../src/rpc';

const unhex = (s: string) => Uint8Array.from(s.match(/../g)!, (x) => parseInt(x, 16));

export default {
  async fetch(): Promise<Response> {
    const rpc: Rpc = {
      async call<T>(method: string, params: { request_type?: string }): Promise<T> {
        if (method === 'send_tx') {
          const log = `EVENT_JSON:${JSON.stringify({ standard: 'zarf-near', version: '1.0.0', event: 'claim_paid', data: [{ commitment: v.claims.valid[0].call_args.commitment }] })}`;
          return { status: { SuccessValue: '' }, receipts_outcome: [{ outcome: { executor_id: v.context.contract_id, logs: [log] } }] } as T;
        }
        if (params.request_type === 'view_access_key') {
          return { nonce: 1, block_hash: base58Encode(new Uint8Array(32).fill(3)), permission: { FunctionCall: { receiver_id: v.context.contract_id, method_names: ['claim'], allowance: null } } } as T;
        }
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
