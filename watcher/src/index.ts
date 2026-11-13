// Cron Worker (every 2 min): pages ALERT_WEBHOOK_URL when the escrow shows a proposed upgrade, owner
// change or verifier-key change, when the account's code hash is not the expected one or it has any access
// key, or when the live claim page differs from the fingerprint the web deploy recorded. A run that cannot
// check is itself an alert: silence must mean "checked and clean".
//
// Subrequest budget (free Workers: 50 per run): 4 RPC reads with one retry each (8), the page (1), the alert
// (1), and SCRIPTS_PER_RUN recorded scripts (40): see bundle.ts for how the scripts rotate across runs.

import { accountFindings, contractFindings, type AccountView, type WatchView } from './contract.ts';
import { checkPage, type Fingerprint } from './bundle.ts';
import testnet from '../expected/testnet.json';
import mainnet from '../expected/mainnet.json';

export interface Env {
  NETWORK: string;
  CONTRACT_ID: string;
  NEAR_RPC_URL: string;
  EXPECTED_OWNER: string;
  /** Comma-separated hex verifier keys, as in the relayer's VERIFIER_SIGNERS. */
  EXPECTED_SIGNERS: string;
  /** The escrow account's code hash as view_account returns it (base58). */
  EXPECTED_CODE_HASH: string;
  CLAIM_PAGE_URL: string;
  /** Recorded scripts re-hashed per run (default 40, the free plan's budget). */
  SCRIPTS_PER_RUN?: string;
  /** Secret. POSTed {text, content} (Slack and Discord incoming-webhook shapes). */
  ALERT_WEBHOOK_URL?: string;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export const EXPECTED: Record<string, Fingerprint | null> = { testnet, mainnet } as Record<string, Fingerprint | null>;

const timed: Fetcher = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });

/** One NEAR RPC query, tried twice. */
async function query<T>(env: Env, params: Record<string, unknown>, fetcher: Fetcher): Promise<T> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 'watch', method: 'query', params: { finality: 'optimistic', account_id: env.CONTRACT_ID, ...params } });
  let last: unknown;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetcher(env.NEAR_RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      const j = (await res.json()) as { result?: T; error?: unknown };
      if (!j.result) throw new Error(`${String(params.method_name ?? params.request_type)}: ${JSON.stringify(j.error)}`);
      return j.result;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

async function view<T>(env: Env, method: string, fetcher: Fetcher): Promise<T> {
  const r = await query<{ result: number[] }>(env, { request_type: 'call_function', method_name: method, args_base64: 'e30=' }, fetcher);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result))) as T;
}

async function account(env: Env, fetcher: Fetcher): Promise<AccountView> {
  const [a, k] = await Promise.all([
    query<{ code_hash: string }>(env, { request_type: 'view_account' }, fetcher),
    query<{ keys: AccountView['keys'] }>(env, { request_type: 'view_access_key_list' }, fetcher),
  ]);
  if (typeof a.code_hash !== 'string' || !Array.isArray(k.keys)) throw new Error('view_account / view_access_key_list: unexpected answer');
  return { code_hash: a.code_hash, keys: k.keys };
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Everything that should page someone now; empty means checked and clean. */
export async function run(env: Env, expected: Fingerprint | null, fetcher: Fetcher = timed, now = Date.now()): Promise<string[]> {
  const missing = (['NETWORK', 'CONTRACT_ID', 'NEAR_RPC_URL', 'EXPECTED_OWNER', 'EXPECTED_SIGNERS', 'EXPECTED_CODE_HASH', 'CLAIM_PAGE_URL'] as const).filter((k) => !env[k]);
  if (missing.length) return [`WATCHER MISCONFIGURED: ${missing.join(', ')} empty, nothing was checked`];
  const f: string[] = [];
  try {
    const [w, owner] = await Promise.all([view<WatchView>(env, 'watch', fetcher), view<string>(env, 'get_owner', fetcher)]);
    f.push(...contractFindings(w, owner, { owner: env.EXPECTED_OWNER, signers: env.EXPECTED_SIGNERS.split(',').map((s) => s.trim()).filter(Boolean) }));
  } catch (e) {
    f.push(`CANNOT READ ${env.CONTRACT_ID}: ${msg(e)}`);
  }
  try {
    f.push(...accountFindings(await account(env, fetcher), env.EXPECTED_CODE_HASH));
  } catch (e) {
    f.push(`CANNOT READ THE ACCOUNT ${env.CONTRACT_ID}: ${msg(e)}`);
  }
  try {
    // One window per 2-minute cron slot: consecutive runs re-hash consecutive slices of the recorded scripts.
    f.push(...(await checkPage(env.CLAIM_PAGE_URL, fetcher, expected, Number(env.SCRIPTS_PER_RUN || 40), Math.floor(now / 120_000))));
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
export async function tick(env: Env, expected: Fingerprint | null, now = Date.now()): Promise<void> {
  const findings = await run(env, expected, timed, now);
  if (findings.length) await alert(env, findings);
  else console.log(`[zarf-near ${env.NETWORK}] clean`);
}

export default {
  async scheduled(c: { scheduledTime?: number }, env: Env): Promise<void> {
    await tick(env, EXPECTED[env.NETWORK] ?? null, c?.scheduledTime ?? Date.now());
  },
  async fetch(): Promise<Response> {
    return new Response('zarf-near watcher: cron only\n', { status: 404 });
  },
};
