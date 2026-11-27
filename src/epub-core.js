// EPUB pipeline (DOM-free; runs in the Web Worker, in the main-thread
// fallback, and in plain node for the fixture tests).
//
// Flow: JSZip unpack → META-INF/container.xml → OPF (manifest + spine) →
// convert ONLY the text runs of each XHTML/HTML/NCX document via
// html-convert.js (tags/attributes/script/style stay byte-identical) →
// also convert the OPF's own text nodes (dc:title, dc:creator…) → rebuild
// the zip with the EPUB rules honoured: `mimetype` is the FIRST entry
// and STORED (no compression), everything else DEFLATE.
//
// DRM: a META-INF/encryption.xml means the book cannot be processed —
// we throw the real reason so the UI can show it verbatim.

import JSZip from 'jszip';
import { convertHtml, extractPlainText, textSegments } from './html-convert.js';

export const DRM_ERROR = '呢本 EPUB 有 DRM 加密，處理唔到';

const CONTENT_EXTS = /\.(xhtml|html|htm|ncx)$/i;
const CONTENT_TYPES = new Set([
  'application/xhtml+xml',
  'text/html',
  'application/x-dtbncx+xml'
]);

/** Join an OPF-relative href onto the OPF's directory, normalising ./ ../ */
function resolvePath(opfDir, href) {
  let h = href;
  try { h = decodeURIComponent(href); } catch { /* keep raw */ }
  h = h.split('#')[0].split('?')[0];
  const parts = (opfDir + h).split('/');
  const out = [];
  for (const p of parts) {
    if (p === '.' || p === '') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

function parseContainer(xml) {
  const m = xml.match(/<rootfile[^>]*full-path="([^"]+)"/);
  if (!m) throw new Error('EPUB 結構有問題：container.xml 搵唔到 OPF');
  return m[1];
}

function parseOpf(xml) {
  const manifest = new Map();
  for (const m of xml.matchAll(/<item\b[^>]*>/g)) {
    const tag = m[0];
    const id = tag.match(/\bid="([^"]+)"/)?.[1];
    const href = tag.match(/\bhref="([^"]+)"/)?.[1];
    const type = tag.match(/\bmedia-type="([^"]+)"/)?.[1] || '';
    if (id && href) manifest.set(id, { href, type });
  }
  const spine = [];
  for (const m of xml.matchAll(/<itemref\b[^>]*>/g)) {
    const idref = m[0].match(/\bidref="([^"]+)"/)?.[1];
    if (idref && manifest.has(idref)) spine.push(manifest.get(idref).href);
  }
  return { manifest, spine };
}

async function loadEpub(buf) {
  const zip = await JSZip.loadAsync(buf);
  if (zip.file('META-INF/encryption.xml')) throw new Error(DRM_ERROR);
  const containerEntry = zip.file('META-INF/container.xml');
  if (!containerEntry) throw new Error('EPUB 結構有問題：冇 META-INF/container.xml');
  const containerXml = await containerEntry.async('string');
  const opfPath = parseContainer(containerXml);
  const opfEntry = zip.file(opfPath);
  if (!opfEntry) throw new Error(`EPUB 結構有問題：搵唔到 OPF（${opfPath}）`);
  const opfXml = await opfEntry.async('string');
  const { manifest, spine } = parseOpf(opfXml);
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  // Convertible content documents, in reading (spine) order first, then
  // any other manifest documents (nav, NCX…) not in the spine.
  const seen = new Set();
  const docs = [];
  const pushDoc = (href) => {
    const path = resolvePath(opfDir, href);
    if (!zip.file(path) || seen.has(path)) return;
    seen.add(path);
    docs.push(path);
  };
  for (const href of spine) pushDoc(href);
  for (const { href, type } of manifest.values()) {
    if (CONTENT_TYPES.has(type) || CONTENT_EXTS.test(href)) pushDoc(href);
  }
  return { zip, opfPath, opfXml, docs };
}

/** Non-empty trimmed lines of a plain-text blob, capped for preview use. */
function headLines(text, maxChars = 8000) {
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return lines.join('\n').slice(0, maxChars);
}

function countHan(text) {
  let n = 0;
  for (const ch of text) if (/\p{Script=Han}/u.test(ch)) n++;
  return n;
}

/**
 * Inspect an EPUB without converting: what the UI needs for its
 * nothing-to-do checks and the input-pane preview.
 * Returns { headText, totalChars, hanCount, totalDocs }.
 * Throws on DRM / structural problems (real message).
 */
export async function inspectEpub(buf) {
  const { zip, opfXml, docs } = await loadEpub(buf);
  let totalChars = 0;
  let hanCount = 0;
  let headText = '';
  for (let i = 0; i < docs.length; i++) {
    const content = await zip.file(docs[i]).async('string');
    const segs = textSegments(content);
    for (const s of segs) { totalChars += s.length; hanCount += countHan(s); }
    // Preview from the first document that actually has text (a cover
    // page may be image-only).
    if (!headText) headText = headLines(extractPlainText(content));
  }
  for (const s of textSegments(opfXml)) { totalChars += s.length; hanCount += countHan(s); }
  return { headText, totalChars, hanCount, totalDocs: docs.length };
}

/**
 * Convert an EPUB. `convertSeg(text)` is the engine's segment converter.
 * `onProgress(doneDocs, totalDocs, headPreview)` fires after each document.
 * Returns { zip, totalDocs, changedDocs, docChanges, headPreview,
 * totalChars } where docChanges is [{ name, changed }] per content
 * document (reading order) for the UI's diff list, and `zip` is a
 * rebuilt JSZip ready for generateAsync (mimetype first+STORE).
 */
export async function convertEpub(buf, { convertSeg, onProgress } = {}) {
  const { zip, opfPath, opfXml, docs } = await loadEpub(buf);
  const converted = new Map(); // path -> new content string
  let changedDocs = 0;
  const docChanges = [];
  let totalChars = 0;
  let headPreview = '';
  for (let i = 0; i < docs.length; i++) {
    const path = docs[i];
    const content = await zip.file(path).async('string');
    for (const s of textSegments(content)) totalChars += s.length;
    const { html, changed } = await convertHtml(content, convertSeg);
    converted.set(path, html);
    docChanges.push({ name: path, changed: !!changed });
    if (changed) changedDocs++;
    if (!headPreview) headPreview = headLines(extractPlainText(html));
    if (onProgress) onProgress(i + 1, docs.length, headPreview);
  }
  // The OPF itself: convert its text nodes (dc:title / dc:creator / …).
  const opfOut = await convertHtml(opfXml, convertSeg);
  converted.set(opfPath, opfOut.html);

  // Rebuild: original entry order, mimetype forced first + STORE.
  const out = new JSZip();
  const names = Object.values(zip.files).filter((f) => !f.dir).map((f) => f.name);
  const ordered = ['mimetype', ...names.filter((n) => n !== 'mimetype')];
  for (const name of ordered) {
    const isMime = name === 'mimetype';
    let data;
    if (converted.has(name)) data = converted.get(name);
    else if (isMime) data = 'application/epub+zip';
    else data = await zip.file(name).async('uint8array');
    out.file(name, data, { compression: isMime ? 'STORE' : 'DEFLATE' });
  }
  return { zip: out, totalDocs: docs.length, changedDocs, docChanges, headPreview, totalChars };
}
