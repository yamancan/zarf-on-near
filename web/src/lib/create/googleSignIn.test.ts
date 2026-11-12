import { describe, expect, it, vi } from 'vitest';
import { domainUsesGoogle, mayNotSignIn } from './googleSignIn';

const mx = (...hosts: string[]) => ({ Status: 0, Answer: hosts.map((h, i) => ({ type: 15, data: `${i + 1} ${h}.` })) });
const doh = (byDomain: Record<string, unknown>) =>
  vi.fn(async (url: string | URL | Request) => {
    const name = new URL(String(url)).searchParams.get('name') ?? '';
    const body = byDomain[name];
    if (body === 'down') throw new TypeError('network');
    return Response.json(body ?? { Status: 0 });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

describe('domainUsesGoogle', () => {
  it('gmail.com and googlemail.com need no lookup', async () => {
    const f = doh({});
    expect(await domainUsesGoogle('gmail.com', f)).toBe(true);
    expect(await domainUsesGoogle('googlemail.com', f)).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });
  it('a Workspace domain (MX on google.com or googlemail.com) counts, and is looked up once', async () => {
    const f = doh({ 'ws-a.example': mx('alt2.aspmx.l.google.com'), 'ws-b.example': mx('aspmx2.googlemail.com'), 'ws-c.example': mx('smtp.google.com') });
    expect(await domainUsesGoogle('ws-a.example', f)).toBe(true);
    expect(await domainUsesGoogle('ws-a.example', f)).toBe(true);
    expect(await domainUsesGoogle('ws-b.example', f)).toBe(true);
    expect(await domainUsesGoogle('WS-C.example', f)).toBe(true);
    expect(f).toHaveBeenCalledTimes(3);
  });
  it('a non-Google domain does not, nor a look-alike host, a null MX or a missing domain', async () => {
    const f = doh({
      'ms.example': mx('ms-example.mail.protection.outlook.com'),
      'fake.example': mx('aspmx.l.google.com.evil.example', 'notgoogle.com'),
      'null.example': mx(''),
      'gone.example': { Status: 3 },
    });
    for (const d of ['ms.example', 'fake.example', 'null.example', 'gone.example']) expect(await domainUsesGoogle(d, f)).toBe(false);
  });
  it('a failed lookup shows the note and is retried next time', async () => {
    const down = doh({ 'flaky.example': 'down', 'servfail.example': { Status: 2 } });
    expect(await domainUsesGoogle('flaky.example', down)).toBe(false);
    expect(await domainUsesGoogle('servfail.example', down)).toBe(false);
    const http = vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    expect(await domainUsesGoogle('http500.example', http)).toBe(false);
    const up = doh({ 'flaky.example': mx('aspmx.l.google.com') });
    expect(await domainUsesGoogle('flaky.example', up)).toBe(true);
  });
});

describe('mayNotSignIn', () => {
  it('returns only the addresses whose domain is not known to use Google, one lookup per domain', async () => {
    const f = doh({ 'ws-m.example': mx('aspmx.l.google.com'), 'other-m.example': mx('mx.other-m.example') });
    const out = await mayNotSignIn(['a@gmail.com', 'b@ws-m.example', 'c@other-m.example', 'd@other-m.example'], f);
    expect([...out]).toEqual(['c@other-m.example', 'd@other-m.example']);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
