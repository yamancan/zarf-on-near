// Local `wrangler dev --test-scheduled` entry: the real tick() against the fixture site's expected list.
import { tick, type Env } from '../../src/index.ts';
import expected from './expected.json';

export default {
  async scheduled(_c: unknown, env: Env): Promise<void> {
    await tick(env, expected);
  },
};
