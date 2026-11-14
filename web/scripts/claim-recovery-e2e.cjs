// All provider traffic is intercepted. Run against a local Vite server with PUBLIC_CONTRACT_ID=zarf.near,
// PUBLIC_NEAR_RPC_URL=https://rpc.example.invalid, PUBLIC_VERIFIER_URL=https://verifier.example.invalid,
// PUBLIC_RELAYER_URL=https://relayer.example.invalid. PLAYWRIGHT_CORE points to an existing installation.
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const assert = require('node:assert/strict');
const base = process.argv[2];
const commitment = 'a'.repeat(64), deposit = 'd'.repeat(64);
const tx = '6zgh2u9DqHHiXzdy9ouTP7oGky2T4nugqzqt9wJZwNFm';
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };

async function run(crossChain, delayed = false) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    let claimState = delayed ? 'unclaimed' : 'pending', bridgeOffline = false, verifierCalls = 0, relayCalls = 0, depositCalls = 0;
    await context.route('**/*', async (route) => {
      const u = new URL(route.request().url());
      if (u.origin === base) return route.continue();
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (u.hostname === 'rpc.example.invalid') return route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({
        jsonrpc: '2.0', id: 'zarf', result: { result: [...Buffer.from(JSON.stringify(claimState))] },
      }) });
      if (u.hostname === 'verifier.example.invalid') {
        verifierCalls++;
        return route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({ campaign_id: '7', commitment,
          amount: '10000000', proof: [], destination: crossChain ? deposit : 'alice.near', expires_at_ns: '1894488400000000000', signer: 'signer', signature: 'signature' }) });
      }
      if (u.hostname === 'relayer.example.invalid') {
        relayCalls++;
        // Losing the cross-chain response also loses its tx hash, but must not lose the recovery path.
        return crossChain ? route.abort() : route.fulfill({ status: 202, contentType: 'application/json', headers: cors, body: JSON.stringify({ status: 'submitted', tx_hash: tx }) });
      }
      if (u.hostname === '1click.chaindefuser.com') {
        if (u.pathname === '/v0/deposit/submit') { depositCalls++; return route.fulfill({ body: '{}' }); }
        if (bridgeOffline) return route.abort();
        return route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({ status: 'FAILED', swapDetails: { refundReason: 'Destination transfer failed' } }) });
      }
      return route.abort(); // no request reaches an external service
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(base);
    await page.evaluate(({ commitment, deposit, crossChain }) => {
      sessionStorage.setItem('zarf-near:attempt', JSON.stringify({ campaign: '7', commitment,
        salt: 'b'.repeat(64), amount: '10000000', proof: [], destination: crossChain ? deposit : 'alice.near', attemptId: 'test-state',
        ...(crossChain ? { intents: { chainName: 'Base', recipient: '0x1234', refundTo: 'sender.near', assetId: 'asset',
          requestDeadline: new Date(Date.now() + 3600000).toISOString(), amountOutFormatted: '9.99' } } : {}),
      }));
    }, { commitment, deposit, crossChain });
    await page.goto(`${base}/auth/google#id_token=test-token&state=test-state`);
    await page.waitForURL('**/receipt');
    await page.waitForFunction(() => document.querySelector('h1')?.textContent.includes('Sending Your Tokens'));
    if (delayed) {
      await page.waitForFunction(() => document.querySelector('h1')?.textContent.includes('Still Settling'), undefined, { timeout: 45000 });
      assert.equal(await page.evaluate(() => Object.keys(localStorage).some(k => k.startsWith('zarf-near:pending:'))), true);
    }
    await page.waitForTimeout(100);
    await page.reload();
    try {
      await page.waitForFunction(() => document.querySelector('h1')?.textContent.includes('Sending Your Tokens'), undefined, { timeout: 10000 });
    } catch {
      throw new Error(`Reload lost pending ${crossChain ? 'cross-chain' : 'native'} claim: heading is ${await page.locator('h1').textContent()}`);
    }
    assert.equal(verifierCalls, 1);
    assert.equal(relayCalls, 1);
    const reopened = await context.newPage(); // no OAuth attempt in this tab; only public recovery metadata
    await reopened.goto(`${base}/claim/7/${commitment}`);
    await reopened.waitForURL('**/receipt');
    await reopened.waitForFunction(() => document.querySelector('h1')?.textContent.includes('Sending Your Tokens'));
    await reopened.close();
    claimState = 'claimed';
    await page.waitForFunction(t => document.querySelector('h1')?.textContent.includes(t), crossChain ? 'Payout Failed' : 'Arrived', { timeout: 15000 });
    if (crossChain) {
      await page.getByText('Details', { exact: true }).click();
      assert.match(await page.locator('main').innerText(), /Destination transfer failed/);
      bridgeOffline = true;
      await page.reload();
      await page.waitForFunction(() => document.querySelector('h1')?.textContent.includes('Payout Failed'));
      assert.match(await page.locator('main').innerText(), /Claimed on NEAR/);
      assert.match(await page.locator('main').innerText(), /Tell the sender/);
      await page.getByText('Details', { exact: true }).click();
      assert.match(await page.locator('main').innerText(), /Destination transfer failed/);
      assert.match(await page.locator('main').innerText(), new RegExp(deposit));
    }
    assert.equal(verifierCalls, 1, 'reload must not ask for a fresh signature');
    assert.equal(relayCalls, 1, 'reload must not resubmit a claim');
    assert.equal(depositCalls, 0, 'recovery must not submit a deposit');
    assert.deepEqual(errors, []);
    console.log(`${crossChain ? 'Cross-chain' : 'Native'}${delayed ? ' delayed-visibility' : ''} reload recovery passed; no replayed payment requests.`);
  } finally { await browser.close(); }
}
(async () => { await run(false); await run(true); await run(false, true); await run(true, true); })().catch(e => { console.error(e); process.exitCode = 1; });
