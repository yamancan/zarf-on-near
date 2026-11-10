// Browser pass for the cross-chain claim with every network stubbed: chain views (mainnet), 1Click,
// Google, verifier and relayer. Walks picker → dry quote → real quote → sign-in → receipt, for
// 1Click ending SUCCESS and REFUNDED. Nothing leaves the browser.
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core node scripts/intents-e2e.cjs http://localhost:5181
// (the page must run with PUBLIC_GOOGLE_CLIENT_ID set, e.g. wrangler dev --var PUBLIC_GOOGLE_CLIENT_ID:test).
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const crypto = require('node:crypto');
const v = require('../../spec/vectors.json');
const tokens = require('../src/lib/fixtures/1click-tokens.json');

const base = process.argv[2];
const DEP = 'd'.repeat(64);
const RECIPIENT = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const enc = (o) => [...Buffer.from(JSON.stringify(o))];
const assert = (c, m) => { if (!c) throw new Error(`FAIL: ${m}`); };

async function run(final) {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errs = [], quotes = [], seen = {};
  p.on('pageerror', (e) => errs.push(String(e)));
  p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await p.route(/rpc|fastnear|near\.org/, async (r) => {
    const q = JSON.parse(r.request().postData()).params;
    const res = q.method_name === 'get_network' ? 'mainnet'
      : q.method_name === 'get_campaign' ? { sender: 'sender.near', merkle_root: v.campaigns.main.merkle_root, deadline_ns: '1894488400000000000' }
      : 'unclaimed';
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { result: enc(res) } }) });
  });
  await p.route('https://1click.chaindefuser.com/**', async (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/v0/tokens') return r.fulfill({ contentType: 'application/json', body: JSON.stringify(tokens) });
    if (u.pathname === '/v0/quote') {
      const body = JSON.parse(r.request().postData());
      quotes.push(body);
      const quote = { amountIn: body.amount, amountOut: '9995580', amountOutFormatted: '9.99558', minAmountOut: '9895624', timeEstimate: 22, ...(body.dry ? {} : { depositAddress: DEP }) };
      return r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ quote }) });
    }
    if (u.pathname === '/v0/deposit/submit') { seen.submit = JSON.parse(r.request().postData()); return r.fulfill({ status: 200, body: '{}' }); }
    if (u.pathname === '/v0/status') {
      const swapDetails = final === 'SUCCESS'
        ? { amountOutFormatted: '9.99558', destinationChainTxHashes: [{ hash: '0xabc', explorerUrl: 'https://basescan.org/tx/0xabc' }] }
        : { refundReason: 'route unavailable' };
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: final, swapDetails }) });
    }
    return r.fulfill({ status: 404, body: '{}' });
  });
  await p.route('https://accounts.google.com/**', async (r) => {
    const u = new URL(r.request().url());
    seen.nonce = u.searchParams.get('nonce');
    await r.fulfill({ status: 302, headers: { location: `${base}/auth/google#id_token=h.p.s&state=${encodeURIComponent(u.searchParams.get('state'))}` } });
  });
  await p.route(/verifier.*\/claim$/, async (r) => {
    seen.verifier = JSON.parse(r.request().postData());
    const c = v.claims.valid[0].call_args;
    await r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ...c, destination: DEP }) });
  });
  await p.route(/relayer.*\/claim$/, (r) => r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ status: 'paid', tx_hash: '6zgh2u9DqHHiXzdy9ouTP7oGky2T4nugqzqt9wJZwNFm' }) }));

  await p.goto(base + v.links.main[0]);
  await p.getByText('Another chain', { exact: true }).click();
  await p.waitForSelector('#chain');
  assert((await p.locator('#chain button').first().innerText()).trim() === 'USDC on Base', 'Base is first');
  await p.fill('#addr', RECIPIENT.slice(0, -1) + 'D'); // checksum typo
  assert(/typo/.test(await p.locator('#addr-note').innerText()), 'EIP-55 typo caught');
  await p.fill('#addr', RECIPIENT);
  await p.waitForSelector('.quote');
  const box = await p.locator('.quote').innerText();
  assert(/≈ 9\.99 USDC on Base/.test(box), `quote line: ${box}`);
  await p.getByText('Details', { exact: true }).click(); // minimum, cost and refund sit one layer down
  const detail = await p.locator('#addr-note details').innerText();
  assert(/About 9\.99558 USDC, at least 9\.895624/.test(detail), `quote detail: ${detail}`);
  assert(/returns to sender\.near on NEAR/.test(detail), 'refund copy names the sender');
  await p.locator('button.google').click();
  await p.waitForURL(/receipt/);
  await p.waitForFunction((t) => document.querySelector('h1')?.textContent?.includes(t), final === 'SUCCESS' ? 'Arrived on Base' : 'Not delivered', { timeout: 20000 });
  const text = await p.locator('main').innerText();

  const [dry, real] = quotes;
  assert(dry.dry === true && real.dry === false, 'dry then real quote');
  for (const q of quotes) assert(q.refundTo === 'sender.near' && q.refundType === 'ORIGIN_CHAIN' && q.recipient === RECIPIENT && q.amount === v.claims.valid.find((c) => c.call_args.commitment === v.links.main[0].split('/')[3].split('#')[0]).call_args.amount, 'quote fields');
  assert(seen.nonce === crypto.createHash('sha256').update(DEP).digest('hex'), 'nonce binds the deposit address');
  assert(seen.verifier.destination === DEP && seen.verifier.intents.recipient === RECIPIENT && seen.verifier.intents.destination_asset.startsWith('nep141:base-'), 'verifier body');
  assert(seen.submit?.depositAddress === DEP, 'deposit submitted');
  if (final === 'SUCCESS') assert(/basescan\.org/.test(await p.locator('a[href*=basescan]').getAttribute('href')), 'Base explorer link');
  else assert(/went back to sender\.near on NEAR/.test(text), 'refund copy');
  // A judge reloads: the receipt resumes following the payout from sessionStorage.
  await p.reload();
  await p.waitForFunction((t) => document.querySelector('h1')?.textContent?.includes(t), final === 'SUCCESS' ? 'Arrived on Base' : 'Not delivered', { timeout: 20000 });
  assert(!errs.length, `console errors: ${errs.join(' | ')}`);
  console.log(`${final}: PASS · ${text.split('\n').slice(0, 3).join(' / ')}`);
  await b.close();
}

(async () => {
  await run('SUCCESS');
  await run('REFUNDED');
})().catch((e) => { console.error(e.message); process.exit(1); });
