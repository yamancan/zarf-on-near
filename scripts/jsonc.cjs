// Reads a wrangler.jsonc: JSON plus `//` and `/* */` comments, on their own line or after a value. Comments are
// removed only outside strings, so "https://…" is never cut (T-031: a line-only strip broke on a trailing comment).
// Any file it cannot parse is an error naming the file. CommonJS so `node -e 'require(…)'` in the scripts can load it.
//   node scripts/jsonc.cjs <file> <dotted.path>   prints that value ('' when absent)
'use strict';
const fs = require('fs');

function stripJsonc(s) {
  let out = '';
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (c === '"') {
      // a string, escapes included, copied as is
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      if (j >= s.length) throw new Error('unterminated string');
      out += s.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
    } else if (c === '/' && s[i + 1] === '*') {
      const j = s.indexOf('*/', i + 2);
      if (j < 0) throw new Error('unterminated /* comment');
      i = j + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function readJsonc(path) {
  try {
    return JSON.parse(stripJsonc(fs.readFileSync(path, 'utf8')));
  } catch (e) {
    throw new Error(`${path} is not valid JSONC: ${e.message}`);
  }
}

module.exports = { stripJsonc, readJsonc };

if (require.main === module) {
  const [file, path] = process.argv.slice(2);
  if (!file || !path) {
    console.error('usage: node scripts/jsonc.cjs <file> <dotted.path>');
    process.exit(2);
  }
  try {
    const v = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), readJsonc(file));
    console.log(v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
