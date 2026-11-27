// Text-path regression: convert-core's convertText (via processJob) must
// produce byte-identical output to calling the lib's convertWithConfig
// line-by-line — the chunked worker pipeline must not change semantics.
// Uses the existing GBK big-file fixture at the project root.
//   node test-fixtures/test-text-regression.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { warmConfig, convertWithConfig } from '@dawn-studio/zh-convert';
import { processJob } from '../src/convert-core.js';
import { decodeTextBytes } from '../src/encoding.js';

const here = dirname(fileURLToPath(import.meta.url));
const buf = readFileSync(join(here, '..', 'test-gbk-big.txt'));
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const { text, encoding } = decodeTextBytes(ab);
console.log('decoded as', encoding, '-', text.length, 'chars');

let failures = 0;
function assert(cond, label) {
  if (cond) console.log('  ok  ' + label);
  else { failures++; console.error('FAIL  ' + label); }
}

assert(!text.includes('�'), 'GBK decode has no replacement chars');

await warmConfig('s2t');

// Reference: the lib, line by line (the pre-worker semantics).
const refLines = [];
for (const ln of text.split('\n')) refLines.push(await convertWithConfig(ln, 's2t'));
const reference = refLines.join('\n');

// Core pipeline through processJob (worker/fallback shared path).
const stages = [];
let progressEvents = 0;
const res = await processJob(
  { kind: 'text', text, ext: '.txt', config: 's2t', direction: 'auto' },
  {
    stage: (s) => stages.push(s),
    progress: () => { progressEvents++; }
  }
);
assert(res.kind === 'text', 'processJob returns text result');
assert(res.text === reference, 'core output === lib line-by-line reference (' + res.text.length + ' chars)');
assert(res.text.includes('簡體中文') && res.text.includes('周杰倫'), 'spot check conversion present');
assert(stages.includes('loading-engine') && stages.includes('engine-ready'), 'engine stage events fired');
assert(progressEvents > 0, 'progress events fired (' + progressEvents + ')');

// Line job (filename path).
const line = await processJob({ kind: 'line', text: '简体小说', config: 's2t', direction: 'auto' }, {});
assert(line.text === '簡體小說', 'line job converts filename (got ' + line.text + ')');

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
