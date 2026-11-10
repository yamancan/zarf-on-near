// Opens a claim card on the live site and clicks the Google button, stopping at Google's door: the request to
// accounts.google.com is captured and aborted, so no sign-in happens. Chain reads are stubbed to the spec vector
// link, because no live campaign link is at hand; the button, client id and redirect are the live build's.
// Usage: node web/scripts/google-button-check.cjs <claim origin> <expected client id>
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const v = require('../../spec/vectors.json');
const [base, clientId] = process.argv.slice(2);
const enc = (o) => [...Buffer.from(JSON.stringify(o))];
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  await p.route(/fastnear|rpc\./, async (r) => {
    const q = JSON.parse(r.request().postData()).params;
    const res = q.request_type === 'view_account' ? { result: { amount: '1' } }
      : { result: { result: enc(q.method_name === 'get_network' ? 'testnet' : q.method_name === 'get_campaign' ? { sender: 'sender.testnet', merkle_root: v.campaigns.main.merkle_root, deadline_ns: '1894488400000000000' } : 'unclaimed') } };
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...res }) });
  });
  let google;
  await p.route('https://accounts.google.com/**', (r) => { google = new URL(r.request().url()); return r.abort(); });
  await p.goto(base + v.links.main[0]); await p.waitForSelector('#dest');
  await p.fill('#dest', 'alice.testnet');
  const btn = p.locator('button.google, button:has-text("Sign in with Google")').first();
  await p.waitForFunction(() => { const b = document.querySelector('button.google'); return b && !b.disabled; }, null, { timeout: 15000 });
  await btn.click(); await p.waitForTimeout(2000);
  const ok = google && google.searchParams.get('client_id') === clientId && google.searchParams.get('redirect_uri') === `${base}/auth/google`
    && google.searchParams.get('response_type') === 'id_token' && /^[0-9a-f]{64}$/.test(google.searchParams.get('nonce') || '');
  console.log(JSON.stringify({ enabled: true, google: google && { host: google.host, client_id: google.searchParams.get('client_id'), redirect_uri: google.searchParams.get('redirect_uri'), scope: google.searchParams.get('scope') } }));
  await b.close();
  if (!ok) { console.error('FAIL: the button did not open Google with this client id and redirect'); process.exit(1); }
  console.log('PASS: Google button enabled, opens accounts.google.com with the right client id and redirect');
})();
