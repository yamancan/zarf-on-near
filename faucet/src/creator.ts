import { base58Decode, signTx, type NearKey } from './near';

export interface CreateRequest {
  merkleRoot: string; // hex32
  amount: string; // u128 decimal, token base units
  deadlineNs: string; // u64 decimal
}

export interface CampaignCreator {
  /** False for the stub: its campaign ids do not exist on chain. */
  readonly live: boolean;
  create(r: CreateRequest): Promise<{ campaignId: string; txHash: string | null }>;
}

export class CreateError extends Error {
  constructor(readonly code: 'FAUCET_NOT_PREPAID' | 'CREATE_FAILED', readonly definitive = code === 'FAUCET_NOT_PREPAID') {
    super(code);
  }
}

/** Counts up from `first`; nothing touches the chain. */
export function stubCreator(first = 1_000_000n): CampaignCreator {
  let next = first;
  return { live: false, create: async () => ({ campaignId: String(next++), txHash: null }) };
}

export interface Rpc {
  call<T>(method: string, params: unknown): Promise<T>;
}

export const httpRpc = (url: string, fetchFn: typeof fetch = (u, i) => fetch(u, i)): Rpc => ({
  async call<T>(method: string, params: unknown): Promise<T> {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'zarf-faucet', method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => null)) as { result?: T & { error?: unknown }; error?: unknown } | null;
    if (!body || body.error || !body.result) throw new Error(`rpc ${method} failed`);
    if (body.result.error) throw new Error(`rpc ${method} failed`);
    return body.result;
  },
});

/** A JSON view call; returns the decoded result. */
export async function viewCall<T>(rpc: Rpc, contractId: string, method: string, args: object): Promise<T> {
  const r = await rpc.call<{ result: number[] }>('query', {
    request_type: 'call_function', finality: 'final', account_id: contractId, method_name: method, args_base64: btoa(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result)));
}

interface Outcome {
  status?: { Failure?: unknown };
  receipts_outcome?: { outcome?: { logs?: string[]; executor_id?: string; status?: { Failure?: unknown } } }[];
}

/** campaign_id from the escrow's `campaign_created` event, only if it carries the root and amount we sent. */
export function campaignIdFrom(o: Outcome, contractId: string, expect: { merkleRoot: string; amount: string }): string | null {
  for (const r of o.receipts_outcome ?? []) {
    if (r.outcome?.executor_id !== contractId) continue;
    for (const log of r.outcome.logs ?? []) {
      if (!log.startsWith('EVENT_JSON:')) continue;
      try {
        const e = JSON.parse(log.slice('EVENT_JSON:'.length));
        const d = e.data?.[0];
        if (e.standard === 'zarf-near' && e.event === 'campaign_created' && /^\d+$/.test(String(d?.campaign_id)) &&
            d.merkle_root === expect.merkleRoot && String(d.amount) === expect.amount) {
          return String(d.campaign_id);
        }
      } catch {
        // not our event
      }
    }
  }
  return null;
}

const TGAS = 1_000_000_000_000n;

export interface TestnetCreatorDeps {
  rpc: Rpc;
  senderId: string; // the faucet account; its storage pre-pay on the escrow is topped up by the operator
  key: NearKey; // from the FAUCET_SENDER_KEY secret
  tokenId: string;
  contractId: string;
}

/**
 * One `ft_transfer_call` of `amount` from the faucet account, with a 1-leaf owner-policy campaign
 * in `msg`. The operator keeps the faucet's free storage pre-pay on the escrow funded (`prepay_deposit`);
 * when it runs out, ft_on_transfer fails with E128 and NEP-141 refunds the tokens.
 */
export function testnetCreator(d: TestnetCreatorDeps): CampaignCreator {
  let lastNonce = 0n; // per isolate, so two requests in one isolate never reuse a nonce
  return {
    live: true,
    async create(r) {
      let prepared: Awaited<ReturnType<typeof signTx>>;
      try {
        const ak = await d.rpc.call<{ nonce: number | string; block_hash: string }>('query', {
          request_type: 'view_access_key', finality: 'optimistic', account_id: d.senderId, public_key: d.key.publicKeyStr,
        });
        const chainNonce = BigInt(ak.nonce);
        const nonce = (chainNonce > lastNonce ? chainNonce : lastNonce) + 1n;
        lastNonce = nonce;
        const msg = JSON.stringify({ merkle_root: r.merkleRoot, deadline_ns: r.deadlineNs, policy: 'owner', leaf_count: 1 });
        prepared = await signTx(d.key.key, {
          signerId: d.senderId, publicKey: d.key.publicKey, nonce, receiverId: d.tokenId, blockHash: base58Decode(ak.block_hash),
          methodName: 'ft_transfer_call',
          args: new TextEncoder().encode(JSON.stringify({ receiver_id: d.contractId, amount: r.amount, msg })),
          gas: 200n * TGAS,
          deposit: 1n, // NEP-141 requires exactly 1 yoctoNEAR
        });
      } catch {
        // Nothing has been broadcast: releasing the email cannot create a duplicate campaign.
        throw new CreateError('CREATE_FAILED', true);
      }
      const { signed, hash } = prepared;
      const o = await d.rpc.call<Outcome>('send_tx', {
        signed_tx_base64: btoa(String.fromCharCode(...signed)), wait_until: 'EXECUTED_OPTIMISTIC',
      });
      const id = campaignIdFrom(o, d.contractId, { merkleRoot: r.merkleRoot, amount: r.amount });
      if (id) return { campaignId: id, txHash: hash };
      const failures = JSON.stringify((o.receipts_outcome ?? []).map((x) => x.outcome?.status?.Failure).filter(Boolean));
      throw new CreateError(failures.includes('E128') ? 'FAUCET_NOT_PREPAID' : 'CREATE_FAILED');
    },
  };
}
