// Design renders: every screen and state, 390/1280, dark/light, all networks stubbed.
// Based on the previous agent's design.cjs and web/scripts/intents-e2e.cjs stubs.
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core [CHROME=/path/to/chrome] node scripts/shots.cjs http://127.0.0.1:5191 OUTDIR [filter]
// The page must run with PUBLIC_GOOGLE_CLIENT_ID set and the testnet endpoints (see the intents-e2e header).
// States behind PUBLIC_IMPLICIT_ACCOUNTS=on (name starts with "implicit-") need a second server with that flag.
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const v = require('../../spec/vectors.json');
const tokens = require('../src/lib/fixtures/1click-tokens.json');
const [base, out, filter] = process.argv.slice(2);
const enc = (o) => [...Buffer.from(JSON.stringify(o))];
const LINK = v.links.main[0];
const [, , CAMP, COMMIT] = LINK.split('#')[0].split('/');
const DEP = 'd'.repeat(64);
const EVM = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const FUTURE = '1894488400000000000', PAST = '1700000000000000000';
const camp = (o = {}) => ({ sender: 'sender.testnet', merkle_root: v.campaigns.main.merkle_root, deadline_ns: FUTURE, ...o });
const cview = (o) => ({ sender: 'sender.testnet', token: 'usdc', amount: '37500000', merkle_root: 'x', balance: '27500000', in_flight: '0', policy: '', snapshot: [], storage_reserved: '12000000000000000000000', deadline_ns: FUTURE, ...o });

function rpc(p, o = {}) {
  const st = { claimed: false };
  return p.route(/fastnear|rpc/, async (r) => {
    if (o.rpcDown) return r.fulfill({ status: 503, body: 'down' });
    const body = JSON.parse(r.request().postData());
    const q = body.params;
    let res;
    if (q.request_type === 'view_account') res = q.account_id === 'alice.testnet' || q.account_id === 'sender.testnet' ? { result: { amount: '1' } } : { error: { cause: { name: 'UNKNOWN_ACCOUNT' } } };
    else {
      const m = q.method_name, args = q.args_base64 ? JSON.parse(Buffer.from(q.args_base64, 'base64')) : {};
      const val = m === 'get_network' ? (o.network ?? 'testnet')
        : m === 'get_campaign' ? (o.campaigns ? o.campaigns[args.campaign_id] ?? null : 'campaign' in o ? o.campaign : camp(o.camp))
        : m === 'get_claim_state' || m === 'claim_state' ? (st.claimed ? 'claimed' : o.claimState ?? 'unclaimed')
        : m === 'get_config' ? { network: o.network ?? 'testnet', min_lifetime_ns: '3600000000000', agent_ttl_ns: '1', token_ids: ['3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af'], storage_byte_cost: '10000000000000000000' }
        : m === 'prepay_balance_of' ? '50000000000000000000000'
        : m === 'campaigns_of' ? (o.campaigns ? Object.keys(o.campaigns) : [])
        : 'unclaimed';
      res = { result: { result: enc(val) } };
    }
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...res }) });
  }).then(() => st);
}

async function oneclick(p, final) {
  await p.route('https://1click.chaindefuser.com/**', async (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/v0/tokens') return r.fulfill({ contentType: 'application/json', body: JSON.stringify(tokens) });
    if (u.pathname === '/v0/quote') {
      const b = JSON.parse(r.request().postData());
      return r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ quote: { amountIn: b.amount, amountOut: '9995580', amountOutFormatted: '9.99558', minAmountOut: '9895624', timeEstimate: 22, ...(b.dry ? {} : { depositAddress: DEP }) } }) });
    }
    if (u.pathname === '/v0/deposit/submit') return r.fulfill({ status: 200, body: '{}' });
    if (u.pathname === '/v0/status') {
      const swapDetails = final === 'SUCCESS' ? { amountOutFormatted: '9.99558', destinationChainTxHashes: [{ hash: '0xabc', explorerUrl: 'https://basescan.org/tx/0xabc' }] } : final === 'REFUNDED' ? { refundReason: 'route unavailable' } : {};
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: final, swapDetails }) });
    }
    return r.fulfill({ status: 404, body: '{}' });
  });
}

async function signinFlow(p, { verifierError } = {}) {
  await p.route('https://accounts.google.com/**', async (r) => {
    const u = new URL(r.request().url());
    await r.fulfill({ status: 302, headers: { location: `${base}/auth/google#id_token=h.p.s&state=${encodeURIComponent(u.searchParams.get('state'))}` } });
  });
  await p.route(/verifier.*\/claim$/, async (r) => {
    if (verifierError) return r.fulfill({ status: 400, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: verifierError, code: verifierError }) });
    const c = v.claims.valid[0].call_args;
    await r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(c) });
  });
  await p.route(/relayer.*\/claim$/, (r) => r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ status: 'paid', tx_hash: '6zgh2u9DqHHiXzdy9ouTP7oGky2T4nugqzqt9wJZwNFm' }) }));
}

const wallet = (ctx, id = 'sender.testnet') => ctx.addInitScript((a) => {
  localStorage.setItem('near-wallet-selector:selectedWalletId', JSON.stringify('my-near-wallet'));
  localStorage.setItem('near_app_wallet_auth_key', JSON.stringify({ accountId: a, allKeys: [] }));
  localStorage.setItem('near-wallet-selector:recentlySignedInWallets', JSON.stringify(['my-near-wallet']));
}, id);

const CSV = 'alice@gmail.com,10\nbob@gmail.com,2.5\nchen@gmail.com,25';
const S = {
  landing: async (p) => { await rpc(p); await p.goto(base + '/'); await p.waitForSelector('h1'); await p.waitForTimeout(2800); return { full: true }; },
  'landing-detail': async (p) => { await rpc(p); await p.goto(base + '/'); await p.waitForSelector('h1'); await p.getByText('Who sees the email?').click(); await p.waitForTimeout(2800); return { full: true }; },
  'claim-near': async (p) => { await rpc(p); await p.goto(base + LINK); await p.waitForSelector('#dest'); await p.fill('#dest', 'alice.testnet'); await p.waitForTimeout(1200); return { full: true }; },
  'claim-near-missing': async (p) => { await rpc(p); await p.goto(base + LINK); await p.waitForSelector('#dest'); await p.fill('#dest', 'alise.testnet'); await p.waitForTimeout(1200); return { full: true }; },
  'claim-chain-testnet': async (p) => { await rpc(p); await p.goto(base + LINK); await p.waitForSelector('#dest'); await p.getByText('Another chain', { exact: true }).click(); await p.waitForTimeout(400); return { full: true }; },
  'claim-chain-mainnet': async (p) => { await rpc(p, { network: 'mainnet', camp: { sender: 'sender.near' } }); await oneclick(p, 'SUCCESS'); await p.goto(base + LINK); await p.waitForSelector('#dest'); await p.getByText('Another chain', { exact: true }).click(); await p.waitForSelector('#chain'); await p.fill('#addr', EVM); await p.waitForSelector('.quote'); await p.waitForTimeout(300); return { full: true }; },
  'claim-checking': async (p) => { await p.route(/fastnear|rpc/, () => {}); await p.goto(base + LINK); await p.waitForTimeout(800); return {}; },
  'term-unknown': async (p) => { await rpc(p, { campaign: null }); await p.goto(base + LINK); await p.waitForSelector('h1'); return {}; },
  'term-mismatch': async (p) => { await rpc(p, { camp: { merkle_root: 'f'.repeat(64) } }); await p.goto(base + LINK); await p.waitForSelector('h1'); return {}; },
  'term-claimed': async (p) => { await rpc(p, { claimState: 'claimed' }); await p.goto(base + LINK); await p.waitForSelector('h1'); return {}; },
  'term-pending': async (p) => { await rpc(p, { claimState: 'pending' }); await p.goto(base + LINK); await p.waitForSelector('h1'); return {}; },
  'term-ended': async (p) => { await rpc(p, { camp: { deadline_ns: PAST } }); await p.goto(base + LINK); await p.waitForSelector('h1'); return {}; },
  'term-incomplete': async (p) => { await rpc(p); await p.goto(base + LINK.split('#')[0]); await p.waitForSelector('h1'); return {}; },
  'term-broken': async (p) => { await rpc(p); await p.goto(base + '/claim/x/zz'); await p.waitForSelector('h1'); return {}; },
  'term-error': async (p) => { await rpc(p, { rpcDown: true }); await p.goto(base + LINK); await p.waitForSelector('h1'); return {}; },
  'receipt-near': async (p) => { await rpc(p); await signinFlow(p); await p.goto(base + LINK); await p.fill('#dest', 'alice.testnet'); await p.waitForTimeout(1200); await p.locator('button.google').click(); await p.waitForURL(/receipt/); await p.waitForTimeout(1500); return { full: true }; },
  'receipt-failed': async (p) => { await rpc(p); await signinFlow(p, { verifierError: 'COMMITMENT_MISMATCH' }); await p.goto(base + LINK); await p.fill('#dest', 'alice.testnet'); await p.waitForTimeout(1200); await p.locator('button.google').click(); await p.waitForURL(/receipt/); await p.waitForTimeout(1500); return { full: true }; },
  ...Object.fromEntries(['SUCCESS', 'REFUNDED', 'PROCESSING'].map((f) => [`receipt-chain-${f.toLowerCase()}`, async (p) => {
    await rpc(p, { network: 'mainnet', camp: { sender: 'sender.near' } }); await oneclick(p, f); await signinFlow(p);
    await p.route(/verifier.*\/claim$/, async (r) => r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ...v.claims.valid[0].call_args, destination: DEP }) }));
    await p.goto(base + LINK); await p.getByText('Another chain', { exact: true }).click(); await p.fill('#addr', EVM); await p.waitForSelector('.quote');
    await p.locator('button.google').click(); await p.waitForURL(/receipt/); await p.waitForTimeout(f === 'PROCESSING' ? 2500 : 3000); return { full: true };
  }])),
  'receipt-empty': async (p) => { await rpc(p); await p.goto(base + `/claim/${CAMP}/${COMMIT}/receipt`); await p.waitForSelector('h1'); return {}; },
  'auth-cancelled': async (p) => { await p.goto(base + '/auth/google#error=access_denied'); await p.waitForSelector('h1'); return {}; },
  'create-1': async (p) => { await rpc(p); await p.goto(base + '/create'); await p.waitForTimeout(1500); return { full: true }; },
  'create-1-filled': async (p) => { await rpc(p); await p.goto(base + '/create'); await p.waitForSelector('#recipients'); await p.fill('#recipients', CSV + '\nnot-an-email,3'); await p.waitForTimeout(500); return { full: true }; },
  'create-2': async (p) => { await rpc(p); await p.goto(base + '/create'); await p.waitForSelector('#recipients'); await p.fill('#recipients', CSV); await p.getByRole('button', { name: 'Continue' }).click(); await p.waitForTimeout(500); return { full: true }; },
  'create-3': async (p) => { await rpc(p); await p.goto(base + '/create'); await p.waitForSelector('#recipients'); await p.fill('#recipients', CSV); await p.getByRole('button', { name: 'Continue' }).click(); await p.getByRole('button', { name: 'Continue' }).click(); await p.waitForTimeout(800); return { full: true }; },
  'create-3-wallet': async (p, ctx) => { await wallet(ctx); await rpc(p); await p.goto(base + '/create'); await p.waitForSelector('#recipients'); await p.waitForTimeout(1500); await p.fill('#recipients', CSV); await p.getByRole('button', { name: 'Continue' }).click(); await p.getByRole('button', { name: 'Continue' }).click(); await p.waitForTimeout(800); return { full: true }; },
  'create-4': async (p, ctx) => { await wallet(ctx); await rpc(p); await p.goto(base + '/create'); await p.waitForSelector('#recipients'); await p.waitForTimeout(1500); await p.fill('#recipients', CSV); await p.getByRole('button', { name: 'Continue' }).click(); await p.getByRole('button', { name: 'Continue' }).click(); await p.getByRole('button', { name: 'Generate claim links' }).click(); await p.waitForTimeout(800); return { full: true }; },
  'create-done': async (p, ctx) => {
    await ctx.addInitScript(() => sessionStorage.setItem('zarf-near:create-funding', JSON.stringify({ txHash: 'H', sender: 'sender.testnet', deadline: '2026-12-01T12:00', campaignId: '12',
      draft: { merkleRoot: 'ab'.repeat(32), total: '37500000', recipients: [['alice@gmail.com', '10000000'], ['bob@gmail.com', '2500000'], ['chen@gmail.com', '25000000']].map(([email, amount], i) => ({ email, amount, salt: String(i).repeat(44), commitment: String(i).repeat(64), proof: [] })) } })));
    await rpc(p); await p.goto(base + '/create'); await p.waitForTimeout(2000); return { full: true };
  },
  'campaigns-connect': async (p) => { await rpc(p); await p.goto(base + '/campaigns'); await p.waitForTimeout(1500); return { full: true }; },
  'campaigns-list': async (p, ctx) => { await wallet(ctx); await rpc(p, { campaigns: { 12: cview({ deadline_ns: PAST }), 13: cview({ amount: '5000000', balance: '5000000' }) } }); await p.goto(base + '/campaigns'); await p.waitForTimeout(2000); return { full: true }; },
  privacy: async (p) => { await p.goto(base + '/privacy'); await p.waitForSelector('h1'); return { full: true }; },
  notfound: async (p) => { await p.goto(base + '/nope'); await p.waitForSelector('h1'); return {}; },
};

(async () => {
  const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  for (const [name, fn] of Object.entries(S)) {
    if (filter && !new RegExp(filter).test(name)) continue;
    for (const theme of (process.env.THEMES || 'dark,light').split(',')) for (const [w, h] of [[390, 844], [1280, 800]].filter(([w]) => (process.env.WIDTHS || '390,1280').split(',').includes(String(w)))) {
      const ctx = await b.newContext({ viewport: { width: w, height: h } });
      await ctx.addInitScript((t) => localStorage.setItem('zarf_theme', t), theme);
      const p = await ctx.newPage();
      const errs = []; p.on('pageerror', (e) => errs.push(String(e))); p.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 140)));
      try {
        const o = (await fn(p, ctx)) || {};
        await p.screenshot({ path: `${out}/${name}-${theme}-${w}.png`, fullPage: !!o.full });
        if (errs.length && theme === 'dark' && w === 390) console.log(name, 'console:', errs.slice(0, 3).join(' | '));
      } catch (e) { console.log(name, theme, w, 'FAIL', String(e).split('\n')[0]); }
      await ctx.close();
    }
  }
  await b.close();
})();
