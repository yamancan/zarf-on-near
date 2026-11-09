import { afterEach, describe, expect, it, vi } from 'vitest';
import vectors from '../../../spec/vectors.json';
import { ClaimError, describeError, fetchLeaves, getCampaign, requestSignature, submitClaim } from './services';

const reply = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
afterEach(() => vi.unstubAllGlobals());
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e) => (e instanceof ClaimError ? e.code : String(e)));

describe('getCampaign (NEAR RPC view)', () => {
  it('sends a call_function query and decodes the byte result', async () => {
    const campaign = { merkle_root: vectors.campaigns.main.merkle_root, deadline_ns: vectors.context.deadline_ns };
    const fetchMock = reply({ jsonrpc: '2.0', result: { result: [...new TextEncoder().encode(JSON.stringify(campaign))] } });
    vi.stubGlobal('fetch', fetchMock);
    expect(await getCampaign('https://rpc.test', 'zarf-near.testnet', '7')).toEqual(campaign);
    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.params).toMatchObject({ request_type: 'call_function', account_id: 'zarf-near.testnet', method_name: 'get_campaign' });
    expect(JSON.parse(atob(sent.params.args_base64))).toEqual({ campaign_id: '7' });
  });
  it('fails on an RPC error', async () => {
    vi.stubGlobal('fetch', reply({ error: { name: 'HANDLER_ERROR' } }));
    expect(await code(getCampaign('https://rpc.test', 'c', '7'))).toBe('RPC_ERROR');
  });
  it('says what is not configured', async () => {
    expect(await code(getCampaign('', 'c', '7'))).toBe('NOT_CONFIGURED:PUBLIC_NEAR_RPC_URL');
    expect(await code(getCampaign('https://rpc.test', undefined, '7'))).toBe('NOT_CONFIGURED:PUBLIC_CONTRACT_ID');
  });
});

describe('fetchLeaves', () => {
  const main = vectors.campaigns.main;
  const file = { campaign_id: main.campaign_id, merkle_root: main.merkle_root, leaves: main.recipients.map(({ commitment, amount }) => ({ commitment, amount })) };
  it('refuses a file for another campaign', async () => {
    vi.stubGlobal('fetch', reply({ ...file, campaign_id: '8' }));
    expect(await code(fetchLeaves('https://leaves.test', main.campaign_id))).toBe('LEAVES_MISMATCH');
  });
  it('accepts the spec file shape', async () => {
    vi.stubGlobal('fetch', reply(file));
    expect(await fetchLeaves('https://leaves.test', main.campaign_id)).toEqual(file);
  });
  it.each([
    ['a bare array', file.leaves],
    ['a bad root', { ...file, merkle_root: 'AB' }],
    ['no leaves', { ...file, leaves: [] }],
    ['an uppercase commitment', { ...file, leaves: [{ commitment: 'AB'.repeat(32), amount: '1' }] }],
    ['a zero amount', { ...file, leaves: [{ commitment: '00'.repeat(32), amount: '0' }] }],
  ])('rejects %s', async (_, body) => {
    vi.stubGlobal('fetch', reply(body));
    expect(await code(fetchLeaves('https://leaves.test', main.campaign_id))).toBe('LEAVES_INVALID');
  });
});

describe('verifier and relayer', () => {
  it('passes the verifier error code through', async () => {
    vi.stubGlobal('fetch', reply({ error: 'COMMITMENT_MISMATCH' }, 403));
    const err = await requestSignature('https://v.test', {}).catch((e) => e);
    expect(err).toBeInstanceOf(ClaimError);
    expect(describeError(err)).toMatch(/different Google account/);
  });
  const HASH = '6zgh2u9DqHHiXzdy9ouTP7oGky2T4nugqzqt9wJZwNFm';
  it('posts the signed args to the relayer and returns the tx hash', async () => {
    const fetchMock = reply({ tx_hash: HASH });
    vi.stubGlobal('fetch', fetchMock);
    const args = vectors.claims.valid[0].call_args;
    expect(await submitClaim('https://r.test', args)).toBe(HASH);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('https://r.test/claim');
  });
  it.each([[{}], [{ tx_hash: 'H' }], [{ tx_hash: `${HASH}"><script>` }], [{ tx_hash: 'O0Il'.repeat(11) }]])('refuses relayer reply %j', async (body) => {
    vi.stubGlobal('fetch', reply(body));
    expect(await code(submitClaim('https://r.test', vectors.claims.valid[0].call_args))).toBe('RELAYER_NO_TX');
  });
  it.each(['UPSTREAM_UNAVAILABLE', 'E101_INVALID_SIGNATURE', 'E129_INSUFFICIENT_BALANCE', 'BAD_DESTINATION', 'LEAVES_MISMATCH', 'LEAVES_INVALID', 'LEAVES_UNAVAILABLE'])('has copy for %s', (c) => {
    expect(describeError(new ClaimError(c))).not.toMatch(/did not go through/);
  });
  it('explains missing config and unknown codes', () => {
    expect(describeError(new ClaimError('NOT_CONFIGURED:PUBLIC_VERIFIER_URL'))).toMatch(/PUBLIC_VERIFIER_URL/);
    expect(describeError(new ClaimError('E999'))).toMatch(/E999/);
  });
});
