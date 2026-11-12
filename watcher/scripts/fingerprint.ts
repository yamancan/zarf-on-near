// Prints the live claim page's fingerprint as JSON (watcher/expected/<network>.json). Node 24 (type stripping).
//   node scripts/fingerprint.ts <claim page url> [max scripts, default 44] [local client build dir]
// With a build dir (web/.svelte-kit/output/client), exits 2 unless every live script is byte-identical to
// the build: the list then records what was just deployed, not a cached or tampered copy.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fingerprint } from '../src/bundle.ts';

const [url, max = '44', buildDir] = process.argv.slice(2);
if (!url) throw new Error('usage: node scripts/fingerprint.ts <claim page url> [max scripts, default 44] [local client build dir]');
const fp = await fingerprint(url, (u) => fetch(u, { signal: AbortSignal.timeout(15_000), cache: 'no-store' }), Number(max));
if (buildDir) {
  const off = Object.entries(fp.scripts).filter(([p, h]) => {
    try {
      return createHash('sha256').update(readFileSync(buildDir + p)).digest('hex') !== h;
    } catch {
      return true;
    }
  });
  if (off.length) {
    console.error(`live differs from ${buildDir}: ${off.map(([p]) => p).join(', ')}`);
    process.exit(2);
  }
}
console.log(JSON.stringify(fp, null, 2));
