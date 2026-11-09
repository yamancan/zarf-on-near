/** Minimal NEAR JSON-RPC client. Errors carry the RPC's error `name`/`cause` so callers can branch on them. */
export interface Rpc {
  call<T>(method: string, params: unknown): Promise<T>;
}

export class RpcError extends Error {
  constructor(readonly detail: unknown) {
    super(`rpc error: ${JSON.stringify(detail).slice(0, 300)}`);
  }
}

export const httpRpc = (url: string, fetchFn: typeof fetch = (u, i) => fetch(u, i)): Rpc => ({
  async call<T>(method: string, params: unknown): Promise<T> {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'zarf', method, params }),
    });
    const body = (await res.json().catch(() => null)) as { result?: T & { error?: unknown }; error?: unknown } | null;
    if (!body || body.error || !body.result) throw new RpcError(body?.error ?? `HTTP ${res.status}`);
    if (body.result.error) throw new RpcError(body.result.error); // query errors come back inside result
    return body.result;
  },
});

export const viewFunction = async <T>(rpc: Rpc, contractId: string, method: string, args: object): Promise<T> => {
  const r = await rpc.call<{ result: number[] }>('query', {
    request_type: 'call_function', finality: 'final', account_id: contractId, method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result)));
};

export interface AccessKeyView {
  nonce: number | string;
  block_hash: string;
  permission: 'FullAccess' | { FunctionCall: { receiver_id: string; method_names: string[]; allowance: string | null } };
}

export const viewAccessKey = (rpc: Rpc, accountId: string, publicKey: string) =>
  rpc.call<AccessKeyView>('query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey });
