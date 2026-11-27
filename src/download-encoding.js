// Download encodings for TEXT results (single download, paste mode and the
// text files inside a batch zip). EPUB downloads never come through here —
// EPUB is always UTF-8 inside.
//
//   'utf8'     plain UTF-8 (TextEncoder)
//   'utf8-bom' UTF-8 with an EF BB BF prefix (for tools that need the BOM
//              to recognise UTF-8, e.g. some Windows editors)
//   'gb18030'  GBK family — iconv-lite 'gb18030'
//   'big5'     Big5 — iconv-lite 'big5'
//
// iconv-lite is loaded LAZILY via dynamic import: it only lands when the
// user actually picks GBK/Big5, never in the eager path. Characters the
// target encoding cannot represent become '?' (iconv-lite default) — the
// UI says so next to the picker.

export const DOWNLOAD_ENCODINGS = ['utf8', 'utf8-bom', 'gb18030', 'big5'];

let iconvPromise = null;
function loadIconv() {
  if (!iconvPromise) {
    iconvPromise = (async () => {
      // iconv-lite (via safer-buffer) references the 'buffer' module; make
      // sure a Buffer global exists in the browser before it evaluates.
      const [{ default: iconv }, bufferMod] = await Promise.all([
        import('iconv-lite'),
        import('buffer')
      ]);
      const Buf = bufferMod && bufferMod.Buffer;
      if (Buf && typeof globalThis.Buffer === 'undefined') globalThis.Buffer = Buf;
      return iconv;
    })();
  }
  return iconvPromise;
}

/**
 * Encode `text` for download. Returns a Uint8Array of the exact bytes to
 * put in the Blob / zip entry.
 */
export async function encodeTextBytes(text, encoding) {
  const enc = DOWNLOAD_ENCODINGS.includes(encoding) ? encoding : 'utf8';
  if (enc === 'utf8') return new TextEncoder().encode(text);
  if (enc === 'utf8-bom') {
    const body = new TextEncoder().encode(text);
    const out = new Uint8Array(body.length + 3);
    out[0] = 0xef; out[1] = 0xbb; out[2] = 0xbf;
    out.set(body, 3);
    return out;
  }
  const iconv = await loadIconv();
  const buf = iconv.encode(text, enc); // 'gb18030' | 'big5'
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Convenience: encoded bytes wrapped as a text/plain Blob. */
export async function encodeTextBlob(text, encoding) {
  const bytes = await encodeTextBytes(text, encoding);
  return new Blob([bytes], { type: 'text/plain;charset=utf-8' });
}
