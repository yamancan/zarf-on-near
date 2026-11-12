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
