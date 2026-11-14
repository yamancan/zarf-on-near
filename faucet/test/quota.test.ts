import { expect, it } from 'vitest';
import { takeQuota } from '../src/limits';
import { memoryQuota } from './quota-fixture';

const now = Date.UTC(2026, 10, 16);
const limits = { perIpPerDay: 2, perEmailPerDay: 1, dailyCap: 2 };

it('a lost reserve acknowledgement is retried without consuming another IP or daily slot', async () => {
  const memory = memoryQuota();
  let loseReply = true;
  const namespace = { getByName: (name: string) => {
    const real = memory.namespace.getByName(name);
    return {
      reserve: async (input: Parameters<typeof real.reserve>[0]) => {
        const reply = await real.reserve(input);
        if (loseReply) { loseReply = false; throw new Error('reply lost after commit'); }
        return reply;
      },
      commit: real.commit.bind(real), cancel: real.cancel.bind(real),
    };
  } };
  expect((await takeQuota(namespace, 'key', limits, 'ip', 'a@x.io', now)).ok).toBe(true);
  expect((await takeQuota(namespace, 'key', limits, 'ip', 'b@x.io', now)).ok).toBe(true);
  expect(await takeQuota(namespace, 'key', limits, 'other-ip', 'c@x.io', now))
    .toEqual({ ok: false, code: 'DAILY_CAP_REACHED' });
});

it('retries commit and cancel writes without double-releasing email quota or refunding attempt slots', async () => {
  const memory = memoryQuota();
  const first = await takeQuota(memory.namespace, 'key', limits, 'ip', 'a@x.io', now);
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error('reservation failed');
  memory.failWrites(2);
  await first.cancelEmail();
  await first.cancelEmail();
  const second = await takeQuota(memory.namespace, 'key', limits, 'ip', 'a@x.io', now);
  expect(second.ok).toBe(true);
  if (!second.ok) throw new Error('reservation failed');
  memory.failWrites(2);
  await second.commitEmail();
  await second.cancelEmail();
  expect(await takeQuota(memory.namespace, 'key', limits, 'other-ip', 'a@x.io', now))
    .toEqual({ ok: false, code: 'RATE_LIMITED_EMAIL' });
  expect(await takeQuota(memory.namespace, 'key', limits, 'other-ip', 'b@x.io', now))
    .toEqual({ ok: false, code: 'DAILY_CAP_REACHED' });
});

it('stops after three failed storage attempts and leaves the transaction rolled back', async () => {
  const memory = memoryQuota();
  memory.failWrites(3);
  await expect(takeQuota(memory.namespace, 'key', limits, 'ip', 'a@x.io', now)).rejects.toThrow('storage unavailable');
  expect(memory.records.size).toBe(0);
  expect((await takeQuota(memory.namespace, 'key', limits, 'ip', 'a@x.io', now)).ok).toBe(true);
});

it('concurrent requests from one IP cannot race past its daily allowance', async () => {
  const { namespace } = memoryQuota();
  const results = await Promise.all(Array.from({ length: 8 }, (_, n) =>
    takeQuota(namespace, 'key', { perIpPerDay: 1, perEmailPerDay: 1, dailyCap: 8 }, 'same-ip', `judge-${n}@x.io`, now)));
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.filter((r) => !r.ok).map((r) => r.code)).toEqual(Array(7).fill('RATE_LIMITED_IP'));
});
