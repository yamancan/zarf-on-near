// Cron Worker (every 2 min): pages ALERT_WEBHOOK_URL when the escrow shows a proposed upgrade, owner
// change or verifier-key change, or the live claim page differs from the fingerprint the web deploy
// recorded. A run that cannot check is itself an alert: silence must mean "checked and clean".

import { contractFindings, type WatchView } from './contract.ts';
import { bundleFindings, fingerprint, type Fingerprint } from './bundle.ts';
import testnet from '../expected/testnet.json';
import mainnet from '../expected/mainnet.json';

export interface Env {
  NETWORK: string;
  CONTRACT_ID: string;
  NEAR_RPC_URL: string;
  EXPECTED_OWNER: string;
  /** Comma-separated hex verifier keys, as in the relayer's VERIFIER_SIGNERS. */
  EXPECTED_SIGNERS: string;
  CLAIM_PAGE_URL: string;
  MAX_SCRIPTS?: string;
  /** Secret. POSTed {text, content} (Slack and Discord incoming-webhook shapes). */
  ALERT_WEBHOOK_URL?: string;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export const EXPECTED: Record<string, Fingerprint | null> = { testnet, mainnet } as Record<string, Fingerprint | null>;

const timed: Fetcher = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });

async function view<T>(env: Env, method: string, fetcher: Fetcher): Promise<T> {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 'watch', method: 'query',
    params: { request_type: 'call_function', finality: 'optimistic', account_id: env.CONTRACT_ID, method_name: method, args_base64: 'e30=' },
  });
  let last: unknown;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetcher(env.NEAR_RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      const j = (await res.json()) as { result?: { result: number[] }; error?: unknown };
      if (!j.result) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(j.result.result))) as T;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Everything that should page someone now; empty means checked and clean. */
export async function run(env: Env, expected: Fingerprint | null, fetcher: Fetcher = timed): Promise<string[]> {
  const missing = (['NETWORK', 'CONTRACT_ID', 'NEAR_RPC_URL', 'EXPECTED_OWNER', 'EXPECTED_SIGNERS', 'CLAIM_PAGE_URL'] as const).filter((k) => !env[k]);
  if (missing.length) return [`WATCHER MISCONFIGURED: ${missing.join(', ')} empty, nothing was checked`];
  const f: string[] = [];
  try {
    const [w, owner] = await Promise.all([view<WatchView>(env, 'watch', fetcher), view<string>(env, 'get_owner', fetcher)]);
    f.push(...contractFindings(w, owner, { owner: env.EXPECTED_OWNER, signers: env.EXPECTED_SIGNERS.split(',').map((s) => s.trim()).filter(Boolean) }));
  } catch (e) {
    f.push(`CANNOT READ ${env.CONTRACT_ID}: ${msg(e)}`);
  }
  try {
    f.push(...bundleFindings(await fingerprint(env.CLAIM_PAGE_URL, fetcher, Number(env.MAX_SCRIPTS || 44)), expected));
  } catch (e) {
    f.push(`CANNOT CHECK THE CLAIM PAGE: ${msg(e)}`);
  }
  return f;
}

export function alertText(env: Env, findings: string[]): string {
  return [`[zarf-near ${env.NETWORK}] ${env.CONTRACT_ID} / ${env.CLAIM_PAGE_URL}`, ...findings.map((l) => `- ${l}`)].join('\n');
}

export async function alert(env: Env, findings: string[], fetcher: Fetcher = timed): Promise<void> {
  const text = alertText(env, findings);
  console.error(text); // also in the Worker's logs, whatever happens to the webhook
  if (!env.ALERT_WEBHOOK_URL) throw new Error('ALERT_WEBHOOK_URL is not set: this alert reached nobody');
  const res = await fetcher(env.ALERT_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text }) });
  if (!res.ok) throw new Error(`alert webhook: HTTP ${res.status}`);
}

/** One cron tick. A thrown error marks the run failed in Cloudflare's cron log. */
export async function tick(env: Env, expected: Fingerprint | null): Promise<void> {
  const findings = await run(env, expected);
  if (findings.length) await alert(env, findings);
  else console.log(`[zarf-near ${env.NETWORK}] clean`);
}

export default {
  async scheduled(_c: unknown, env: Env): Promise<void> {
    await tick(env, EXPECTED[env.NETWORK] ?? null);
  },
  async fetch(): Promise<Response> {
    return new Response('zarf-near watcher: cron only\n', { status: 404 });
  },
};
