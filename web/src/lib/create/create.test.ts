import { describe, expect, it } from 'vitest';
import vectors from '../../../../spec/vectors.json';
import { proofFor } from '../merkle';
import { buildDraft, claimLink, commitment, leafList, newSalt, recoveryFile } from './campaign';
import { campaignIdFrom, fundingTxs, minDeadlineMs, prepayShortfall } from './funding';
import { formatAmount, parseAmount, parseRecipients } from './recipients';

const { campaigns } = vectors;
// CSV as a sender would paste it: USDC amounts, Windows line endings, the vector emails as given.
const csvOf = (rs: typeof campaigns.main.recipients) =>
  'email,amount\r\n' + rs.map((r) => `${r.email.replace(/[\r\n]+$/, '')},${formatAmount(BigInt(r.amount))}`).join('\r\n');
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
  it('reads the vector campaign, skipping the header, with the total', () => {
    const { rows, rejected, total } = parseRecipients(csvOf(campaigns.main.recipients));
    expect(rejected).toEqual([]);
    expect(rows.map((r) => r.email)).toEqual(campaigns.main.recipients.map((r) => r.canonical_email));
    expect(total).toBe(campaigns.main.recipients.reduce((t, r) => t + BigInt(r.amount), 0n));
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
  it('keeps duplicate emails as separate allocations', () => {
    expect(parseRecipients('a@example.com,1\na@example.com;2').rows).toHaveLength(2);
  });
});

describe('buildDraft reproduces the spec campaigns', () => {
  it.each(Object.entries(campaigns))('%s: commitments and merkle root', async (_, c) => {
    const draft = await buildDraft(parseRecipients(csvOf(c.recipients)).rows, saltsOf(c.recipients));
    expect(draft.recipients.map((r) => r.commitment)).toEqual(c.recipients.map((r) => r.commitment));
    expect(draft.merkleRoot).toBe(c.merkle_root);
  });
  it('draws a fresh 32-byte salt per row by default', async () => {
    const { rows } = parseRecipients('a@example.com,1\na@example.com,1');
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
  it('leaf list per spec: no emails, no salts, and the claim app can prove every leaf from it', async () => {
    const c = campaigns.main;
    const draft = await buildDraft(parseRecipients(csvOf(c.recipients)).rows, saltsOf(c.recipients));
    const file = leafList(c.campaign_id, draft);
    expect(Object.keys(file)).toEqual(['campaign_id', 'merkle_root', 'leaves']);
    expect(JSON.stringify(file)).not.toMatch(/@|salt/);
    for (const v of vectors.claims.valid.filter((x) => x.campaign === 'main')) {
      expect((await proofFor(file.leaves, v.call_args.commitment))!.proof).toEqual(v.call_args.proof);
    }
  });
  it('claim link carries the salt only in the fragment', () => {
    const r = { email: 'a@example.com', amount: '1', salt: 'ab'.repeat(32), commitment: 'cd'.repeat(32) };
    const link = new URL(claimLink('https://claim.example', '7', r));
    expect(link.pathname).toBe(`/claim/7/${r.commitment}`);
    expect(link.hash).toBe(`#s=${r.salt}`);
    expect(link.search).toBe('');
  });
  it('recovery file holds what rebuilding the links needs', async () => {
    const c = campaigns.single;
    const draft = await buildDraft(parseRecipients(csvOf(c.recipients)).rows, saltsOf(c.recipients));
    const f = JSON.parse(recoveryFile(draft, '123'));
    expect(f).toMatchObject({ kind: 'zarf-near-recovery-v1', merkle_root: c.merkle_root, deadline_ns: '123' });
    expect(f.recipients[0]).toMatchObject({ salt: c.recipients[0].salt, commitment: c.recipients[0].commitment });
  });
});

describe('funding', () => {
  const costs = { ft_storage_deposit: '1250000000000000000000', claim_entry_cost: '500', per_claim_storage: '1250000000000000000500', campaign_bytes_cost: '3000' };
  it('deposits only the shortfall', () => {
    expect(prepayShortfall(costs, 5, '0')).toBe(3000n + 5n * 1250000000000000000500n);
    expect(prepayShortfall(costs, 5, '1000')).toBe(3000n + 5n * 1250000000000000000500n - 1000n);
    expect(prepayShortfall(costs, 5, (10n ** 25n).toString())).toBe(0n);
  });
  it('refuses to guess when campaign_bytes_cost is missing', () => {
    const { campaign_bytes_cost: _, ...old } = costs;
    expect(() => prepayShortfall(old as typeof costs, 1, '0')).toThrow('campaign_bytes_cost');
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
  it('reads campaign_id from the campaign_created event of our contract only', () => {
    const ev = (contract: string, id: unknown, event = 'campaign_created') => ({
      outcome: { executor_id: contract, logs: ['noise', `EVENT_JSON:${JSON.stringify({ standard: 'zarf-near', version: '1.0.0', event, data: [{ campaign_id: id }] })}`] },
    });
    expect(campaignIdFrom({ receipts_outcome: [ev('usdc.testnet', '1'), ev('zarf-near.testnet', '9')] }, 'zarf-near.testnet')).toBe('9');
    expect(campaignIdFrom({ receipts_outcome: [ev('evil.testnet', '9')] }, 'zarf-near.testnet')).toBeNull();
    expect(campaignIdFrom({ receipts_outcome: [ev('zarf-near.testnet', '9', 'reclaimed')] }, 'zarf-near.testnet')).toBeNull();
    expect(campaignIdFrom({ receipts_outcome: [ev('zarf-near.testnet', 'x')] }, 'zarf-near.testnet')).toBeNull();
    expect(campaignIdFrom({}, 'zarf-near.testnet')).toBeNull();
  });
  it('earliest deadline = now + min_lifetime_ns', () => {
    expect(minDeadlineMs(1000, '600000000000')).toBe(601_000);
  });
});
