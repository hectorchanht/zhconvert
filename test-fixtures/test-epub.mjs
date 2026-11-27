// EPUB pipeline test (plain node, no DOM):
//   node test-fixtures/test-epub.mjs
// Builds assertions against the real fixture.epub (make_fixture.py):
//   - inspect finds Han, counts 2 spine docs, head text is Simplified
//   - convert (OpenCC s2t via @dawn-studio/zh-convert) Traditionalises the
//     prose and the OPF dc:title, while attributes / <script> / <style>
//     contents stay byte-identical Simplified
//   - the repacked zip is written to fixture-converted.epub for the
//     python structure check (mimetype first + STORE)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { warmConfig, convertWithConfig } from '@dawn-studio/zh-convert';
import { inspectEpub, convertEpub } from '../src/epub-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, 'fixture.epub');
const outPath = join(here, 'fixture-converted.epub');

let failures = 0;
function assert(cond, label) {
  if (cond) console.log('  ok  ' + label);
  else { failures++; console.error('FAIL  ' + label); }
}

const buf = readFileSync(fixturePath);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

console.log('— inspect —');
const meta = await inspectEpub(ab);
console.log(JSON.stringify(meta, null, 2));
assert(meta.totalDocs === 2, 'totalDocs === 2');
assert(meta.hanCount > 20, 'hanCount > 20 (got ' + meta.hanCount + ')');
assert(meta.headText.includes('简体中文'), 'headText is Simplified source');
assert(meta.totalChars > 50, 'totalChars > 50');

console.log('— convert (s2t) —');
await warmConfig('s2t');
const seg = async (t) => convertWithConfig(t, 's2t');
const progress = [];
const res = await convertEpub(ab, {
  convertSeg: seg,
  onProgress: (done, total, head) => progress.push([done, total, head.slice(0, 20)])
});
console.log('progress events:', JSON.stringify(progress));
assert(res.totalDocs === 2, 'convert totalDocs === 2');
assert(res.changedDocs === 2, 'changedDocs === 2 (got ' + res.changedDocs + ')');
assert(res.headPreview.includes('簡體中文'), 'headPreview converted to Traditional');
assert(progress.length === 2 && progress[1][0] === 2, 'progress fired per doc');

const bytes = await res.zip.generateAsync({ type: 'uint8array' });
writeFileSync(outPath, bytes);
console.log('wrote', outPath, bytes.length, 'bytes');

// Re-open the generated epub and check the actual document contents.
const { default: JSZip } = await import('jszip');
const zip2 = await JSZip.loadAsync(bytes);
const ch1 = await zip2.file('OEBPS/ch1.xhtml').async('string');
const opf = await zip2.file('OEBPS/content.opf').async('string');
console.log('— content assertions —');
assert(ch1.includes('簡體中文，頭髮和鼠標都要轉換。'), 'prose converted (头发→頭髮, 鼠标→鼠標)');
assert(ch1.includes('周杰倫的新專輯很好聽'), 'prose converted (周杰伦→周杰倫)');
assert(!ch1.includes('简体中文'), 'no Simplified prose left');
assert(ch1.includes('title="简体属性不要动"'), 'ATTRIBUTE untouched (still Simplified)');
assert(ch1.includes('data-note="简体属性"'), 'data attribute untouched');
assert(ch1.includes('var s = "简体脚本不要动";'), '<script> content untouched');
assert(ch1.includes('content: "简体样式不要动"'), '<style> content untouched');
assert(opf.includes('<dc:title>簡體小說測試</dc:title>'), 'OPF dc:title converted');
assert(opf.includes('<dc:creator>簡體作者</dc:creator>'), 'OPF dc:creator converted');
assert(opf.includes('zh-CN'), 'OPF dc:language untouched');

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
