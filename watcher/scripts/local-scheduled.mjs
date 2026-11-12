// T-007 acceptance, locally: the real Worker under `wrangler dev --test-scheduled`, one cron run per
// fixture, against a local fixture RPC + claim site + alert sink. Prints the alerts each run sent and
// exits 1 unless every fixture sent exactly what it should (0 for clean/cancelled/same, 1 otherwise).
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { siteResponse, viewResponse } from '../test/fixtures/site.ts';

// Free ports: other projects' dev servers run on this host too.
const freePort = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const SINK = await freePort(), WORKER = await freePort();
const watch = (n) => JSON.parse(readFileSync(new URL(`../test/fixtures/watch-${n}.json`, import.meta.url), 'utf8'));
const FIXTURES = [
  { name: 'no change', watch: 'clean', site: 'same', alerts: 0 },
  { name: 'proposed upgrade', watch: 'proposed', site: 'same', alerts: 1 },
  { name: 'cancelled', watch: 'cancelled', site: 'same', alerts: 0 },
  { name: 'changed script', watch: 'clean', site: 'changed', alerts: 1 },
  { name: 'extra script', watch: 'clean', site: 'extra', alerts: 1 },
];
let now = FIXTURES[0];
const alerts = [];

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString();
  let r;
  if (req.url === '/rpc') r = viewResponse(JSON.parse(body).params.method_name === 'watch' ? watch(now.watch) : 'zarf-near-owner-1111.testnet');
  else if (req.url === '/alert') (alerts.push(JSON.parse(body).text), (r = new Response('ok')));
  else r = siteResponse(now.site, new URL(req.url, 'http://x').pathname);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(SINK, '127.0.0.1');

const base = `http://127.0.0.1:${SINK}`;
const vars = {
  NETWORK: 'testnet', CONTRACT_ID: 'zarf-near-1112.testnet', NEAR_RPC_URL: `${base}/rpc`, EXPECTED_OWNER: 'zarf-near-owner-1111.testnet',
  EXPECTED_SIGNERS: '2d10ebec1ec795cef82b8d357cc60d39d9119b99908741660b632fc5cf0d4e32', CLAIM_PAGE_URL: `${base}/claim/1/0`,
  MAX_SCRIPTS: '44', ALERT_WEBHOOK_URL: `${base}/alert`,
};
const wrangler = spawn('npx', ['wrangler', 'dev', '-c', 'test/local/wrangler.json', '--test-scheduled', '--port', String(WORKER), '--ip', '127.0.0.1',
  ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
wrangler.stdout.on('data', (d) => (log += d));
wrangler.stderr.on('data', (d) => (log += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
try {
  for (let i = 0; !log.includes('Ready on'); i++) {
    if (i > 120) throw new Error(`wrangler dev did not start:\n${log}`);
    await sleep(500);
  }
  for (const f of FIXTURES) {
    now = f;
    const before = alerts.length;
    const res = await fetch(`http://127.0.0.1:${WORKER}/__scheduled?cron=*/2+*+*+*+*`);
    await sleep(300);
    const sent = alerts.slice(before);
    const pass = res.ok && sent.length === f.alerts;
    ok &&= pass;
    console.log(`${pass ? 'PASS' : 'FAIL'} ${f.name}: ${sent.length} alert(s), expected ${f.alerts} (/__scheduled HTTP ${res.status})`);
    for (const a of sent) console.log(a.replace(/^/gm, '    '));
  }
} catch (e) {
  ok = false;
  console.error(e instanceof Error ? e.message : e);
} finally {
  wrangler.kill('SIGINT');
  server.close();
}
if (!ok) console.error(`\nwrangler log:\n${log}`);
process.exit(ok ? 0 : 1);
