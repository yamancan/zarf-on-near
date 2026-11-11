import { describe, expect, it } from 'vitest';
import vectors from '../../../../spec/vectors.json';
import { parseLinkFragment } from '../claim';
import { buildDraft, claimLink, commitment, mailtoHref, messageText, newSalt, readRecoveryFile, recoveryFile } from './campaign';
import {
  fundsShort,
  campaignIdFrom, checkCreation, failedWith, fundCampaign, fundingTxs, LookupPending, minDeadlineMs, NotCreated, OutcomeUnclear, ownerKeySlack,
  NotSent, attachedGas, nearNeeded, spendableNear, prepayShortfall, resolveByRoot, SendUncertain, settleAfterUncertain, mayCreate, readMarker, MARKER_TTL_MS, type FundDeps, type Outcome,
} from './funding';
import { formatAmount, parseAmount, parseRecipients } from './recipients';

const { campaigns } = vectors;
// CSV as a sender would paste it: USDC amounts, Windows line endings, the vector emails as given.
const csvOf = (rs: typeof campaigns.main.recipients) =>
  'email,amount\r\n' + rs.map((r) => `${r.email.replace(/[\r\n]+$/, '')},${formatAmount(BigInt(r.amount))}`).join('\r\n');
// The vector campaign repeats alice@example.com on purpose (the protocol allows it); the create app refuses a
// repeat, so CSV tests that need main's full u128 total rename that one row. Its leaf is not hashed here.
const uniqueMain = campaigns.main.recipients.map((r, i) => (i === 4 ? { ...r, email: 'alice2@example.com', canonical_email: 'alice2@example.com' } : r));
// Rows straight from the vectors (the tree is defined per leaf; CSV parsing is tested separately).
const rowsOf = (rs: typeof campaigns.main.recipients) => rs.map((r, i) => ({ line: i + 1, email: r.canonical_email, amount: BigInt(r.amount) }));
const saltsOf = (rs: { salt: string }[]) => {
  let i = 0;
  return () => rs[i++].salt;
};

describe('vectors are present', () => {
  it('has the campaigns and rejected emails', () => {
    expect(campaigns.main.recipients.length).toBeGreaterThanOrEqual(5);
    expect(vectors.rejected_emails.length).toBeGreaterThanOrEqual(5);
  });
});

describe('parseAmount / formatAmount (USDC, 6 decimals)', () => {
  it.each([['10', 10_000_000n], ['2.5', 2_500_000n], ['0.000001', 1n], ['1.000000', 1_000_000n]])('%s', (s, v) => {
    expect(parseAmount(s)).toBe(v);
    expect(parseAmount(formatAmount(v))).toBe(v);
  });
  it.each(['0', '0.0', '-1', '1e6', '1.0000001', '', 'abc', '1,5', (2n ** 128n).toString()])('rejects %j', (s) => {
    expect(() => parseAmount(s)).toThrow();
  });
});

describe('parseRecipients', () => {
  it('reads the vector campaign (canonical emails, amounts), skipping the header; total is exactly u128::MAX', () => {
    const { rows, rejected, total } = parseRecipients(csvOf(uniqueMain));
    expect(rejected).toEqual([]);
    expect(rows.map((r) => r.email)).toEqual(uniqueMain.map((r) => r.canonical_email));
    expect(rows.map((r) => r.amount.toString())).toEqual(uniqueMain.map((r) => r.amount));
    expect(total).toBe((1n << 128n) - 1n);
  });
  it('one more base unit on top of the vector campaign is refused', () => {
    const { rejected } = parseRecipients(`${csvOf(uniqueMain)}\r\nz@example.com,0.000001`);
    expect(rejected).toEqual([expect.objectContaining({ reason: expect.stringContaining('token maximum') })]);
  });
  it.each(vectors.rejected_emails)('rejects %j as non-ASCII with its line number', (e) => {
    const { rows, rejected } = parseRecipients(`ok@example.com,1\n${e},1`);
    expect(rows).toHaveLength(1);
    expect(rejected).toEqual([{ line: 2, raw: `${e},1`, reason: expect.stringContaining('ASCII') }]);
  });
  it.each([
    ['not-an-email,1', 'not an email address'],
    ['a+tag@gmail.com,1', 'Gmail +aliases'],
    ['a@example.com,0', 'above 0'],
    ['a@example.com,1.1234567', 'at most 6 decimals'],
    ['a@example.com', 'two columns'],
  ])('rejects %j with a reason', (line, reason) => {
    expect(parseRecipients(line).rejected[0].reason).toContain(reason);
  });
  it('refuses a row that would push the total past u128', () => {
    const max = formatAmount((1n << 128n) - 1n);
    const { rows, rejected } = parseRecipients(`a@example.com,${max}\nb@example.com,0.000001`);
    expect(rows).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ line: 2, reason: expect.stringContaining('token maximum') });
  });
  it.each([
    ['"alice@example.com",10', 'alice@example.com'],
    ['"Alice@Example.com","2.5"', 'alice@example.com'],
    ['  "bob@example.com" ; 1', 'bob@example.com'],
  ])('strips one pair of quotes per cell: %j', (line, email) => {
    const { rows, rejected } = parseRecipients(line);
    expect(rejected).toEqual([]);
    expect(rows[0].email).toBe(email);
  });
  it('a quoted amount parses', () => {
    expect(parseRecipients('a@example.com,"10"').rows[0].amount).toBe(10_000_000n);
  });
  it.each([
    ['<alice@example.com>,10', 'mailto: or <>'],
    ['mailto:alice@example.com,10', 'mailto: or <>'],
    ['"<alice@example.com>",10', 'mailto: or <>'],
    ['""alice@example.com"",10', 'not an email address'],
    ['alice@example,10', 'not an email address'],
    ['alice@exa_mple.com,10', 'not an email address'],
    ['Alice <alice@example.com>,10', 'ASCII'],
  ])('refuses wrapped or malformed address %j', (line, reason) => {
    const { rows, rejected } = parseRecipients(line);
    expect(rows).toEqual([]);
    expect(rejected[0].reason).toContain(reason);
  });
  it('strips one BOM at the start of the paste, but a BOM inside a cell is refused', () => {
    expect(parseRecipients('\uFEFFemail,amount\na@example.com,1').rows).toHaveLength(1);
    expect(parseRecipients('\uFEFFa@example.com,1').rows).toHaveLength(1);
    expect(parseRecipients('a@example.com,1\n\uFEFFb@example.com,1').rejected[0].reason).toContain('ASCII');
  });
  it('refuses a repeated email (after canonicalising) with the line it repeats, as Zarf does', () => {
    const { rows, rejected, total } = parseRecipients('email,amount\na@example.com,1\nb@example.com,2\n A@Example.com ;3');
    expect(rows.map((r) => r.email)).toEqual(['a@example.com', 'b@example.com']);
    expect(total).toBe(3_000_000n);
    expect(rejected).toEqual([{ line: 4, raw: ' A@Example.com ;3', reason: 'same email as line 2' }]);
  });
  it('the vector campaign, which repeats an email, is refused at the repeat', () => {
    const { rejected } = parseRecipients(csvOf(campaigns.main.recipients));
    expect(rejected).toEqual([expect.objectContaining({ line: 6, reason: 'same email as line 2' })]);
  });
});

describe('campaigns.main end to end', () => {
  it('rows -> salts -> root, proofs, and the ft_transfer_call for the full total', async () => {
    const c = campaigns.main;
    // main repeats an email, which the CSV path now refuses: everything after the parse is checked on its rows.
    const rows = rowsOf(c.recipients);
    const total = rows.reduce((t, r) => t + r.amount, 0n);
    const draft = await buildDraft(rows, saltsOf(c.recipients));
    expect(draft.merkleRoot).toBe(c.merkle_root);
    expect(draft.total).toBe(total.toString());
    const [transfer] = fundingTxs({
      sender: 'alice.testnet', contractId: 'zarf-near.testnet', tokenId: 'usdc.testnet', merkleRoot: draft.merkleRoot,
      deadlineNs: vectors.context.deadline_ns, leafCount: draft.recipients.length, total: draft.total, shortfall: 0n,
    });
    const args = transfer.actions[0].params.args as { amount: string; msg: string };
    expect(args.amount).toBe(((1n << 128n) - 1n).toString());
    expect(JSON.parse(args.msg)).toMatchObject({ merkle_root: c.merkle_root, leaf_count: c.recipients.length });
  });
});

describe('buildDraft reproduces the spec campaigns', () => {
  it.each(Object.entries(campaigns))('%s: commitments and merkle root', async (_, c) => {
    const draft = await buildDraft(rowsOf(c.recipients), saltsOf(c.recipients));
    expect(draft.recipients.map((r) => r.commitment)).toEqual(c.recipients.map((r) => r.commitment));
    expect(draft.merkleRoot).toBe(c.merkle_root);
  });
  it('draws a fresh 32-byte salt per row by default', async () => {
    const rows = [{ line: 1, email: 'a@example.com', amount: 1n }, { line: 2, email: 'a@example.com', amount: 1n }];
    const d = await buildDraft(rows);
    expect(d.recipients[0].salt).toMatch(/^[0-9a-f]{64}$/);
    expect(d.recipients[0].salt).not.toBe(d.recipients[1].salt);
    expect(d.recipients[0].commitment).not.toBe(d.recipients[1].commitment);
    expect(newSalt()).not.toBe(newSalt());
  });
  it('commitment canonicalises the email', async () => {
    const r = campaigns.main.recipients[1];
    expect(await commitment(r.salt, r.email)).toBe(r.commitment);
  });
});

describe('outputs', () => {
  it.each(Object.keys(vectors.links) as (keyof typeof vectors.links)[])('%s: claim links equal spec/vectors.json links', async (name) => {
    const c = campaigns[name];
    const draft = await buildDraft(rowsOf(c.recipients), saltsOf(c.recipients));
    expect(draft.recipients.map((r) => claimLink('https://claim.example', c.campaign_id, r))).toEqual(
      vectors.links[name].map((l) => `https://claim.example${l}`),
    );
  });
  it('the salt, amount and proof ride only in the fragment', () => {
    const r = { email: 'a@example.com', amount: '1', salt: 'ab'.repeat(32), commitment: 'cd'.repeat(32), proof: ['ef'.repeat(32)] };
    const link = new URL(claimLink('https://claim.example', '7', r));
    expect(link.pathname).toBe(`/claim/7/${r.commitment}`);
    expect(link.search).toBe('');
    expect(parseLinkFragment(link.hash)).toEqual({ salt: r.salt, amount: '1', proof: r.proof });
  });
  it('a 20-sibling link survives copy, the CSV export and the mailto body unchanged', () => {
    const proof = Array.from({ length: 20 }, (_, i) => i.toString(16).padStart(2, '0').repeat(32));
    const r = { email: 'a+b@example.com', amount: '340282366920938463463374607431768211455', salt: 'ab'.repeat(32), commitment: 'cd'.repeat(32), proof };
    const link = claimLink('https://claim.example', '18446744073709551615', r);
    const want = { salt: r.salt, amount: r.amount, proof };
    const csvLine = `${r.email},1,${link}`; // as the create page writes it
    const fromCsv = csvLine.split(',').slice(2).join(',');
    expect(fromCsv).toBe(link);
    const body = new URL(mailtoHref(r, messageText(r, link, { unit: 'USDC', testnet: false, deadlineMs: 0 }))).searchParams.get('body')!;
    const fromMail = body.split('\n').find((l) => l.startsWith('https://'))!;
    expect(fromMail).toBe(link);
    for (const l of [link, fromCsv, fromMail]) expect(parseLinkFragment(new URL(l).hash)).toEqual(want);
  });
  it.each([
    [true, 'test USDC', '10 test USDC for you'],
    [false, 'USDC', '10 USDC for you'],
  ])('the ready-made message (testnet %s) names its unit, and on testnet says the token has no value', (testnet, unit, subject) => {
    const r = { email: 'alice@gmail.com', amount: '10000000' };
    const m = messageText(r, 'https://claim.example/claim/1/ab#s=1', { unit, testnet, deadlineMs: Date.UTC(2026, 10, 19, 6, 20), timeZone: 'UTC' });
    expect(m.subject).toBe(subject);
    expect(m.body).toContain(`I sent you 10 ${unit} with Zarf.`);
    expect(m.body).toContain('sign in with Google as alice@gmail.com');
    expect(m.body).toContain('Claim it before 19 Nov 2026, 06:20 UTC.');
    expect(m.body.includes('practice money with no value')).toBe(testnet);
    // Never plain "USDC" as an amount on testnet: every figure carries the test unit.
    if (testnet) expect(m.body).not.toMatch(/\d (USDC)/);
    expect(m.body).not.toContain('What is Zarf?');
    const mail = new URL(mailtoHref(r, m));
    expect(mail.searchParams.get('subject')).toBe(subject);
    expect(mail.searchParams.get('body')).toBe(m.body);
  });
  it("with the sender's name it opens and signs with it, and points to what Zarf is; blank names stay neutral", () => {
    const r = { email: 'alice@gmail.com', amount: '10000000' };
    const o = { unit: 'test USDC', testnet: true, deadlineMs: 0, home: 'https://claim.example' };
    const m = messageText(r, 'https://claim.example/claim/1/ab', { ...o, from: '  Alex ' });
    expect(m.subject).toBe('10 test USDC for you, from Alex');
    expect(m.body.startsWith("Hi, it's Alex. I sent you 10 test USDC with Zarf.")).toBe(true);
    expect(m.body).toContain('What is Zarf? https://claim.example');
    expect(m.body.endsWith('\n\nAlex')).toBe(true);
    expect(messageText(r, 'x', { ...o, from: '   ' })).toEqual(messageText(r, 'x', o));
  });
  it('recovery file holds what rebuilding the links needs', async () => {
    const c = campaigns.single;
    const draft = await buildDraft(parseRecipients(csvOf(c.recipients)).rows, saltsOf(c.recipients));
    const f = JSON.parse(recoveryFile(draft, '123', { contractId: 'zarf-near.testnet', network: 'testnet', claimOrigin: 'https://claim.example' }));
    expect(f).toMatchObject({ kind: 'zarf-near-recovery-v1', contract_id: 'zarf-near.testnet', network: 'testnet', merkle_root: c.merkle_root, deadline_ns: '123' });
    expect(f.how_to_recover).toContain(`campaign_created event logged by zarf-near.testnet with merkle_root ${c.merkle_root}`);
    expect(f.how_to_recover).toContain('https://claim.example/claim/<campaign_id>/<commitment>#s=<salt>&a=<amount>&p=');
    expect(f.recipients[0]).toMatchObject({ salt: c.recipients[0].salt, commitment: c.recipients[0].commitment, proof: [] });
  });
});

describe('funding', () => {
  const costs = { ft_storage_deposit: '1250000000000000000000', claim_entry_cost: '500', per_claim_storage: '1250000000000000000500', campaign_bytes_cost: '3000' };
  it('deposits only the shortfall', () => {
    const need = 3000n + 5n * 1250000000000000000500n;
    expect(prepayShortfall(costs, 5, '0', 0n)).toBe(need);
    expect(prepayShortfall(costs, 5, '1000', 0n)).toBe(need - 1000n);
    expect(prepayShortfall(costs, 5, (10n ** 25n).toString(), 0n)).toBe(0n);
  });
  it('adds one owner key of slack: 32 B at the contract-reported byte price', () => {
    expect(ownerKeySlack('10000000000000000000')).toBe(320_000_000_000_000_000_000n); // 0.00032 NEAR at 10^19
    expect(prepayShortfall(costs, 5, '0', ownerKeySlack('7'))).toBe(3000n + 5n * 1250000000000000000500n + 224n);
  });
  it('refuses to guess when campaign_bytes_cost is missing', () => {
    const { campaign_bytes_cost: _, ...old } = costs;
    expect(() => prepayShortfall(old as typeof costs, 1, '0', 0n)).toThrow('campaign_bytes_cost');
  });
  const base = { sender: 'alice.testnet', contractId: 'zarf-near.testnet', tokenId: 'usdc.testnet', merkleRoot: campaigns.main.merkle_root, deadlineNs: '1794488400000000000', leafCount: 5, total: '12500043' };
  it('prepay_deposit then one ft_transfer_call with the spec msg', () => {
    const [prepay, transfer] = fundingTxs({ ...base, shortfall: 42n });
    expect(prepay).toMatchObject({ signerId: 'alice.testnet', receiverId: 'zarf-near.testnet', actions: [{ params: { methodName: 'prepay_deposit', deposit: '42' } }] });
    expect(transfer.receiverId).toBe('usdc.testnet');
    const p = transfer.actions[0].params;
    expect(p).toMatchObject({ methodName: 'ft_transfer_call', deposit: '1' });
    expect(p.args).toEqual({ receiver_id: 'zarf-near.testnet', amount: '12500043', msg: expect.any(String) });
    expect(JSON.parse((p.args as { msg: string }).msg)).toEqual({ merkle_root: base.merkleRoot, deadline_ns: base.deadlineNs, policy: 'owner', leaf_count: 5 });
  });
  it('skips prepay_deposit when the free pre-pay already covers it', () => {
    expect(fundingTxs({ ...base, shortfall: 0n }).map((t) => t.actions[0].params.methodName)).toEqual(['ft_transfer_call']);
  });
  it('reads campaign_id from the campaign_created event of our contract, only for our root and amount', () => {
    const want = { merkleRoot: 'ab'.repeat(32), total: '42' };
    const ev = (contract: string, id: unknown, event = 'campaign_created', data: object = { merkle_root: want.merkleRoot, amount: want.total }) => ({
      outcome: { executor_id: contract, logs: ['noise', `EVENT_JSON:${JSON.stringify({ standard: 'zarf-near', version: '1.0.0', event, data: [{ campaign_id: id, ...data }] })}`] },
    });
    const id = (...r: ReturnType<typeof ev>[]) => campaignIdFrom({ receipts_outcome: r }, 'zarf-near.testnet', want);
    expect(id(ev('usdc.testnet', '1'), ev('zarf-near.testnet', '9'))).toBe('9');
    expect(id(ev('evil.testnet', '9'))).toBeNull();
    expect(id(ev('zarf-near.testnet', '9', 'reclaimed'))).toBeNull();
    expect(id(ev('zarf-near.testnet', 'x'))).toBeNull();
    expect(id(ev('zarf-near.testnet', '9', 'campaign_created', { merkle_root: 'cd'.repeat(32), amount: '42' }))).toBeNull();
    expect(id(ev('zarf-near.testnet', '9', 'campaign_created', { merkle_root: want.merkleRoot, amount: '41' }))).toBeNull();
    expect(campaignIdFrom({}, 'zarf-near.testnet', want)).toBeNull();
  });
  it('detects E128 inside the refunded ft_on_transfer receipt', () => {
    const failed = { receipts_outcome: [{ outcome: { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E128_INSUFFICIENT_STORAGE' } } } } } } }] };
    expect(failedWith(failed, 'E128')).toBe(true);
    expect(failedWith({ receipts_outcome: [{ outcome: { logs: ['E128 in a log is not a failure'] } }] }, 'E128')).toBe(false);
  });
  it('earliest deadline = now + min_lifetime_ns', () => {
    expect(minDeadlineMs(1000, '600000000000')).toBe(601_000);
  });
});

describe('fundCampaign', () => {
  const created = (id: string): Outcome => ({ receipts_outcome: [{ outcome: { executor_id: 'zarf-near.testnet', logs: [`EVENT_JSON:${JSON.stringify({ standard: 'zarf-near', version: '1.0.0', event: 'campaign_created', data: [{ campaign_id: id, merkle_root: 'ab'.repeat(32), amount: '42' }] })}`] } }] });
  const panicked = (code: string): Outcome => ({ receipts_outcome: [{ outcome: { executor_id: 'zarf-near.testnet', status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${code}` } } } } } } }] });
  const costs = { ft_storage_deposit: '1', claim_entry_cost: '1', per_claim_storage: '10', campaign_bytes_cost: '100' };
  const p = { merkleRoot: 'ab'.repeat(32), deadlineNs: '1', leafCount: 3, total: '42' };
  // Each queued item is one lookup result: an Outcome, or an Error the lookup throws.
  const fake = (outcomes: (Outcome | Error)[], free = '0', o: { byRoot?: string | null; sendFails?: boolean } = {}) => {
    const sent: string[][] = [];
    const persisted: string[] = [];
    const events: string[] = [];
    const byRootCalls: [string, string][] = [];
    let costReads = 0;
    let lookups = 0;
    const d: FundDeps = {
      sender: 'alice.testnet', contractId: 'zarf-near.testnet', tokenId: 'usdc.testnet', storageByteCost: '2',
      costs: async () => (costReads++, costs),
      freePrepay: async () => free,
      send: async (txs) => {
        events.push('send');
        sent.push(txs.map((t) => t.actions[0].params.methodName));
        if (o.sendFails) throw new Error('User closed the window');
        return txs.map((_, i) => `h${sent.length}-${i}`);
      },
      beforeSend: () => events.push('persist-draft'),
      campaignByRoot: async (sender, root) => (byRootCalls.push([sender, root]), o.byRoot ?? null),
      campaign: async (id) => (id === o.byRoot ? { merkle_root: p.merkleRoot, amount: p.total, sender: 'alice.testnet' } : null),
      outcome: async () => {
        lookups++;
        const o = outcomes.shift() ?? new Error('rpc timeout');
        if (o instanceof Error) throw o;
        return o;
      },
      onSent: (h) => persisted.push(h),
      lookupRetries: 3,
      sleep: async () => {},
    };
    return { d, sent, persisted, events, byRootCalls, costReads: () => costReads, lookups: () => lookups };
  };

  it('pre-pays the shortfall (with slack), sends the tokens and returns the campaign id', async () => {
    const f = fake([created('9')]);
    expect(await fundCampaign(f.d, p)).toEqual({ campaignId: '9', txHash: 'h1-1' });
    expect(f.sent).toEqual([['prepay_deposit', 'ft_transfer_call']]);
  });
  it('on E128 re-reads the costs and retries once', async () => {
    const f = fake([panicked('E128_INSUFFICIENT_STORAGE'), created('10')]);
    expect(await fundCampaign(f.d, p)).toEqual({ campaignId: '10', txHash: 'h2-1' });
    expect(f.costReads()).toBe(2);
  });
  it('gives up after a second E128 with a proven refund (Create may be re-enabled)', async () => {
    const err = await fundCampaign(fake([panicked('E128_INSUFFICIENT_STORAGE'), panicked('E128_INSUFFICIENT_STORAGE')]).d, p).catch((e) => e);
    expect(err).toBeInstanceOf(NotCreated);
    expect(err.code).toMatch(/^E128/);
  });
  it('persists the draft before asking the wallet, so a reload with the popup open loses nothing', async () => {
    const f = fake([created('9')]);
    await fundCampaign(f.d, p);
    expect(f.events).toEqual(['persist-draft', 'send']);
  });
  it('if the draft cannot be persisted, nothing is sent (NotSent)', async () => {
    const f = fake([created('9')]);
    const err = await fundCampaign({ ...f.d, beforeSend: () => { throw new Error('QuotaExceededError'); } }, p).catch((e) => e);
    expect(err).toBeInstanceOf(NotSent);
    expect(f.sent).toHaveLength(0);
  });
  it('a wallet error is SendUncertain, never "nothing was sent"', async () => {
    const f = fake([], '0', { sendFails: true });
    expect(await fundCampaign(f.d, p).catch((e) => e)).toBeInstanceOf(SendUncertain);
    expect(f.lookups()).toBe(0);
  });
  it('resolveByRoot after a lost send: the campaign exists (verified against get_campaign) or it does not', async () => {
    const want = { merkleRoot: p.merkleRoot, total: p.total };
    const found = fake([], '0', { byRoot: '33' });
    expect(await resolveByRoot(found.d, want)).toBe('33');
    expect(found.byRootCalls).toEqual([['alice.testnet', p.merkleRoot]]); // keyed by our sender and root
    expect(await resolveByRoot(fake([], '0', { byRoot: null }).d, want)).toBeNull();
    const wrong = fake([], '0', { byRoot: '33' }).d;
    await expect(resolveByRoot({ ...wrong, campaign: async () => ({ merkle_root: p.merkleRoot, amount: '1', sender: 'alice.testnet' }) }, want)).rejects.toThrow('CAMPAIGN_MISMATCH');
    await expect(resolveByRoot({ ...wrong, campaign: async () => ({ merkle_root: p.merkleRoot, amount: p.total, sender: 'mallory.testnet' }) }, want)).rejects.toThrow('CAMPAIGN_MISMATCH');
    await expect(resolveByRoot({ ...wrong, campaign: async () => ({ merkle_root: 'cd'.repeat(32), amount: p.total, sender: 'alice.testnet' }) }, want)).rejects.toThrow('CAMPAIGN_MISMATCH');
    await expect(resolveByRoot({ ...wrong, campaign: async () => null }, want)).rejects.toThrow('CAMPAIGN_MISMATCH');
  });
  it('after an uncertain send, waits ~90 s and looks by root again before letting the draft go', async () => {
    const want = { merkleRoot: p.merkleRoot, total: p.total };
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    expect(await settleAfterUncertain(fake([], '0', { byRoot: '33' }).d, want, { sleep })).toBe('33'); // the earlier tx landed
    expect(await settleAfterUncertain(fake([], '0', { byRoot: null }).d, want, { sleep })).toBeNull();
    expect(waits).toEqual([90_000, 90_000]);
  });
  it('E132 (this root already funded a campaign) resolves to the existing campaign', async () => {
    const f = fake([panicked('E132_DUPLICATE_CAMPAIGN')], '0', { byRoot: '33' });
    expect(await fundCampaign(f.d, p)).toEqual({ campaignId: '33', txHash: 'h1-1' });
    expect(f.sent).toHaveLength(1);
  });
  it('our contract ran and succeeded but a token receipt failed: unclear, not refunded', async () => {
    const mixed: Outcome = { receipts_outcome: [
      { outcome: { executor_id: 'zarf-near.testnet', logs: [] } },
      { outcome: { executor_id: 'usdc.testnet', status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'resolve failed' } } } } } } },
    ] };
    expect((await checkCreation(fake([mixed]).d, 'h', { merkleRoot: p.merkleRoot, total: p.total })).kind).toBe('unclear');
  });
  it('persists the hash as soon as the wallet returns it, before the lookup', async () => {
    const f = fake([created('9')]);
    await fundCampaign(f.d, p);
    expect(f.persisted).toEqual(['h1-1']);
  });
  it('a lookup timeout is retried as a lookup, never as a second send', async () => {
    const f = fake([new Error('timeout'), new Error('timeout'), created('9')]);
    expect(await fundCampaign(f.d, p)).toEqual({ campaignId: '9', txHash: 'h1-1' });
    expect(f.sent).toHaveLength(1);
    expect(f.lookups()).toBe(3);
  });
  it('a lookup that keeps failing ends in LookupPending with the hash, and nothing was re-sent', async () => {
    const f = fake([]);
    const err = await fundCampaign(f.d, p).catch((e) => e);
    expect(err).toBeInstanceOf(LookupPending);
    expect(err.txHash).toBe('h1-1');
    expect(f.sent).toHaveLength(1);
  });
  it('checkCreation (after a reload) resolves an E132 refund to the existing campaign, never "refunded"', async () => {
    const want = { merkleRoot: p.merkleRoot, total: p.total };
    expect(await checkCreation(fake([panicked('E132_DUPLICATE_CAMPAIGN')], '0', { byRoot: '33' }).d, 'h2-1', want)).toEqual({ kind: 'created', campaignId: '33', txHash: 'h2-1' });
    // E132 but the contract shows no campaign for this root: never claim the tokens came back.
    expect(await checkCreation(fake([panicked('E132_DUPLICATE_CAMPAIGN')], '0', { byRoot: null }).d, 'h2-1', want)).toEqual({ kind: 'unclear', txHash: 'h2-1' });
  });

  it('checkCreation later proves the refund (Create re-enabled) or finds the campaign', async () => {
    const want = { merkleRoot: p.merkleRoot, total: p.total };
    expect(await checkCreation(fake([panicked('E119_INVALID_DEADLINE')]).d, 'h1-1', want)).toEqual({ kind: 'refunded', code: 'E119_INVALID_DEADLINE', txHash: 'h1-1' });
    expect(await checkCreation(fake([new Error('timeout'), created('9')]).d, 'h1-1', want)).toEqual({ kind: 'created', campaignId: '9', txHash: 'h1-1' });
  });
  it('the token refusing ft_transfer_call before the contract ran also proves the tokens never moved', async () => {
    const tokenFailed: Outcome = { receipts_outcome: [{ outcome: { executor_id: 'usdc.testnet', status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'The account does not have enough balance' } } } } } } }] };
    expect((await checkCreation(fake([tokenFailed]).d, 'h', { merkleRoot: p.merkleRoot, total: p.total })).kind).toBe('refunded');
  });
  it('no campaign_created and no proven refund is OutcomeUnclear: Create stays off', async () => {
    const quiet: Outcome = { receipts_outcome: [{ outcome: { executor_id: 'zarf-near.testnet', logs: [] } }] };
    expect(await fundCampaign(fake([quiet]).d, p).catch((e) => e)).toBeInstanceOf(OutcomeUnclear);
    const otherRoot: Outcome = { receipts_outcome: [{ outcome: { executor_id: 'zarf-near.testnet', logs: [`EVENT_JSON:${JSON.stringify({ standard: 'zarf-near', event: 'campaign_created', data: [{ campaign_id: '9', merkle_root: 'cd'.repeat(32), amount: '42' }] })}`] } }] };
    expect(await fundCampaign(fake([otherRoot]).d, p).catch((e) => e)).toBeInstanceOf(OutcomeUnclear);
  });
  it('reports other contract errors (proven refund) without retrying', async () => {
    const f = fake([panicked('E119_INVALID_DEADLINE')]);
    const err = await fundCampaign(f.d, p).catch((e) => e);
    expect(err).toBeInstanceOf(NotCreated);
    expect(err.code).toBe('E119_INVALID_DEADLINE');
    expect(f.sent).toHaveLength(1);
  });
  it('skips the deposit when the free pre-pay covers it', async () => {
    const f = fake([created('11')], '1000000');
    await fundCampaign(f.d, p);
    expect(f.sent).toEqual([['ft_transfer_call']]);
  });

});

describe('mayCreate (a pinned draft belongs to its sender)', () => {
  it('refuses another account while pinned', () => {
    const r = mayCreate({ pinned: true, sentFrom: 'x.testnet', account: 'y.testnet' });
    expect(r).toEqual({ ok: false, reason: 'Reconnect x.testnet to continue.' });
  });
  it('allows the sender, and any account before anything was sent', () => {
    expect(mayCreate({ pinned: true, sentFrom: 'x.testnet', account: 'x.testnet' })).toEqual({ ok: true });
    expect(mayCreate({ pinned: false, sentFrom: null, account: 'y.testnet' })).toEqual({ ok: true });
  });
  it('allows again after reconnecting the sender (reload as another account, then back)', () => {
    const pin = { pinned: true, sentFrom: 'x.testnet' };
    expect(mayCreate({ ...pin, account: 'y.testnet' }).ok).toBe(false);
    expect(mayCreate({ ...pin, account: null }).ok).toBe(false);
    expect(mayCreate({ ...pin, account: 'x.testnet' }).ok).toBe(true);
  });
});

describe('readMarker (unresolved send seen from another tab)', () => {
  const store = (v: string | null) => {
    const m = new Map<string, string>(v === null ? [] : [['k', v]]);
    return { getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => void m.delete(k), has: () => m.has('k') };
  };
  const marker = { root: 'ab'.repeat(32), sender: 'x.testnet', total: '42', at: 1_000 };
  it('returns a fresh marker', () => expect(readMarker(store(JSON.stringify(marker)), 'k', 1_000 + 60_000)).toEqual(marker));
  it('expires after 24 h and removes it', () => {
    const s = store(JSON.stringify(marker));
    expect(readMarker(s, 'k', 1_000 + MARKER_TTL_MS + 1)).toBeNull();
    expect(s.has()).toBe(false);
  });
  it('drops a broken or old-format marker', () => {
    const s = store(JSON.stringify({ root: 'r', sender: 's' }));
    expect(readMarker(s, 'k', 2_000)).toBeNull();
    expect(s.has()).toBe(false);
    expect(readMarker(store('{'), 'k', 2_000)).toBeNull();
  });
});

describe('NEAR this send needs (step 3 advisory check)', () => {
  // Live testnet values read 12 Nov 2026: storage_costs on zarf-near-1112.testnet, gas_price 1e8, storage_byte_cost 1e19.
  const costs = { ft_storage_deposit: '1250000000000000000000', claim_entry_cost: '1060000000000000000000', per_claim_storage: '2310000000000000000000', campaign_bytes_cost: '7090000000000000000000' };
  it('is the storage pre-pay plus all attached gas at the gas price (2 txs when a pre-pay is due)', () => {
    const short = prepayShortfall(costs, 3, '0', ownerKeySlack('10000000000000000000'));
    expect(short).toBe(14_340_000_000_000_000_000_000n); // 0.00709 + 3 × 0.00231 + 0.00032
    expect(attachedGas(short)).toBe(230_000_000_000_000n);
    expect(nearNeeded(short, 100_000_000n)).toBe(short + 23_000_000_000_000_000_000_000n); // + 0.023
    // gas matches what fundingTxs attaches
    const txs = fundingTxs({ sender: 's', contractId: 'c', tokenId: 't', merkleRoot: 'r', deadlineNs: '1', leafCount: 3, total: '1', shortfall: short });
    expect(txs.reduce((g, t) => g + BigInt(t.actions[0].params.gas), 0n)).toBe(attachedGas(short));
    const one = fundingTxs({ sender: 's', contractId: 'c', tokenId: 't', merkleRoot: 'r', deadlineNs: '1', leafCount: 3, total: '1', shortfall: 0n });
    expect(BigInt(one[0].actions[0].params.gas)).toBe(attachedGas(0n));
  });
  it('spendable NEAR keeps what the account needs for its own storage, never below 0', () => {
    expect(spendableNear({ amount: '5000000000000000000000000', storage_usage: 182 }, '10000000000000000000')).toBe(5_000_000_000_000_000_000_000_000n - 1_820_000_000_000_000_000_000n);
    expect(spendableNear({ amount: '1', storage_usage: 182 }, '10000000000000000000')).toBe(0n);
  });
});

describe('fundsShort (step 3 blocks Continue below the total)', () => {
  it('is the missing amount, or 0 when the balance covers it', () => {
    expect(fundsShort('120000000', 37_500_000n)).toBe(0n);
    expect(fundsShort('37500000', 37_500_000n)).toBe(0n);
    expect(fundsShort('10000000', 37_500_000n)).toBe(27_500_000n);
  });
  it('never blocks when the balance could not be read', () => {
    expect(fundsShort(null, 37_500_000n)).toBe(0n);
    expect(fundsShort('unclaimed', 37_500_000n)).toBe(0n);
  });
});

describe('readRecoveryFile (Open a backup file)', () => {
  const ctx = { contractId: 'zarf-near.testnet', network: 'testnet', claimOrigin: 'https://claim.example' };
  const rows = [
    { line: 1, email: 'alice@gmail.com', amount: 10_000_000n },
    { line: 2, email: 'bob@gmail.com', amount: 2_500_000n },
    { line: 3, email: 'chen@gmail.com', amount: 25_000_000n },
  ];
  it('a file from recoveryFile() plus the campaign id gives exactly the links claimLink() gives', async () => {
    const draft = await buildDraft(rows);
    const back = await readRecoveryFile(recoveryFile(draft, '1800000000000000000', ctx), ctx);
    expect(back.deadlineNs).toBe('1800000000000000000');
    expect(back.draft).toEqual(draft);
    expect(back.draft.recipients.map((r) => claimLink(ctx.claimOrigin, '12', r))).toEqual(draft.recipients.map((r) => claimLink(ctx.claimOrigin, '12', r)));
  });
  it('refuses another contract or network, a non-backup file, and any row that does not rebuild the root', async () => {
    const draft = await buildDraft(rows);
    const file = recoveryFile(draft, '1', ctx);
    await expect(readRecoveryFile(file, { contractId: 'other.testnet', network: 'testnet' })).rejects.toThrow(/other|not this site/);
    await expect(readRecoveryFile(file, { contractId: ctx.contractId, network: 'mainnet' })).rejects.toThrow(/not this site/);
    await expect(readRecoveryFile('{', ctx)).rejects.toThrow(/not a Zarf backup/);
    await expect(readRecoveryFile('{"kind":"x"}', ctx)).rejects.toThrow(/not a Zarf backup/);
    for (const mutate of [
      (f: any) => (f.recipients[1].amount = '2500001'),
      (f: any) => (f.recipients[0].email = 'mallory@gmail.com'),
      (f: any) => (f.recipients[2].proof = f.recipients[2].proof.slice(1)),
      (f: any) => (f.merkle_root = 'ab'.repeat(32)),
      (f: any) => (f.recipients[0].proof = Array(21).fill('ab'.repeat(32))), // over the 20-level cap
    ]) {
      const f = JSON.parse(file);
      mutate(f);
      await expect(readRecoveryFile(JSON.stringify(f), ctx)).rejects.toThrow(/damaged/);
    }
  });
});
