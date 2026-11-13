// Prints the live claim page's fingerprint as JSON (watcher/expected/<network>.json). Node 24 (type stripping).
//   node scripts/fingerprint.ts <claim page url> [scripts the watcher re-hashes per run, default 40] [local client build dir]
// Records every script the page loads, however many (Node has no subrequest limit; the watcher rotates through
// them, see src/bundle.ts). With a build dir (web/.svelte-kit/output/client), exits 2 unless every live script
// is byte-identical to the build: the list then records what was just deployed, not a cached or tampered copy.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fingerprint } from '../src/bundle.ts';

const [url, perRun = '40', buildDir] = process.argv.slice(2);
if (!url) throw new Error('usage: node scripts/fingerprint.ts <claim page url> [scripts per watcher run, default 40] [local client build dir]');
const fp = await fingerprint(url, (u) => fetch(u, { signal: AbortSignal.timeout(15_000), cache: 'no-store' }));
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
const n = Object.keys(fp.scripts).length, per = Math.max(1, Number(perRun));
const runs = n <= per ? 1 : Math.ceil(n / Math.max(1, per - Math.floor(per / 4))); // the scheduled slice of src/bundle.ts pick()
console.error(`${n} scripts recorded${buildDir ? ', all identical to the build' : ''}; at ${per} per run the watcher re-hashes each within ${runs} run(s) (${runs * 2} min)`);
console.log(JSON.stringify(fp, null, 2));
