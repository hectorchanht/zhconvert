// DOM-free HTML/XHTML text conversion (used by the EPUB pipeline, and
// unit-testable in plain node).
//
// Strategy: a small state machine splits the document into TAG tokens and
// TEXT runs. Tags (including all attributes) pass through byte-for-byte;
// only text runs are sent to the segment converter. The contents of
// <script> and <style> elements are treated as RAW (never converted) —
// code is not prose. Comments, CDATA sections, doctypes and processing
// instructions are also passed through untouched.
//
// Known, accepted limits (this is a text tool, not an HTML parser):
//   - a stray "<" in text that does not start a plausible tag is kept as
//     text and the scan resumes after it;
//   - phrase conversion cannot span an inline tag boundary (<b>头</b>发
//     converts as two segments) — the standard trade-off.

const RAW_TEXT_TAGS = new Set(['script', 'style']);

/** Read a tag name from a "<..." slice; returns '' for comments/doctype/etc. */
function tagNameOf(raw) {
  const m = raw.match(/^<\/?\s*([A-Za-z][A-Za-z0-9:-]*)/);
  return m ? m[1].toLowerCase() : '';
}

function isSelfClosing(raw) {
  return /\/\s*>$/.test(raw);
}

/**
 * Split an HTML string into ordered tokens:
 *   { kind: 'tag',  value } — markup, pass through untouched
 *   { kind: 'text', value } — character data, eligible for conversion
 *   { kind: 'raw',  value } — script/style content, never converted
 */
export function splitHtml(html) {
  const tokens = [];
  const n = html.length;
  let i = 0;
  let textStart = 0;
  const flushText = (end) => {
    if (end > textStart) tokens.push({ kind: 'text', value: html.slice(textStart, end) });
  };
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    // Comments and CDATA have their own terminators.
    if (html.startsWith('<!--', lt) || html.startsWith('<![CDATA[', lt)) {
      const closer = html.startsWith('<!--', lt) ? '-->' : ']]>';
      const end = html.indexOf(closer, lt + 4);
      const stop = end === -1 ? n : end + closer.length;
      flushText(lt);
      tokens.push({ kind: 'tag', value: html.slice(lt, stop) });
      i = textStart = stop;
      continue;
    }
    // A tag runs to the next '>' (attribute values containing '>' are rare
    // in EPUB XHTML and would only mis-split a text run, never corrupt).
    const gt = html.indexOf('>', lt + 1);
    if (gt === -1) break; // dangling '<' — treat the rest as text
    const raw = html.slice(lt, gt + 1);
    // Plausibility check: '<' + letter, '/', '!' or '?' starts markup;
    // anything else (e.g. "a < b") is literal text — keep scanning.
    if (!/^<[A-Za-z/!?]/.test(raw)) { i = lt + 1; continue; }
    flushText(lt);
    tokens.push({ kind: 'tag', value: raw });
    i = textStart = gt + 1;
    // Raw-text elements: swallow everything up to the matching close tag.
    const name = tagNameOf(raw);
    if (name && RAW_TEXT_TAGS.has(name) && !isSelfClosing(raw) && !/^<\//.test(raw)) {
      const closeRe = new RegExp(`</${name}\\s*>`, 'i');
      const rest = html.slice(i);
      const m = rest.match(closeRe);
      const rawEnd = m ? i + m.index : n;
      if (rawEnd > i) tokens.push({ kind: 'raw', value: html.slice(i, rawEnd) });
      if (m) {
        tokens.push({ kind: 'tag', value: m[0] });
        i = textStart = rawEnd + m[0].length;
      } else {
        i = textStart = n;
      }
    }
  }
  flushText(n);
  return tokens;
}

const HAS_HAN = /\p{Script=Han}/u;

/**
 * Convert only the TEXT runs of an HTML document.
 * `convertSeg(text)` must return Promise<string>. Segments without Han
 * characters are passed through without calling the converter (fast path
 * for the whitespace between tags in pretty-printed XHTML).
 * Returns { html, changed } — changed is true when any segment differed.
 */
export async function convertHtml(html, convertSeg) {
  const tokens = splitHtml(html);
  let changed = false;
  const parts = [];
  for (const tok of tokens) {
    if (tok.kind === 'text' && HAS_HAN.test(tok.value)) {
      const out = await convertSeg(tok.value);
      if (out !== tok.value) changed = true;
      parts.push(out);
    } else {
      parts.push(tok.value);
    }
  }
  return { html: parts.join(''), changed };
}

/** Plain text of a document: text runs only, tags dropped. */
export function extractPlainText(html) {
  return splitHtml(html)
    .filter((t) => t.kind === 'text')
    .map((t) => t.value)
    .join('');
}

/** Text runs of a document as an array (for stats / Han counting). */
export function textSegments(html) {
  return splitHtml(html)
    .filter((t) => t.kind === 'text')
    .map((t) => t.value);
}
