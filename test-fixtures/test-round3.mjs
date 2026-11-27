// Round-3 tests (plain node):
//   node test-fixtures/test-round3.mjs
// (a) download encodings: iconv-lite gb18030 / big5 round-trip, UTF-8 BOM
//     prefix, plain UTF-8 bytes — via src/download-encoding.js
// (b) diff report: convert-core processJob returns the exact changedLines
//     indices for a mixed changed/unchanged text
// (c) batch zip: uniqueZipName de-dupes colliding names with (2)/(3)
//     suffixes and the names survive a real jszip round-trip

import iconv from 'iconv-lite';
import JSZip from 'jszip';
import { encodeTextBytes } from '../src/download-encoding.js';
import { uniqueZipName } from '../src/batch-utils.js';
import { processJob } from '../src/convert-core.js';

let failures = 0;
function assert(cond, label) {
  if (cond) console.log('  ok  ' + label);
  else { failures++; console.error('FAIL  ' + label); }
}

console.log('— (a) download encodings —');
{
  const t = '繁體中文測試，頭髮和鼠標都要轉換。';
  const bytes = await encodeTextBytes(t, 'gb18030');
  const back = iconv.decode(Buffer.from(bytes), 'gb18030');
  assert(back === t, 'gb18030 encode -> decode round-trips (' + bytes.length + ' bytes)');
}
{
  const t = '繁體中文，頭髮和周杰倫。'; // all representable in Big5
  const bytes = await encodeTextBytes(t, 'big5');
  const back = iconv.decode(Buffer.from(bytes), 'big5');
  assert(back === t, 'big5 encode -> decode round-trips (' + bytes.length + ' bytes)');
}
{
  const t = '簡體中文';
  const bytes = await encodeTextBytes(t, 'utf8-bom');
  assert(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, 'utf8-bom starts with EF BB BF');
  assert(new TextDecoder().decode(bytes.slice(3)) === t, 'utf8-bom body is the UTF-8 text');
  const plain = await encodeTextBytes(t, 'utf8');
  assert(Buffer.from(plain).equals(Buffer.from(new TextEncoder().encode(t))), 'utf8 bytes match TextEncoder');
}

console.log('— (b) changedLines diff report —');
{
  const src = ['简体中文要转换', 'Hello world only', '繁體中文已經係繁體', '周杰伦唱歌'].join('\n');
  const res = await processJob(
    { kind: 'text', text: src, ext: '.txt', config: 's2t', direction: 'auto' },
    {}
  );
  console.log('  changedLines =', JSON.stringify(res.changedLines));
  console.log('  out lines    =', JSON.stringify(res.text.split('\n')));
  assert(Array.isArray(res.changedLines), 'changedLines is an array');
  assert(JSON.stringify(res.changedLines) === JSON.stringify([0, 3]),
    'changedLines === [0,3] (only the two Simplified lines changed)');
  assert(res.text.split('\n')[0] === '簡體中文要轉換', 'line 0 converted');
  assert(res.text.split('\n')[3] === '周杰倫唱歌', 'line 3 converted');
}

console.log('— (c) zip name de-dupe —');
{
  const used = new Set();
  const n1 = uniqueZipName('a-converted.txt', used);
  const n2 = uniqueZipName('a-converted.txt', used);
  const n3 = uniqueZipName('a-converted.txt', used);
  const n4 = uniqueZipName('b-converted.epub', used);
  assert(n1 === 'a-converted.txt', 'first name unchanged');
  assert(n2 === 'a-converted (2).txt', 'second gets (2) — got ' + n2);
  assert(n3 === 'a-converted (3).txt', 'third gets (3) — got ' + n3);
  assert(n4 === 'b-converted.epub', 'unrelated name unchanged');

  const zip = new JSZip();
  zip.file(n1, 'one');
  zip.file(n2, 'two');
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  const back = await JSZip.loadAsync(bytes);
  const names = Object.keys(back.files).sort();
  assert(JSON.stringify(names) === JSON.stringify(['a-converted (2).txt', 'a-converted.txt']),
    'zip round-trip keeps both deduped names: ' + names.join(', '));
}

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
