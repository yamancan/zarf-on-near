// Design renders: every screen and state, 390/1280, dark/light, all networks stubbed.
// Based on the previous agent's design.cjs and web/scripts/intents-e2e.cjs stubs.
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core [CHROME=/path/to/chrome] node scripts/shots.cjs http://127.0.0.1:5191 OUTDIR [filter]
// The page must run with PUBLIC_GOOGLE_CLIENT_ID set and the testnet endpoints (see the intents-e2e header).
// States behind PUBLIC_IMPLICIT_ACCOUNTS=on (name starts with "implicit-") need a second server with that flag.
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const v = require('../../spec/vectors.json');
const tokens = require('../src/lib/fixtures/1click-tokens.json');
const tokensUsdc = require('../src/lib/fixtures/1click-tokens-usdc.json'); // T-025: every chain 1Click lists Circle USDC on
const [base, out, filter] = process.argv.slice(2);
const enc = (o) => [...Buffer.from(JSON.stringify(o))];
// T-002: the NEAR path asks "Is this your account?" before Google; answer it when it shows (no-op elsewhere).
const yes = async (p) => { const b = p.getByLabel('This is my account. The USDC cannot be taken back.'); try { await b.waitFor({ state: 'attached', timeout: 3000 }); await b.check({ force: true }); } catch {} };
const LINK = v.links.main[0];
const [, , CAMP, COMMIT] = LINK.split('#')[0].split('/');
const DEP = 'd'.repeat(64);
const TX = '6zgh2u9DqHHiXzdy9ouTP7oGky2T4nugqzqt9wJZwNFm';
const IMPLICIT = require('node:crypto').createHash('sha256').update('zarf-near render').digest('hex'); // a plausible ed25519 hex id
const EVM = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
// One sample deadline across every render: "6 days left" (the create form's default, a week from now, reads 6 days
// and some hours), closed two days ago (critic r2 P1-14, r3 P2-4).
const NS = (ms) => (BigInt(Math.floor(ms)) * 1_000_000n).toString();
const SOON = Date.now() + 7 * 86_400_000 - 3_600_000;
const FUTURE = NS(SOON), PAST = NS(Date.now() - 2 * 86_400_000);
const pad = (n) => String(n).padStart(2, '0');
const LOCAL_SOON = ((d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`)(new Date(SOON));
// The judge's own link from the faucet: one leaf of 0.5 test USDC, so the root is the leaf hash and the proof is empty.
const JUDGE_AMOUNT = '500000';
const JUDGE_ROOT = require('node:crypto').createHash('sha256').update(Buffer.concat([Buffer.of(0), Buffer.from(COMMIT, 'hex'), Buffer.from((BigInt(JUDGE_AMOUNT)).toString(16).padStart(32, '0'), 'hex').reverse()])).digest('hex');
const JUDGE_LINK = `/claim/${CAMP}/${COMMIT}#s=${'80'.repeat(32)}&a=${JUDGE_AMOUNT}&p=`;
const camp = (o = {}) => ({ sender: 'sender.testnet', merkle_root: v.campaigns.main.merkle_root, deadline_ns: FUTURE, ...o });
const cview = (o) => ({ sender: 'sender.testnet', token: 'usdc', amount: '37500000', merkle_root: 'x', balance: '27500000', in_flight: '0', policy: '', snapshot: [], storage_reserved: '4620000000000000000000', deadline_ns: FUTURE, ...o }); // 3 links, 1 claimed: 2 × per_claim_storage

function rpc(p, o = {}) {
  const st = { claimed: false, reads: 0 };
  return p.route(/fastnear|rpc/, async (r) => {
    if (o.rpcDown) return r.fulfill({ status: 503, body: 'down' });
    const body = JSON.parse(r.request().postData());
    const q = body.params;
    let res;
    if (body.method === 'gas_price') res = { result: { gas_price: '100000000' } }; // live testnet value, 12 Nov
    else if (body.method === 'block') res = { result: { header: { hash: TX, height: 1 } } };
    else if (body.method === 'tx' || body.method === 'EXPERIMENTAL_tx_status') {
      if (!o.tx) return r.fulfill({ status: 503, body: 'down' }); // lookup never succeeds: "checking"
      res = { result: { status: { SuccessValue: '' }, transaction: { hash: TX }, transaction_outcome: { id: TX, outcome: { status: { SuccessValue: '' } } }, ...o.tx } };
    } else if (q.request_type === 'view_account') {
      if (o.accountDown) return r.fulfill({ status: 503, body: 'down' });
      if (o.accountSlow) return; // never answers: the field stays on "Checking…"
      if (o.nearDown && q.account_id === 'sender.testnet') return r.fulfill({ status: 503, body: 'down' });
      res = q.account_id === 'sender.testnet' ? { result: { amount: o.near ?? '5000000000000000000000000', storage_usage: 182 } }
        : q.account_id === 'alice.testnet' ? { result: { amount: '1' } } : { error: { cause: { name: 'UNKNOWN_ACCOUNT' } } };
    }
    else {
      const m = q.method_name, args = q.args_base64 ? JSON.parse(Buffer.from(q.args_base64, 'base64')) : {};
      if (o.hang && o.hang === m) return;
      if (o.fail && o.fail === m) return r.fulfill({ status: 503, body: 'down' });
      const val = m === 'get_network' ? (o.network ?? 'testnet')
        : m === 'ft_balance_of' ? (o.balance ?? '120000000')
        : m === 'storage_costs' ? { ft_storage_deposit: '1250000000000000000000', claim_entry_cost: '1060000000000000000000', per_claim_storage: '2310000000000000000000', campaign_bytes_cost: '7090000000000000000000' } // live, zarf-near-1112.testnet, 12 Nov
        : m === 'campaign_by_root' ? (o.byRoot ?? null)
        : m === 'get_campaign' ? (o.campaigns ? o.campaigns[args.campaign_id] ?? null : 'campaign' in o ? o.campaign : camp(o.camp))
        : (m === 'get_claim_state' || m === 'claim_state') && o.claimBy ? (o.claimBy[args.commitment] ?? 'unclaimed')
        : m === 'get_claim_state' || m === 'claim_state' ? (st.claimed ? 'claimed' : o.claimStateAfterFirst ? (st.reads++ ? o.claimStateAfterFirst : 'unclaimed') : o.claimState ?? 'unclaimed')
        : m === 'get_config' ? { network: o.network ?? 'testnet', min_lifetime_ns: '3600000000000', agent_ttl_ns: '1', token_ids: ['3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af'], storage_byte_cost: '10000000000000000000' }
        : m === 'prepay_balance_of' ? (o.prepay ?? '50000000000000000000000')
        : m === 'campaigns_of' ? (o.campaigns ? Object.keys(o.campaigns) : [])
        : 'unclaimed';
      res = { result: { result: enc(val) } };
    }
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...res }) });
  }).then(() => st);
}

async function oneclick(p, final, o = {}) {
  await p.route('https://1click.chaindefuser.com/**', async (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/v0/tokens') {
      if (o.tokens === 'hang') return;
      if (o.tokens === 'down') return r.fulfill({ status: 500, body: '{}' });
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify(o.tokens === 'usdc' ? tokensUsdc : tokens) });
    }
    if (u.pathname === '/v0/quote') {
      const b = JSON.parse(r.request().postData());
      const mode = b.dry ? o.dry : o.real;
      if (mode === 'hang') return;
      if (mode === 'refuse') return r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'Amount is too low for this route.' }) });
      if (mode === 'down') return r.fulfill({ status: 500, body: '{}' });
      if (mode === 'loss') return r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ quote: { amountIn: b.amount, amountOut: '9000000', amountOutFormatted: '9.0', minAmountOut: '8900000', timeEstimate: 22, ...(b.dry ? {} : { depositAddress: DEP }) } }) });
      return r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ quote: { amountIn: b.amount, amountOut: '9995580', amountOutFormatted: '9.99558', minAmountOut: '9895624', timeEstimate: 22, ...(b.dry ? {} : { depositAddress: DEP }) } }) });
    }
    if (u.pathname === '/v0/deposit/submit') return r.fulfill({ status: 200, body: '{}' });
    if (u.pathname === '/v0/status') {
      const now = typeof final === 'function' ? final() : final; // a function: the status changes over time
      const swapDetails = now === 'SUCCESS' ? { amountOutFormatted: '9.99558', destinationChainTxHashes: [{ hash: '0xabc', explorerUrl: 'https://basescan.org/tx/0xabc' }] } : now === 'REFUNDED' ? { refundReason: 'route unavailable' } : {};
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: now, swapDetails }) });
    }
    return r.fulfill({ status: 404, body: '{}' });
  });
}

async function signinFlow(p, { verifierError, verifierHang, relayer } = {}) {
  await p.route('https://accounts.google.com/**', async (r) => {
    const u = new URL(r.request().url());
    await r.fulfill({ status: 302, headers: { location: `${base}/auth/google#id_token=h.p.s&state=${encodeURIComponent(u.searchParams.get('state'))}` } });
  });
  await p.route(/verifier.*\/claim$/, async (r) => {
    if (verifierHang) return;
    if (verifierError) return r.fulfill({ status: 400, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: verifierError, code: verifierError }) });
    const c = v.claims.valid[0].call_args;
    await r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(c) });
  });
  await p.route(/relayer.*\/claim$/, (r) => {
    if (relayer === 'hang') return;
    if (relayer === 'reverted') return r.fulfill({ status: 409, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: 'E115_TOKEN_TRANSFER_FAILED', tx_hash: TX }) });
    const status = relayer === 'submitted' ? 202 : 200;
    return r.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ status: relayer === 'submitted' ? 'submitted' : 'paid', tx_hash: TX }) });
  });
}


// Claim to a NEAR account, sign in (stubbed Google), land on the receipt.
const nearClaim = async (p, o = {}) => {
  await rpc(p, o.rpc); await signinFlow(p, o);
  await p.goto(base + LINK); await p.fill('#dest', o.dest ?? 'alice.testnet'); await p.waitForTimeout(1200);
  if (o.ack) await p.getByText(/I hold it/).click();
  await yes(p); await p.locator('button.google').click(); await p.waitForURL(/receipt/); await p.waitForTimeout(o.wait ?? 1500);
  return { full: true };
};
// Cross-chain (mainnet) up to the quote; `go` signs in.
const chainClaim = async (p, o = {}) => {
  await rpc(p, { network: 'mainnet', camp: { sender: 'sender.near' }, ...o.rpc }); await oneclick(p, o.final ?? 'SUCCESS', o.q); await signinFlow(p, o);
  await p.route(/verifier.*\/claim$/, async (r) => {
    if (o.verifierHang) return;
    if (o.verifierError) return r.fulfill({ status: 400, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: o.verifierError }) });
    r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ...v.claims.valid[0].call_args, destination: DEP }) });
  });
  await p.goto(base + LINK); await p.getByText('Other Chain', { exact: true }).click();
  if (o.stopAt === 'picker') { await p.waitForTimeout(o.wait ?? 1200); return { full: true }; }
  await p.fill('#addr', o.addr ?? EVM);
  if (o.stopAt === 'quote') { await p.waitForTimeout(o.wait ?? 1500); return { full: true }; }
  await p.waitForSelector('.quote');
  if (o.stopAt === 'quoted') { await p.waitForTimeout(300); return { full: true }; }
  await yes(p); await p.locator('button.google').click();
  if (o.stopAt === 'signin') { await p.waitForTimeout(o.wait ?? 1200); return { full: true }; }
  await p.waitForURL(/receipt/); await p.waitForTimeout(o.wait ?? 3000); return { full: true };
};
// Receipt page only (it is reached from /auth/google by client navigation, so both paths): run timers 1000x faster (the 30-minute bridge watch) or move the clock (quote expiry).
const fastTimers = (ctx) => ctx.addInitScript(() => { if (!/\/receipt$|\/auth\/google$/.test(location.pathname)) return; const st = window.setTimeout; window.setTimeout = (f, ms, ...a) => st(f, (ms || 0) / 1000, ...a); });
// Receipt page only: virtual time, every timer fires at once and moves the clock by its delay (the 60 s settle watch).
const virtualClock = (ctx) => ctx.addInitScript(() => { if (!/\/receipt$|\/auth\/google$/.test(location.pathname)) return; let off = 0; const n = Date.now.bind(Date), st = window.setTimeout; Date.now = () => n() + off; window.setTimeout = (f, ms, ...a) => st(() => { off += ms || 0; f(...a); }, 0); });
const lateClock = (ctx) => ctx.addInitScript(() => { if (!/\/receipt$|\/auth\/google$/.test(location.pathname)) return; const n = Date.now.bind(Date); Date.now = () => n() + 3_600_000; });

// NEAR Connect: Meteor's executor (wallets.json) is served by a stub. It signs in as the account set by wallet(ctx)
// and answers signAndSendTransactions per walletPopup's mode: 'ok' returns TX, 'fail' rejects, 'hang' never answers.
const stubExecutor = (ctx, o) => ctx.route(/meteor-near-connect-latest\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body: `
  const acct = ${JSON.stringify(o.id ?? 'sender.testnet')}; const mode = ${JSON.stringify(o.mode ?? 'hang')};
  window.selector.ready({
    async signIn() { if (mode === 'fail') throw new Error('User rejected the request'); return [{ accountId: acct, publicKey: '' }]; },
    async signOut() {},
    async getAccounts() { return [{ accountId: acct, publicKey: '' }]; },
    async signAndSendTransactions() { if (mode === 'ok') return [{ transaction: { hash: ${JSON.stringify(TX)} } }]; if (mode === 'fail') throw new Error('User rejected the request'); return new Promise(() => {}); },
  });` }));
const walletState = new WeakMap();
const walletPopup = (ctx, mode) => { const o = walletState.get(ctx) ?? {}; o.mode = mode; walletState.set(ctx, o); return stubExecutor(ctx, o); };
const ROOT = 'ab'.repeat(32);
/** The /create recipient grid: Paste List → text → Add to List. */
const pasteList = async (p, text) => { await p.getByRole('button', { name: 'Paste List' }).click(); await p.fill('#paste-text', text); await p.getByRole('button', { name: 'Add to List' }).click(); };
const DRAFT = { merkleRoot: ROOT, total: '37500000', recipients: [['alice@gmail.com', '10000000'], ['bob@gmail.com', '2500000'], ['chen@gmail.com', '25000000']].map(([email, amount], i) => ({ email, amount, salt: String(i).repeat(44), commitment: String(i).repeat(64), proof: [] })) };
const funding = (ctx, f) => ctx.addInitScript((f) => sessionStorage.setItem('zarf-near:create-funding', JSON.stringify(f)), { sender: 'sender.testnet', deadline: LOCAL_SOON, draft: DRAFT, ...f });
const ev = (event, data) => `EVENT_JSON:${JSON.stringify({ standard: 'zarf-near', version: '1.0.0', event, data: [data] })}`;
const CONTRACT = 'zarf-near-1112.testnet', TOKEN = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const receipts = (...rs) => ({ receipts_outcome: rs.map(([executor_id, extra]) => ({ id: TX, outcome: { executor_id, logs: [], status: { SuccessValue: '' }, ...extra } })) });
const toStep4 = async (p) => {
  await p.goto(base + '/create'); await p.waitForSelector('[aria-label="Recipient 1 email"]'); await p.waitForTimeout(1500); await pasteList(p, CSV);
  await p.getByRole('button', { name: 'Continue' }).click(); await p.getByRole('button', { name: 'Continue' }).click(); await p.waitForTimeout(600);
  await p.getByRole('button', { name: 'Continue' }).click(); await p.waitForTimeout(800);
};
const saveBackup = (p) => p.getByRole('button', { name: 'Download Backup' }).click();
const ackBackup = async (p) => { await saveBackup(p); await p.getByText('I Saved the Backup').click(); };
// /create only: timers 1000x faster, so the 45 s of tx-lookup retries end in a render's wait.
const fastCreate = (ctx) => ctx.addInitScript(() => { if (location.pathname !== '/create') return; const st = window.setTimeout; window.setTimeout = (f, ms, ...a) => st(f, (ms || 0) / 1000, ...a); });
const toStep = async (p, n, csv = CSV) => {
  await p.goto(base + '/create'); await p.waitForSelector('[aria-label="Recipient 1 email"]'); await p.waitForTimeout(1500); await pasteList(p, csv);
  for (let i = 0; i < n; i++) { await p.getByRole('button', { name: 'Continue' }).click(); await p.waitForTimeout(600); }
  await p.waitForTimeout(400);
};
const SEND = 'Send 37.5 Test USDC';
const pickDate = (p) => p.locator('[data-pick="date"]').click();

const wallet = async (ctx, id = 'sender.testnet') => {
  const o = walletState.get(ctx) ?? {}; o.id = id; walletState.set(ctx, o);
  await ctx.addInitScript(() => { try { if (window === window.top) localStorage.setItem("selected-wallet", "meteor-wallet"); } catch {} });
  await stubExecutor(ctx, o);
};

// Step 3 with a connected wallet that is 27.5 test USDC short (T-019 funding states start here).
const toShort = async (p, ctx) => { await wallet(ctx); await rpc(p, { balance: '10000000' }); await p.goto(base + '/create'); await p.waitForSelector('[aria-label="Recipient 1 email"]'); await p.waitForTimeout(1500); await pasteList(p, CSV); await p.getByRole('button', { name: 'Continue' }).click(); await p.getByRole('button', { name: 'Continue' }).click(); await p.waitForTimeout(1000); };
const fundStart = async (p, ctx) => { await toShort(p, ctx); await p.locator('[data-source="base"]').click(); await p.getByLabel('Your Base Address').fill(EVM); await p.getByLabel('Its Last 6 Characters').fill(EVM.slice(-6)); await p.waitForTimeout(300); await p.locator('[data-fund]').scrollIntoViewIfNeeded(); };
const heroShown = (p) => p.waitForFunction(() => { const a = [...document.querySelectorAll('a')].find((x) => /Try with Google/.test(x.textContent)); return a && getComputedStyle(a.parentElement).opacity === '1'; }, null, { timeout: 15000 }).then(() => p.waitForTimeout(200));
// Without PUBLIC_GOOGLE_CLIENT_ID (row 46): blank the value in the served env, nothing else changes.
const noGoogle = (p) => p.route((u) => u.pathname.startsWith('/claim/') && !u.pathname.includes('.'), async (r) => {
  const res = await r.fetch(); const body = (await res.text()).replace(/"PUBLIC_GOOGLE_CLIENT_ID":\s*"[^"]*"/, '"PUBLIC_GOOGLE_CLIENT_ID":""');
  await r.fulfill({ response: res, body });
});
const CSV = 'alice@gmail.com,10\nbob@gmail.com,2.5\nchen@gmail.com,25';
const S = {
  // The hero's buttons fade in ~1.2 s after load (Zarf's Hero): wait until they are fully shown.
  landing: async (p) => { await rpc(p); await p.goto(base + '/'); await p.waitForSelector('h1'); await heroShown(p); return { full: true }; },
  // Reduced motion: the buttons must be there at once, no wait.
  'landing-reduced': async (p) => { await p.emulateMedia({ reducedMotion: 'reduce' }); await rpc(p); await p.goto(base + '/'); await p.waitForSelector('h1'); await p.waitForTimeout(150); return {}; },
  'claim-near': async (p) => { await rpc(p); await p.goto(base + LINK); await p.waitForSelector('#dest'); await p.fill('#dest', 'alice.testnet'); await p.waitForTimeout(1200); return { full: true }; },
  'claim-near-missing': async (p) => { await rpc(p); await p.goto(base + LINK); await p.waitForSelector('#dest'); await p.fill('#dest', 'alise.testnet'); await p.waitForTimeout(1200); return { full: true }; },
  'claim-testnet-detail': async (p) => { await rpc(p); await p.goto(base + LINK); await p.waitForSelector('#dest'); await p.getByRole('button', { name: /Who sees the email/ }).focus(); await p.waitForTimeout(400); return { full: true }; },
  'claim-chain-mainnet': async (p) => { await rpc(p, { network: 'mainnet', camp: { sender: 'sender.near' } }); await oneclick(p, 'SUCCESS'); await p.goto(base + LINK); await p.waitForSelector('#dest'); await p.getByText('Other Chain', { exact: true }).click(); await p.waitForSelector('#chain'); await p.fill('#addr', EVM); await p.waitForSelector('.quote'); await p.waitForTimeout(300); return { full: true }; },
  // RPC never answers: wait for the app's own checking card, not the boot mark (critic r2 coverage row 23).
  'claim-checking': async (p) => { await p.route(/fastnear|rpc/, () => {}); await p.goto(base + LINK); await p.getByRole('heading', { name: 'Checking Claim…' }).waitFor({ timeout: 20000 }); await p.waitForTimeout(300); return {}; },
  // The app's script never arrives: the first paint the recipient sees on a slow phone.
  'boot-opening': async (p) => { await p.route(/\/(src|node_modules|@vite|@fs|\.svelte-kit|@id)\//, (r) => r.abort()); await p.goto(base + LINK, { waitUntil: 'commit' }); await p.waitForSelector('#boot-line'); await p.waitForTimeout(800); return {}; },
  'claim-no-google': async (p) => { await noGoogle(p); await rpc(p); await p.goto(base + LINK); await p.waitForSelector('#dest'); await p.fill('#dest', 'alice.testnet'); await yes(p); await yes(p); await p.locator('button.google').click(); await p.waitForTimeout(400); return { full: true }; },
  'claim-no-account': async (p) => { await rpc(p); await p.context().route(/meteorwallet/, (r) => r.abort()); await p.goto(base + LINK); await p.waitForSelector('#dest'); await p.context().on('page', (pg) => pg.close().catch(() => {})); await p.getByText('Get a NEAR Account').click(); await p.bringToFront(); await p.waitForTimeout(400); return { full: true }; },
  'claim-faceid': async (p) => { await rpc(p); await p.goto(base + LINK); await p.waitForSelector('#dest'); await p.getByText('Face ID', { exact: true }).click(); await p.waitForTimeout(400); return { full: true }; },
  'claim-chain-testnet-quote': async (p) => { await rpc(p); await oneclick(p, 'SUCCESS', { tokens: 'usdc' }); await p.goto(base + LINK); await p.waitForSelector('#dest'); await p.getByText('Other Chain', { exact: true }).click(); await p.fill('#addr', EVM); await p.waitForSelector('.quote', { timeout: 20000 }); await p.waitForTimeout(300); return { full: true }; },
  'claim-chain-testnet': async (p) => { await rpc(p); await oneclick(p, 'SUCCESS', { tokens: 'usdc' }); await p.goto(base + LINK); await p.waitForSelector('#dest'); await p.getByText('Other Chain', { exact: true }).click(); await p.waitForTimeout(400); return { full: true }; },
  'term-unknown': async (p) => { await rpc(p, { campaign: null }); await p.goto(base + LINK); await p.waitForSelector('h1'); return {}; },
  'term-mismatch': async (p) => { await rpc(p, { camp: { merkle_root: 'f'.repeat(64) } }); await p.goto(base + LINK); await p.waitForSelector('h1'); return {}; },
  'term-claimed': async (p) => { await rpc(p, { claimState: 'claimed' }); await p.goto(base + LINK); await p.waitForSelector('h1'); return {}; },
  'term-pending': async (p) => { await rpc(p, { claimState: 'pending' }); await p.goto(base + LINK); await p.waitForSelector('h1'); return {}; },
  'term-ended': async (p) => { await rpc(p, { camp: { deadline_ns: PAST } }); await p.goto(base + LINK); await p.waitForSelector('h1'); return {}; },
  'term-incomplete': async (p) => { await rpc(p); await p.goto(base + LINK.split('#')[0]); await p.waitForSelector('h1'); return {}; },
  'term-broken': async (p) => { await rpc(p); await p.goto(base + '/claim/x/zz'); await p.waitForSelector('h1'); return {}; },
  'term-error': async (p) => { await rpc(p, { rpcDown: true }); await p.goto(base + LINK); await p.waitForSelector('h1'); return {}; },
  'receipt-near': async (p) => { await rpc(p); await signinFlow(p); await p.goto(base + LINK); await p.fill('#dest', 'alice.testnet'); await p.waitForTimeout(1200); await yes(p); await p.locator('button.google').click(); await p.waitForURL(/receipt/); await p.waitForTimeout(1500); return { full: true }; },
  // The judge's own card: the faucet's 0.5 test USDC link (critic r3 P1-8).
  'claim-judge': async (p) => { await rpc(p, { camp: { sender: 'zarf-near-faucet-1112.testnet', merkle_root: JUDGE_ROOT } }); await p.goto(base + JUDGE_LINK); await p.waitForSelector('#dest'); await p.fill('#dest', 'alice.testnet'); await yes(p); await p.waitForTimeout(300); return { full: true }; },
  // The general failure: the verifier could not reach NEAR (canvas N4-02), not another Google account.
  'receipt-failed': async (p) => { await rpc(p); await signinFlow(p, { verifierError: 'RPC_ERROR' }); await p.goto(base + LINK); await p.fill('#dest', 'alice.testnet'); await p.waitForTimeout(1200); await yes(p); await p.locator('button.google').click(); await p.waitForURL(/receipt/); await p.waitForTimeout(1500); return { full: true }; },
  ...Object.fromEntries(['SUCCESS', 'REFUNDED', 'PROCESSING'].map((f) => [`receipt-chain-${f.toLowerCase()}`, async (p) => {
    await rpc(p, { network: 'mainnet', camp: { sender: 'sender.near' } }); await oneclick(p, f); await signinFlow(p);
    await p.route(/verifier.*\/claim$/, async (r) => r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ...v.claims.valid[0].call_args, destination: DEP }) }));
    await p.goto(base + LINK); await p.getByText('Other Chain', { exact: true }).click(); await p.fill('#addr', EVM); await p.waitForSelector('.quote');
    await yes(p); await p.locator('button.google').click(); await p.waitForURL(/receipt/); await p.waitForTimeout(f === 'PROCESSING' ? 2500 : 3000); return { full: true };
  }])),
  boot: async (p) => { await p.goto(base + LINK); return {}; },
  'claim-empty': async (p) => { await rpc(p); await p.goto(base + LINK); await p.waitForSelector('#dest'); await p.waitForTimeout(400); return { full: true }; },
  'claim-acct-checking': async (p) => { await rpc(p, { accountSlow: true }); await p.goto(base + LINK); await p.waitForSelector('#dest'); await p.fill('#dest', 'alice.testnet'); await p.waitForTimeout(900); return { full: true }; },
  'claim-implicit-missing': async (p) => { await rpc(p); await p.goto(base + LINK); await p.waitForSelector('#dest'); await p.fill('#dest', IMPLICIT); await p.waitForTimeout(1200); return { full: true }; },
  'claim-wrong': async (p) => { await rpc(p); await p.goto(base + LINK); await p.waitForSelector('#dest'); await p.fill('#dest', 'G' + 'A'.repeat(55)); await p.waitForTimeout(600); return { full: true }; },
  // PUBLIC_ETH_ACCOUNTS=on (testnet build): a MetaMask 0x that is not on NEAR yet gets its own line (T-016).
  'claim-eth-new': async (p) => { await rpc(p); await p.goto(base + LINK); await p.waitForSelector('#dest'); await p.fill('#dest', EVM); await p.waitForTimeout(1200); return { full: true }; },
  'claim-acct-error': async (p) => { await rpc(p, { accountDown: true }); await p.goto(base + LINK); await p.waitForSelector('#dest'); await p.fill('#dest', 'alice.testnet'); await p.waitForTimeout(1200); return { full: true }; },
  'claim-chain-loading': (p) => chainClaim(p, { q: { tokens: 'hang' }, stopAt: 'picker' }),
  'claim-chain-unavailable': (p) => chainClaim(p, { q: { tokens: 'down' }, stopAt: 'picker' }),
  'claim-chain-addr-error': (p) => chainClaim(p, { addr: EVM.slice(0, -1) + 'D', stopAt: 'quote', wait: 600 }),
  'claim-chain-quoting': (p) => chainClaim(p, { q: { dry: 'hang' }, stopAt: 'quote', wait: 1200 }),
  'claim-chain-refused': (p) => chainClaim(p, { q: { dry: 'refuse' }, stopAt: 'quote' }),
  'claim-chain-loss': (p) => chainClaim(p, { q: { dry: 'loss' }, stopAt: 'quote' }),
  'claim-chain-detail': async (p) => { const o = await chainClaim(p, { stopAt: 'quoted' }); await p.getByText('Details', { exact: true }).click(); await p.waitForTimeout(300); return o; },
  'claim-signin-busy': (p) => chainClaim(p, { q: { real: 'hang' }, stopAt: 'signin' }),
  'claim-signin-quote-failed': (p) => chainClaim(p, { q: { real: 'down' }, stopAt: 'signin' }),
  'claim-signin-quote-refused': (p) => chainClaim(p, { q: { real: 'loss' }, stopAt: 'signin' }),
  'auth-signing': async (p, ctx) => {
    await ctx.addInitScript(([c, k]) => sessionStorage.setItem('zarf-near:attempt', JSON.stringify({ campaign: c, commitment: k, salt: 's', amount: '10000000', proof: [], destination: 'alice.testnet', attemptId: 'x' })), [CAMP, COMMIT]);
    // "Signing you in" lasts only until the receipt route loads: delay that module and catch the frame.
    await p.route(/receipt\/\+page\.svelte/, async (r) => { await new Promise((ok) => setTimeout(ok, 16000)); await r.continue(); });
    await p.goto(base + `/auth/google#id_token=h.p.s&state=${encodeURIComponent(`${CAMP}/${COMMIT}/x`)}`, { waitUntil: 'commit' });
    await p.getByText('Signing In').waitFor({ timeout: 15000 }); return {};
  },
  'auth-cancelled-back': async (p, ctx) => {
    await ctx.addInitScript(([c, k]) => sessionStorage.setItem('zarf-near:attempt', JSON.stringify({ campaign: c, commitment: k, salt: 's', amount: '10000000', proof: [], destination: 'alice.testnet', attemptId: 'x' })), [CAMP, COMMIT]);
    await p.goto(base + '/auth/google#error=access_denied'); await p.waitForSelector('h1'); return {};
  },
  'auth-error': async (p, ctx) => {
    await ctx.addInitScript(([c, k]) => sessionStorage.setItem('zarf-near:attempt', JSON.stringify({ campaign: c, commitment: k, salt: 's', amount: '10000000', proof: [], destination: 'alice.testnet', attemptId: 'x' })), [CAMP, COMMIT]);
    await p.goto(base + '/auth/google#error=server_error'); await p.waitForSelector('h1'); return {};
  },
  'auth-mismatch': async (p, ctx) => {
    await ctx.addInitScript(([c, k]) => sessionStorage.setItem('zarf-near:attempt', JSON.stringify({ campaign: c, commitment: k, salt: 's', amount: '10000000', proof: [], destination: 'alice.testnet', attemptId: 'x' })), [CAMP, COMMIT]);
    await p.goto(base + '/auth/google#id_token=h.p.s&state=other'); await p.waitForSelector('h1'); return {};
  },
  'receipt-checking': (p) => nearClaim(p, { verifierHang: true }),
  'receipt-sending': (p) => nearClaim(p, { relayer: 'hang' }),
  'receipt-implicit': (p) => nearClaim(p, { dest: IMPLICIT, ack: true }),
  'receipt-reverted': (p) => nearClaim(p, { relayer: 'reverted' }),
  // Virtual time on the receipt: the 60 s settle watch runs out at once, then wait for the card itself (critic r3 coverage).
  'receipt-unsettled': async (p, ctx) => { await virtualClock(ctx); const o = await nearClaim(p, { relayer: 'submitted', rpc: { claimStateAfterFirst: 'pending' }, wait: 300 }); await p.getByRole('heading', { name: 'Still Settling' }).waitFor({ timeout: 30000 }); await p.waitForTimeout(300); return o; },
  'receipt-wrong-account': (p) => nearClaim(p, { verifierError: 'COMMITMENT_MISMATCH' }),
  'receipt-pending-elsewhere': (p) => nearClaim(p, { verifierError: 'E123_CLAIM_PENDING' }),
  'receipt-failed-final': (p) => nearClaim(p, { verifierError: 'E105_ALREADY_CLAIMED' }),
  'receipt-expired': (p) => nearClaim(p, { verifierError: 'EXPIRED' }),
  'receipt-failed-unmapped': (p) => nearClaim(p, { verifierError: 'BAD_AUDIENCE' }),
  // B5: the receipt after a Face ID unlock. A WebAuthn stub returns a fixed PRF output; the claim goes to the account
  // that output derives (passkey.ts: HKDF-SHA256, zero salt, the v1 info), then the stored receipt is marked passkey.
  'receipt-faceid-unlocked': async (p) => {
    const { subtle } = require('node:crypto').webcrypto;
    const ikm = await subtle.importKey('raw', new Uint8Array(32).fill(7), 'HKDF', false, ['deriveBits']);
    const seed = new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('zarf-near passkey ed25519 seed v1') }, ikm, 256));
    const pkcs8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...seed]);
    const jwk = await subtle.exportKey('jwk', await subtle.importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign']));
    const id = Buffer.from(jwk.x, 'base64url').toString('hex');
    await p.addInitScript(() => {
      navigator.credentials.get = async () => ({ getClientExtensionResults: () => ({ prf: { results: { first: new Uint8Array(32).fill(7) } } }) });
    });
    await nearClaim(p, { dest: id, ack: true });
    await p.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('zarf-near:receipt:')) localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k)), passkey: true })); });
    await p.unrouteAll(); await rpc(p, { claimState: 'claimed' }); await p.reload(); await p.waitForSelector('h1'); await p.waitForTimeout(800);
    await p.getByRole('button', { name: /Face ID/ }).click(); await p.getByRole('button', { name: 'Download Key' }).waitFor({ timeout: 10000 }); await p.waitForTimeout(300);
    return { full: true };
  },
  'receipt-reload': async (p) => { await nearClaim(p); await p.unrouteAll(); await rpc(p, { claimState: 'claimed' }); await p.reload(); await p.waitForSelector('h1'); await p.waitForTimeout(800); return { full: true }; },
  // T-004: Back after "Arrived" lands on the claim URL without its secret part; the remembered receipt shows.
  'claim-back-arrived': async (p) => { await nearClaim(p); await p.unrouteAll(); await rpc(p, { claimState: 'claimed' }); await p.goBack(); await p.waitForSelector('h1'); await p.waitForTimeout(800); console.log('claim-back-arrived url', new URL(p.url()).pathname); return { full: true }; },
  // T-004: refresh while the claim runs. Chrome asks only after a tap on the page (sticky activation), so tap first.
  'receipt-refresh-mid-claim': async (p) => {
    await nearClaim(p, { verifierHang: true }); await p.mouse.click(5, 300);
    let asked = 'none'; p.once('dialog', (d) => { asked = d.type(); d.accept(); });
    await p.reload(); await p.waitForSelector('h1'); await p.waitForTimeout(800); console.log('receipt-refresh-mid-claim dialog', asked); return { full: true };
  },
  'term-claimed-paid': async (p) => { await nearClaim(p); await p.unrouteAll(); await rpc(p, { claimState: 'claimed' }); await p.goto(base + LINK); await p.waitForSelector('h1'); await p.waitForTimeout(500); return {}; },
  'receipt-quote-expired': async (p, ctx) => { await lateClock(ctx); return chainClaim(p, { wait: 1500 }); },
  'receipt-chain-failed': (p) => chainClaim(p, { final: 'FAILED' }),
  'receipt-chain-stalled': async (p, ctx) => { await fastTimers(ctx); const o = await chainClaim(p, { final: 'PROCESSING', wait: 500 }); await p.getByRole('heading', { name: 'Still on Its Way to Base' }).waitFor({ timeout: 90000 }); await p.waitForTimeout(300); return o; },
  // A status we do not treat as final: still processing, polling goes on (round 3 A2).
  'receipt-chain-incomplete': (p) => chainClaim(p, { final: 'INCOMPLETE_DEPOSIT' }),
  // FAILED, Details open: the deposit address the sender gives NEAR Intents support, copyable; no refund promised.
  'receipt-chain-failed-detail': async (p) => { const o = await chainClaim(p, { final: 'FAILED' }); await p.getByText('Details', { exact: true }).click(); await p.waitForTimeout(300); return o; },
  'term-claimed-chain-failed-detail': async (p) => { await chainClaim(p, { final: 'FAILED', wait: 2500 }); await p.unrouteAll(); await rpc(p, { network: 'mainnet', claimState: 'claimed', camp: { sender: 'sender.near' } }); await oneclick(p, 'FAILED'); await p.goto(base + LINK); await p.getByText('Bridge last checked').waitFor(); await p.getByText('Details', { exact: true }).click(); await p.waitForTimeout(300); return { full: true }; },
  'receipt-chain-refunded-detail': async (p) => { const o = await chainClaim(p, { final: 'REFUNDED' }); await p.getByText('Details', { exact: true }).click(); await p.waitForTimeout(300); return o; },
  // A cross-chain claim reopened in a new tab while the bridge has not reported: "Claimed on NEAR", never "Paid out".
  'term-claimed-chain-transit': async (p) => { await chainClaim(p, { final: 'PROCESSING', wait: 1500 }); const s = await p.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('zarf-near:receipt:'))); const pg = await p.context().newPage(); await pg.addInitScript((s) => s.forEach(([k, v]) => localStorage.setItem(k, v)), s); await rpc(pg, { network: 'mainnet', claimState: 'claimed', camp: { sender: 'sender.near' } }); await oneclick(pg, 'PROCESSING'); await pg.goto(base + LINK); await pg.waitForSelector('h1'); await pg.getByText('Bridge last checked').waitFor(); await pg.waitForTimeout(300); return { page: pg }; },
  // The same, but the bridge has paid since the first tab closed: the reopened link learns it (round 3 A1).
  'term-claimed-chain-later-paid': async (p) => { await chainClaim(p, { final: 'PROCESSING', wait: 1500 }); await p.unrouteAll(); await rpc(p, { network: 'mainnet', claimState: 'claimed', camp: { sender: 'sender.near' } }); await oneclick(p, 'SUCCESS'); await p.evaluate(() => sessionStorage.clear()); await p.goto(base + LINK); await p.getByText('Paid out', { exact: false }).waitFor(); await p.waitForTimeout(300); return {}; },
  'term-claimed-chain-later-refunded': async (p) => { await chainClaim(p, { final: 'FAILED', wait: 2500 }); await p.unrouteAll(); await rpc(p, { network: 'mainnet', claimState: 'claimed', camp: { sender: 'sender.near' } }); await oneclick(p, 'REFUNDED'); await p.goto(base + LINK); await p.getByText('Returned to the sender', { exact: false }).waitFor(); await p.waitForTimeout(300); return {}; },
  'term-claimed-chain-failed': async (p) => { await chainClaim(p, { final: 'FAILED', wait: 2500 }); await p.unrouteAll(); await rpc(p, { network: 'mainnet', claimState: 'claimed', camp: { sender: 'sender.near' } }); await oneclick(p, 'FAILED'); await p.goto(base + LINK); await p.waitForSelector('h1'); await p.waitForTimeout(500); return {}; },
  'term-claimed-chain-paid': async (p) => { await chainClaim(p, { final: 'SUCCESS', wait: 2500 }); await p.unrouteAll(); await rpc(p, { network: 'mainnet', claimState: 'claimed', camp: { sender: 'sender.near' } }); await oneclick(p, 'SUCCESS'); await p.goto(base + LINK); await p.waitForSelector('h1'); await p.waitForTimeout(500); return {}; },
  // A remembered receipt the chain does not confirm (another contract, a reset): never shown.
  'receipt-reload-unconfirmed': async (p) => { await nearClaim(p); await p.unrouteAll(); await rpc(p, { claimState: 'unclaimed' }); await p.reload(); await p.waitForSelector('h1'); await p.waitForTimeout(800); return {}; },
  'receipt-chain-resumed': async (p) => { await chainClaim(p, { final: 'PROCESSING', wait: 2000 }); await p.reload(); await p.waitForSelector('h1'); await p.waitForTimeout(1500); return { full: true }; },
  'receipt-chain-checking': (p) => chainClaim(p, { verifierHang: true, wait: 1500 }),
  'receipt-chain-notclaimed': (p) => chainClaim(p, { verifierError: 'COMMITMENT_MISMATCH', wait: 1500 }),
  'receipt-empty': async (p) => { await rpc(p); await p.goto(base + `/claim/${CAMP}/${COMMIT}/receipt`); await p.waitForSelector('h1'); return {}; },
  'auth-cancelled': async (p) => { await p.goto(base + '/auth/google#error=access_denied'); await p.waitForSelector('h1'); return {}; },
  'create-1': async (p) => { await rpc(p); await p.goto(base + '/create'); await p.waitForTimeout(4500); return { full: true }; },
  'create-1-filled': async (p) => { await rpc(p); await p.goto(base + '/create'); await p.waitForSelector('[aria-label="Recipient 1 email"]'); await pasteList(p, CSV + '\nnot-an-email,3'); await p.waitForTimeout(500); return { full: true }; },
  'create-2': async (p) => { await rpc(p); await p.goto(base + '/create'); await p.waitForSelector('[aria-label="Recipient 1 email"]'); await pasteList(p, CSV); await p.getByRole('button', { name: 'Continue' }).click(); await p.waitForTimeout(500); return { full: true }; },
  'create-3': async (p) => { await rpc(p); await p.goto(base + '/create'); await p.waitForSelector('[aria-label="Recipient 1 email"]'); await pasteList(p, CSV); await p.getByRole('button', { name: 'Continue' }).click(); await p.getByRole('button', { name: 'Continue' }).click(); await p.waitForTimeout(800); return { full: true }; },
  'create-3-wallet': async (p, ctx) => { await wallet(ctx); await rpc(p); await p.goto(base + '/create'); await p.waitForSelector('[aria-label="Recipient 1 email"]'); await p.waitForTimeout(1500); await pasteList(p, CSV); await p.getByRole('button', { name: 'Continue' }).click(); await p.getByRole('button', { name: 'Continue' }).click(); await p.waitForTimeout(800); return { full: true }; },
  'create-4': async (p, ctx) => { await wallet(ctx); await rpc(p); await p.goto(base + '/create'); await p.waitForSelector('[aria-label="Recipient 1 email"]'); await p.waitForTimeout(1500); await pasteList(p, CSV); await p.getByRole('button', { name: 'Continue' }).click(); await p.getByRole('button', { name: 'Continue' }).click(); await p.getByRole('button', { name: 'Continue' }).click(); await p.waitForTimeout(800); return { full: true }; },
  'create-done': async (p, ctx) => { await funding(ctx, { txHash: 'H', campaignId: '12' }); await rpc(p, { claimBy: { ['0'.repeat(64)]: 'claimed', ['2'.repeat(64)]: 'pending' } }); await p.goto(base + '/create'); await p.waitForTimeout(4500); return { full: true }; },
  'create-done-detail': async (p, ctx) => { await funding(ctx, { txHash: 'H', campaignId: '12' }); await rpc(p); await p.goto(base + '/create'); await p.waitForTimeout(4500); await p.getByRole('button', { name: /Keep each link private/ }).focus(); await p.waitForTimeout(300); return { full: true }; },
  'create-done-copied': async (p, ctx) => { await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base }); await funding(ctx, { txHash: 'H', campaignId: '12' }); await rpc(p); await p.goto(base + '/create'); await p.waitForTimeout(4500); await p.getByRole('button', { name: 'Copy Message' }).nth(1).click(); await p.waitForTimeout(300); return { full: true }; },
  'create-done-long': async (p, ctx) => {
    await ctx.addInitScript((d) => sessionStorage.setItem('zarf-near:create-funding', JSON.stringify({ txHash: 'H', sender: 'sender.testnet', deadline: '2026-12-01T12:00', campaignId: '12', draft: d })),
      { merkleRoot: ROOT, total: String(501 * 1000000), recipients: Array.from({ length: 501 }, (_, i) => ({ email: `person${i}@gmail.com`, amount: '1000000', salt: 'ab'.repeat(32), commitment: i.toString(16).padStart(64, '0'), proof: Array(9).fill('cd'.repeat(32)) })) });
    await rpc(p); await p.goto(base + '/create'); await p.waitForTimeout(4500); return {};
  },
  // Send UX round (r5): every new or changed sender state.
  'create-1-ok': async (p) => { await rpc(p); await p.goto(base + '/create'); await p.waitForSelector('[aria-label="Recipient 1 email"]'); await p.waitForTimeout(1500); await pasteList(p, CSV); await p.waitForTimeout(400); return { full: true }; },
  'create-1-dup': async (p) => { await rpc(p); await p.goto(base + '/create'); await p.waitForSelector('[aria-label="Recipient 1 email"]'); await p.waitForTimeout(1500); await pasteList(p, CSV + '\nAlice@gmail.com,5'); await p.waitForTimeout(400); return { full: true }; },
  'create-1-email': async (p) => { await rpc(p); await p.goto(base + '/create'); await p.waitForSelector('[aria-label="Recipient 1 email"]'); await p.waitForTimeout(1500); return { full: true }; },
  'create-2-date': async (p) => { await rpc(p); await toStep(p, 1); await pickDate(p); await p.waitForTimeout(300); return { full: true }; },
  'create-2-30': async (p) => { await rpc(p); await toStep(p, 1); await p.getByRole('radio', { name: /^30 days$/i }).click(); await p.waitForTimeout(300); return { full: true }; },
  'create-3-balance-error': async (p, ctx) => { await wallet(ctx); await rpc(p, { fail: 'ft_balance_of' }); await toStep(p, 2); await p.waitForTimeout(800); return { full: true }; },
  'create-4-deposit': async (p, ctx) => { await wallet(ctx); await rpc(p, { prepay: '0' }); await toStep4(p); return { full: true }; },
  'create-4-saved': async (p, ctx) => { await wallet(ctx); await rpc(p); await toStep4(p); await saveBackup(p); await p.waitForTimeout(300); return { full: true }; },
  'create-4-terms': async (p, ctx) => { await wallet(ctx); await rpc(p, { prepay: '0' }); await toStep4(p); await p.getByRole('button', { name: /Who sees the emails/ }).focus(); await p.waitForTimeout(300); return { full: true }; },
  'create-send-chain': async (p, ctx) => { await wallet(ctx); await walletPopup(ctx, 'ok'); await rpc(p, { prepay: '0' }); await toStep4(p); await ackBackup(p); await p.getByRole('button', { name: SEND }).click(); await p.waitForTimeout(2500); return { full: true }; },
  'create-send-lost': async (p, ctx) => { await fastCreate(ctx); await wallet(ctx); await funding(ctx, { txHash: TX }); await rpc(p); await p.goto(base + '/create'); await p.getByText('Checking with NEAR').waitFor({ timeout: 20000 }); await p.waitForTimeout(300); return { full: true }; },
  'create-done-terms': async (p, ctx) => { await funding(ctx, { txHash: 'H', campaignId: '12' }); await rpc(p, { claimBy: { ['0'.repeat(64)]: 'claimed' } }); await p.goto(base + '/create'); await p.waitForTimeout(4500); await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await p.waitForTimeout(300); return {}; },
  // Second pass (r6): NEAR have vs need, the sender's name, long emails.
  'create-3-near-short': async (p, ctx) => { await wallet(ctx); await rpc(p, { near: '10000000000000000000000', prepay: '0' }); await toStep(p, 2); await p.waitForTimeout(800); return { full: true }; },
  'create-3-near-error': async (p, ctx) => { await wallet(ctx); await rpc(p, { nearDown: true }); await toStep(p, 2); await p.waitForTimeout(800); return { full: true }; },
  'create-4-name': async (p, ctx) => { await wallet(ctx); await rpc(p, { prepay: '0' }); await toStep4(p); await p.getByPlaceholder('Your name').fill('Alex'); await p.waitForTimeout(300); return { full: true }; },
  'create-4-long-email': async (p, ctx) => { await wallet(ctx); await rpc(p, { prepay: '0' }); await toStep(p, 3, CSV + '\nfirstname.middlename.lastname.department@verylongcompanyname-example.com,1'); return { full: true }; },
  'create-done-name': async (p, ctx) => { await ctx.addInitScript(() => localStorage.setItem('zarf-near:sender-name', 'Alex')); await funding(ctx, { txHash: 'H', campaignId: '12' }); await rpc(p, { claimBy: { ['0'.repeat(64)]: 'claimed' } }); await p.goto(base + '/create'); await p.waitForTimeout(4500); return { full: true }; },
  'create-setup-error': async (p) => { await rpc(p, { rpcDown: true }); await p.goto(base + '/create'); await p.waitForTimeout(4500); return {}; },
  'create-deadline-early': async (p) => { await rpc(p); await p.goto(base + '/create'); await p.waitForSelector('[aria-label="Recipient 1 email"]'); await pasteList(p, CSV); await p.getByRole('button', { name: 'Continue' }).click(); await pickDate(p); await p.fill('#deadline', '2026-11-12T00:00'); await p.waitForTimeout(400); return { full: true }; },
  // T-019 funding from another chain. Pay With → Base, the refund address and its last 6 characters.
  'fund-pick': async (p, ctx) => { await fundStart(p, ctx); return { full: true }; },
  // Live: a dry EXACT_OUTPUT quote from the real 1Click mainnet API (no stub), checked against 1Click's signature.
  'fund-dry-live': async (p, ctx) => {
    // The page route runs before the context's chaindefuser block; only a dry quote may reach the real API.
    await p.route(/1click\.chaindefuser\.com\/v0\/quote/, (r) => (JSON.parse(r.request().postData() ?? '{}').dry === true ? r.continue() : r.abort()));
    await fundStart(p, ctx); await p.getByRole('button', { name: 'Get Quote' }).click(); await p.waitForSelector('[data-quote]', { timeout: 20000 }); await p.waitForTimeout(300); return { full: true }; },
  'fund-refused': async (p, ctx) => { await oneclick(p, 'PENDING_DEPOSIT', { dry: 'refuse' }); await fundStart(p, ctx); await p.getByRole('button', { name: 'Get Quote' }).click(); await p.waitForTimeout(1200); return { full: true }; },
  ...Object.fromEntries(['PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'PROCESSING', 'SUCCESS', 'INCOMPLETE_DEPOSIT', 'REFUNDED', 'FAILED'].map((st) => [
    `fund-${st.toLowerCase().replace(/_/g, '-')}`,
    // A deposit address this browser already has (as after a mainnet quote or a reload); 1Click's status stubbed.
    async (p, ctx) => {
      await ctx.addInitScript((f) => { try { localStorage.setItem('zarf-near:funding:zarf-near-1112.testnet/sender.testnet', JSON.stringify(f)); } catch {} },
        { chainKey: 'base', depositAddress: '0x76b4c56085ED136a8744D52bE956396624a730E8', refundTo: EVM, amountIn: '27791520', amountInFormatted: '27.79152', amountOut: '27500000', deadline: new Date(Date.now() + 3600e3).toISOString() });
      await oneclick(p, st); await toShort(p, ctx); await p.waitForTimeout(1500); await p.locator('[data-fund]').scrollIntoViewIfNeeded(); return { full: true };
    },
  ])),
  'create-3-short': async (p, ctx) => { await wallet(ctx); await rpc(p, { balance: '10000000' }); await p.goto(base + '/create'); await p.waitForSelector('[aria-label="Recipient 1 email"]'); await p.waitForTimeout(1500); await pasteList(p, CSV); await p.getByRole('button', { name: 'Continue' }).click(); await p.getByRole('button', { name: 'Continue' }).click(); await p.waitForTimeout(1000); return { full: true }; },
  'create-wallet-error': async (p, ctx) => { await walletPopup(ctx, 'fail'); await rpc(p); await p.goto(base + '/create'); await p.waitForSelector('[aria-label="Recipient 1 email"]'); await p.waitForTimeout(1500); await pasteList(p, CSV); await p.getByRole('button', { name: 'Continue' }).click(); await p.getByRole('button', { name: 'Continue' }).click(); await p.getByRole('button', { name: 'Connect Wallet' }).click(); await p.waitForTimeout(2500); return { full: true }; },
  'create-4-ready': async (p, ctx) => { await wallet(ctx); await rpc(p, { prepay: '0' }); await toStep4(p); await ackBackup(p); await p.waitForTimeout(400); return { full: true }; },
  'create-send-waiting': async (p, ctx) => { await wallet(ctx); await walletPopup(ctx, 'hang'); await rpc(p, { prepay: '0' }); await toStep4(p); await ackBackup(p); await p.getByRole('button', { name: SEND }).click(); await p.waitForTimeout(2000); return { full: true }; },
  'create-send-notsent': async (p, ctx) => {
    await wallet(ctx); await walletPopup(ctx, 'hang');
    await ctx.addInitScript(() => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === 'zarf-near:create-funding') throw new Error('denied'); return set.call(this, k, v); }; });
    await rpc(p, { prepay: '0' }); await toStep4(p); await ackBackup(p); await p.getByRole('button', { name: SEND }).click(); await p.waitForTimeout(1500); return { full: true };
  },
  'create-send-checking': async (p, ctx) => { await wallet(ctx); await funding(ctx, { txHash: TX }); await rpc(p); await p.goto(base + '/create'); await p.waitForTimeout(5000); return { full: true }; },
  'create-send-unclear': async (p, ctx) => { await wallet(ctx); await funding(ctx, { txHash: TX }); await rpc(p, { tx: receipts([TOKEN]) }); await p.goto(base + '/create'); await p.waitForTimeout(5000); return { full: true }; },
  'create-send-refunded': async (p, ctx) => { await wallet(ctx); await funding(ctx, { txHash: TX }); await rpc(p, { tx: receipts([TOKEN], [CONTRACT, { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E119_INVALID_DEADLINE' } } } } } }]) }); await p.goto(base + '/create'); await p.waitForTimeout(5000); return { full: true }; },
  'create-send-settling': async (p, ctx) => { await wallet(ctx); await funding(ctx, { txHash: TX, uncertain: true }); await rpc(p, { tx: receipts([TOKEN], [CONTRACT, { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E128_INSUFFICIENT_STORAGE' } } } } } }]) }); await p.goto(base + '/create'); await p.waitForTimeout(5000); return { full: true }; },
  'create-send-mismatch': async (p, ctx) => { await wallet(ctx); await funding(ctx, { txHash: null }); await rpc(p, { byRoot: '5', campaigns: { 5: cview({ merkle_root: 'ef'.repeat(32) }) } }); await p.goto(base + '/create'); await p.waitForTimeout(5000); return { full: true }; },
  'create-send-notlanded': async (p, ctx) => { await wallet(ctx); await funding(ctx, { txHash: null }); await rpc(p); await p.goto(base + '/create'); await p.waitForTimeout(5000); return { full: true }; },
  'create-send-wrong-account': async (p, ctx) => { await wallet(ctx); await funding(ctx, { txHash: null, sender: 'other.testnet' }); await rpc(p); await p.goto(base + '/create'); await p.waitForTimeout(5000); return { full: true }; },
  'create-send-created': async (p, ctx) => { await wallet(ctx); await funding(ctx, { txHash: TX }); await rpc(p, { tx: receipts([TOKEN], [CONTRACT, { logs: [ev('campaign_created', { campaign_id: 14, merkle_root: ROOT, amount: '37500000' })] }]) }); await p.goto(base + '/create'); await p.waitForTimeout(5000); return { full: true }; },
  // Wait for the warning itself, not a fixed time (critic r3: light-1280 caught the frame before it).
  'create-other-tab': async (p, ctx) => { await ctx.addInitScript((m) => localStorage.setItem('zarf-near:unresolved', JSON.stringify({ ...m, at: Date.now() })), { root: ROOT, sender: 'sender.testnet', total: '37500000' }); await rpc(p); await p.goto(base + '/create'); await p.getByText('Another tab has a send').waitFor({ timeout: 20000 }); await p.waitForTimeout(500); return { full: true }; },
  'campaigns-connect': async (p) => { await rpc(p); await p.goto(base + '/campaigns'); await p.waitForTimeout(4000); return { full: true }; },
  'campaigns-list': async (p, ctx) => { await wallet(ctx); await rpc(p, { campaigns: { 12: cview({ deadline_ns: PAST }), 13: cview({ amount: '5000000', balance: '5000000', storage_reserved: '2310000000000000000000' }) } }); await p.goto(base + '/campaigns'); await p.getByText('0 of 5 claimed').waitFor({ timeout: 20000 }); await p.waitForTimeout(300); return { full: true }; },
  'campaigns-detail': async (p, ctx) => { await wallet(ctx); await rpc(p, { campaigns: { 12: cview({ deadline_ns: PAST }), 13: cview({ amount: '5000000', balance: '5000000', storage_reserved: '2310000000000000000000' }) } }); await p.goto(base + '/campaigns'); await p.waitForTimeout(4000); await p.getByText('Details', { exact: true }).first().click(); await p.waitForTimeout(300); return { full: true }; },
  'campaigns-balance-tip': async (p, ctx) => { await wallet(ctx); await rpc(p, { campaigns: { 13: cview({ amount: '5000000', balance: '5000000', storage_reserved: '2310000000000000000000' }) } }); await p.goto(base + '/campaigns'); await p.getByText('0 of 5 claimed').waitFor({ timeout: 20000 }); await p.getByRole('button', { name: /What is my Zarf balance/ }).focus(); await p.waitForTimeout(400); return { full: true }; },
  'campaigns-setup-error': async (p) => { await rpc(p, { rpcDown: true }); await p.goto(base + '/campaigns'); await p.waitForTimeout(4000); return {}; },
  'campaigns-loading': async (p, ctx) => { await wallet(ctx); await rpc(p, { hang: 'campaigns_of' }); await p.goto(base + '/campaigns'); await p.waitForTimeout(4000); return {}; },
  'campaigns-load-error': async (p, ctx) => { await wallet(ctx); await rpc(p, { fail: 'campaigns_of' }); await p.goto(base + '/campaigns'); await p.waitForTimeout(4000); return {}; },
  'campaigns-empty': async (p, ctx) => { await wallet(ctx); await rpc(p, { campaigns: {} }); await p.goto(base + '/campaigns'); await p.waitForTimeout(4000); return {}; },
  'campaigns-wallet-error': async (p, ctx) => { await walletPopup(ctx, 'fail'); await rpc(p); await p.goto(base + '/campaigns'); await p.waitForTimeout(4000); await p.getByRole('button', { name: 'Connect Wallet' }).click(); await p.waitForTimeout(2500); return {}; },
  ...Object.fromEntries([
    ['busy', 'hang', null],
    ['reclaimed', 'ok', receipts([CONTRACT, { logs: [ev('reclaimed', { campaign_id: 12, amount: '27500000' })] }])],
    ['reverted', 'ok', receipts([CONTRACT, { logs: [ev('reclaim_reverted', { campaign_id: 12 })] }])],
    ['failed', 'ok', receipts([CONTRACT, { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E118_NOTHING_TO_RECLAIM' } } } } } }])],
    ['released', 'ok', receipts([CONTRACT])],
    ['send-failed', 'fail', null],
  ].map(([k, mode, tx]) => [`campaigns-reclaim-${k}`, async (p, ctx) => {
    await wallet(ctx); await walletPopup(ctx, mode); await rpc(p, { campaigns: { 12: cview({ deadline_ns: PAST }), 13: cview({ amount: '5000000', balance: '5000000', storage_reserved: '2310000000000000000000' }) }, tx }); await p.goto(base + '/campaigns'); await p.waitForTimeout(4000);
    await p.getByRole('button', { name: /^Take back/i }).first().click(); await p.waitForTimeout(2500); return { full: true };
  }])),
  ...Object.fromEntries([['done', receipts([CONTRACT])], ['failed', receipts([CONTRACT, { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E107_UNAUTHORIZED' } } } } } }])]].map(([k, tx]) => [`campaigns-withdraw-${k}`, async (p, ctx) => {
    await wallet(ctx); await walletPopup(ctx, 'ok'); await rpc(p, { campaigns: { 12: cview({ deadline_ns: PAST }), 13: cview({ amount: '5000000', balance: '5000000', storage_reserved: '2310000000000000000000' }) }, tx }); await p.goto(base + '/campaigns'); await p.waitForTimeout(4000);
    await p.getByRole('button', { name: 'Withdraw' }).click(); await p.waitForTimeout(2500); return { full: true };
  }])),
  privacy: async (p) => { await p.goto(base + '/privacy'); await p.waitForSelector('h1'); return { full: true }; },
  error500: async (p) => { await p.route(/routes\/privacy\/\+page\.svelte/, (r) => r.abort()); await p.goto(base + '/privacy'); await p.waitForTimeout(2500); return {}; },
  // These two need a server started with PUBLIC_IMPLICIT_ACCOUNTS=on (PORT=… for a second one).
  'implicit-start': async (p) => { await rpc(p); await p.goto(base + LINK); await p.waitForSelector('#dest'); await p.getByText(/^(New Account|Face ID)$/).click(); await p.waitForTimeout(400); return { full: true }; },
  'implicit-key': async (p) => { await rpc(p); await p.goto(base + LINK); await p.waitForSelector('#dest'); await p.getByText(/^(New Account|Face ID)$/).click(); await p.getByRole('button', { name: 'Create NEAR Account' }).click(); await p.waitForTimeout(600); await p.getByRole('button', { name: 'Download Key' }).click(); await p.waitForTimeout(400); return { full: true }; },
  notfound: async (p) => { await p.goto(base + '/nope'); await p.waitForSelector('h1'); return {}; },
};

(async () => {
  const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  for (const [name, fn] of Object.entries(S)) {
    if (filter && !new RegExp(filter).test(name)) continue;
    if (!filter && name.startsWith('implicit-')) continue; // needs the flagged server
    for (const theme of (process.env.THEMES || 'dark,light').split(',')) for (const [w, h] of [[390, 844], [1280, 800]].filter(([w]) => (process.env.WIDTHS || '390,1280').split(',').includes(String(w)))) {
      const ctx = await b.newContext({ viewport: { width: w, height: h }, javaScriptEnabled: name !== 'boot', colorScheme: theme });
      await ctx.addInitScript((t) => localStorage.setItem('zarf_theme', t), theme);
      await ctx.route(/chaindefuser/, (r) => r.abort()); // nothing reaches the real bridge: a page that needs it stubs it itself
      const p = await ctx.newPage();
      const errs = []; p.on('pageerror', (e) => errs.push(String(e))); p.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 140)));
      try {
        const o = (await fn(p, ctx)) || {};
        await (o.page ?? p).evaluate(() => window.scrollTo(0, 0)); // a sticky navbar otherwise lands mid-page in full shots
        await (o.page ?? p).screenshot({ path: `${out}/${name}-${theme}-${w}.png`, fullPage: !!o.full });
        if (errs.length && theme === 'dark' && w === 390) console.log(name, 'console:', errs.slice(0, 3).join(' | '));
      } catch (e) { console.log(name, theme, w, 'FAIL', String(e).split('\n')[0]); }
      await ctx.close();
    }
  }
  await b.close();
})();
