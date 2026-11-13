// Fixture claim site + NEAR RPC, shared by the unit tests and the local `wrangler dev --test-scheduled` run.
import site from './site.json' with { type: 'json' };

export type Variant = 'same' | 'changed' | 'extra';
export const pages = (v: Variant): Record<string, string> => ({ ...site.same, ...(v === 'same' ? {} : site[v]) });

/** Serves one fixture variant; every page fetch gets a fresh CSP nonce, as the live site does. */
export function siteResponse(v: Variant, pathname: string): Response {
  const body = pages(v)[pathname];
  if (body === undefined) return new Response('not found', { status: 404 });
  return new Response(body.replace(/NONCE/g, crypto.randomUUID()), { headers: { 'content-type': pathname.endsWith('.js') ? 'text/javascript' : 'text/html' } });
}

/** A NEAR JSON-RPC call_function answer, encoded as the RPC returns it. */
export function viewResponse(value: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id: 'watch', result: { result: [...new TextEncoder().encode(JSON.stringify(value))], logs: [] } });
}

/** The testnet escrow's code hash (view_account, 14 Nov 2026). */
export const CODE_HASH = '5GdxDSB4sGW9Ewod4Q4Na613C2sLQjVfFjLbbZbKt6N8';
export interface AccountFixture { code_hash: string; keys: { public_key: string; access_key: { nonce: number; permission: unknown } }[] }
export const KEYLESS: AccountFixture = { code_hash: CODE_HASH, keys: [] };

/** The NEAR RPC: call_function views answered from `views` by method name, view_account / view_access_key_list from `account`. */
export function rpcResponse(body: string, views: Record<string, unknown>, account: AccountFixture = KEYLESS): Response {
  const p = JSON.parse(body).params;
  const ok = (result: unknown) => Response.json({ jsonrpc: '2.0', id: 'watch', result });
  if (p.request_type === 'view_account') return ok({ amount: '1', locked: '0', code_hash: account.code_hash, storage_usage: 1, storage_paid_at: 0 });
  if (p.request_type === 'view_access_key_list') return ok({ keys: account.keys });
  return viewResponse(views[p.method_name]);
}
