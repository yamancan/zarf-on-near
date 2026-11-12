// Browser pass for the cross-chain claim with every network stubbed: chain views (mainnet), 1Click,
// Google, verifier and relayer. Walks picker → dry quote → real quote → sign-in → receipt, for
// 1Click ending SUCCESS, REFUNDED and FAILED, plus a claim reopened in a new tab after the first one closed
// while the bridge was still processing, which must ask the bridge again and learn SUCCESS. Nothing leaves the browser.
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core node scripts/intents-e2e.cjs http://localhost:5181
// (the page must run with PUBLIC_GOOGLE_CLIENT_ID set and PUBLIC_CROSS_CHAIN=on, e.g. wrangler dev --var PUBLIC_GOOGLE_CLIENT_ID:test --var PUBLIC_CROSS_CHAIN:on).
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
  const reopen = final === 'REOPENED';
  const bridge = { status: reopen ? 'PROCESSING' : final };
  const chain = { claimed: false };
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  const errs = [], quotes = [], seen = {};
  p.on('pageerror', (e) => errs.push(String(e)));
  p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await ctx.route(/rpc|fastnear|near\.org/, async (r) => {
    const q = JSON.parse(r.request().postData()).params;
    const res = q.method_name === 'get_network' ? 'mainnet'
      : q.method_name === 'get_campaign' ? { sender: 'sender.near', merkle_root: v.campaigns.main.merkle_root, deadline_ns: '1894488400000000000' }
      : q.method_name === 'claim_state' && chain.claimed ? 'claimed'
      : 'unclaimed';
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { result: enc(res) } }) });
  });
  await ctx.route('https://1click.chaindefuser.com/**', async (r) => {
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
      seen.statusReads = (seen.statusReads ?? 0) + 1;
      const swapDetails = bridge.status === 'SUCCESS'
        ? { amountOutFormatted: '9.99558', destinationChainTxHashes: [{ hash: '0xabc', explorerUrl: 'https://basescan.org/tx/0xabc' }] }
        : { refundReason: 'route unavailable' };
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: bridge.status, swapDetails }) });
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
  await p.getByText('Another Chain', { exact: true }).click();
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
  assert(/does not complete the payout by its deadline, it refunds sender\.near on NEAR/.test(detail) && !/If it cannot be paid/.test(detail), 'refund copy is the documented one and names the sender');
  await p.locator('button.google').click();
  await p.waitForURL(/receipt/);
  const title = { SUCCESS: 'Arrived on Base', REFUNDED: 'Not Delivered', FAILED: 'Payout Failed', REOPENED: 'Sending to Base' }[final];
  await p.waitForFunction((t) => document.querySelector('h1')?.textContent?.includes(t), title, { timeout: 20000 });
  const text = await p.locator('main').innerText();

  const [dry, real] = quotes;
  assert(dry.dry === true && real.dry === false, 'dry then real quote');
  for (const q of quotes) assert(q.refundTo === 'sender.near' && q.refundType === 'ORIGIN_CHAIN' && q.recipient === RECIPIENT && q.amount === v.claims.valid.find((c) => c.call_args.commitment === v.links.main[0].split('/')[3].split('#')[0]).call_args.amount, 'quote fields');
  assert(seen.nonce === crypto.createHash('sha256').update(DEP).digest('hex'), 'nonce binds the deposit address');
  assert(seen.verifier.destination === DEP && seen.verifier.intents.recipient === RECIPIENT && seen.verifier.intents.destination_asset.startsWith('nep141:base-'), 'verifier body');
  assert(seen.submit?.depositAddress === DEP, 'deposit submitted');
  if (final === 'SUCCESS') assert(/basescan\.org/.test(await p.locator('a[href*=basescan]').getAttribute('href')), 'Base explorer link');
  else if (final === 'REFUNDED') assert(/Went back to sender\.near on NEAR/.test(text) && /new link/.test(text) && !/route unavailable/.test(text), 'refund copy, raw reason only under Details');
  else if (final === 'FAILED') {
    // 1Click documents no refund for FAILED: no promise that it goes back, and the deposit address one layer down.
    assert(/The bridge reported an error and has not paid out on Base/.test(text) && /Tell the sender\. They can ask NEAR Intents support/.test(text), `failed copy: ${text}`);
    assert(!/goes back|go back|will be returned|is refunded|refunds|Returned to|Went back|Keep this page/i.test(text), `a failed payout promises no refund: ${text}`);
    await p.getByText('Details', { exact: true }).click();
    const more = await p.locator('main details').last().innerText();
    assert(more.includes(DEP) && /Not returned to sender\.near as of the last check/.test(more) && /Copy Address/.test(more), `failed details: ${more}`);
  }
  // One amount: the link's 10 USDC until the bridge confirms, then what it paid.
  assert(final === 'SUCCESS' ? /9\.99\s*USDC/.test(text) : /10\s*(TEST )?USDC/.test(text), `receipt amount: ${text}`);
  // Remembered as the bridge reported it, never as paid before that, with the deposit address for a reopened link.
  const rec = JSON.parse(await p.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith('zarf-near:receipt:'))?.[1]));
  assert(rec.bridge === { SUCCESS: 'paid', REFUNDED: 'refunded', FAILED: 'failed', REOPENED: 'in-transit' }[final] && rec.depositAddress === DEP && rec.refundTo === 'sender.near', `stored record: ${JSON.stringify(rec)}`);
  if (reopen) {
    // The first tab closes while the bridge still processes; later the bridge pays. The link is opened again from the email.
    await p.close();
    bridge.status = 'SUCCESS'; chain.claimed = true;
    const before = seen.statusReads;
    const q = await ctx.newPage();
    q.on('pageerror', (e) => errs.push(String(e)));
    await q.goto(base + v.links.main[0]);
    await q.waitForFunction(() => /Paid out/i.test(document.querySelector('main')?.innerText ?? ''), null, { timeout: 20000 });
    const again = await q.locator('main').innerText();
    assert(seen.statusReads > before, 'the reopened link asked the bridge again');
    assert(/Already claimed/.test(again) && /9\.99\s*USDC/.test(again) && !/On its way/i.test(again), `reopened record: ${again}`);
    const after = JSON.parse(await q.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith('zarf-near:receipt:'))?.[1]));
    assert(after.bridge === 'paid' && after.amountOut === '9.99558' && typeof after.checkedAt === 'number', `record updated: ${JSON.stringify(after)}`);
    assert(!errs.length, `console errors: ${errs.join(' | ')}`);
    console.log(`${final}: PASS · ${again.split('\n').slice(0, 4).join(' / ')}`);
    await b.close();
    return;
  }
  // A judge reloads: the receipt resumes following the payout from sessionStorage.
  await p.reload();
  await p.waitForFunction((t) => document.querySelector('h1')?.textContent?.includes(t), title, { timeout: 20000 });
  assert(!errs.length, `console errors: ${errs.join(' | ')}`);
  console.log(`${final}: PASS · ${text.split('\n').slice(0, 3).join(' / ')}`);
  await b.close();
}

(async () => {
  await run('SUCCESS');
  await run('REFUNDED');
  await run('FAILED');
  await run('REOPENED');
})().catch((e) => { console.error(e.message); process.exit(1); });
