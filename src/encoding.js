// Encoding detection for uploaded text files.
//
// THE BUG this fixes: `file.text()` always decodes as UTF-8. Simplified
// Chinese .txt files from mainland sources / Windows Notepad are usually
// GBK/GB18030-encoded — UTF-8-decoding those bytes yields � (U+FFFD)
// mojibake throughout the converted output.
//
// Strategy: BOM first (UTF-8 / UTF-16LE / UTF-16BE); then strict UTF-8
// (fatal — valid UTF-8 is definitive); if that throws, decode as GB18030
// (a superset of GBK) and as Big5 and keep whichever scores better
// (fewer replacement chars, more common Chinese characters).
// Output downloads stay UTF-8 regardless (see main.js download handler).

const COMMON_ZH =
  '的一是不了人我有他这为之大来以个中上们到说国和地也子时道出而要于就下得可你年生自会那后能对着事其里所去行过家十用发天如然作方成者多日都三小军二无同么经法当起与好看学进种将还分此心前面又定见只主没公从';

function scoreText(text) {
  let score = 0;
  for (const ch of text) {
    if (ch === '�') score -= 20;
    else if (COMMON_ZH.includes(ch)) score += 3;
    else if (/[\u4e00-\u9fff]/.test(ch)) score += 1;
    else if (/[\u0000-\u0008\u000b-\u001f]/.test(ch)) score -= 5;
  }
  return score;
}

/**
 * Decode an ArrayBuffer of text bytes, detecting the encoding.
 * Returns { text, encoding } where encoding is a human label for the UI.
 * Never throws.
 */
export function decodeTextBytes(buf) {
  const u8 = new Uint8Array(buf);
  // BOMs
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(u8.subarray(3)), encoding: 'UTF-8 (BOM)' };
  }
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(u8), encoding: 'UTF-16 LE' };
  }
  if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(u8), encoding: 'UTF-16 BE' };
  }
  // Strict UTF-8: if it parses with zero errors, it IS UTF-8.
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(u8);
    return { text, encoding: 'UTF-8' };
  } catch {
    /* not valid UTF-8 — fall through to legacy CJK encodings */
  }
  // GB18030 (superset of GBK) vs Big5: score both, keep the better decode.
  let best = null;
  for (const [enc, label] of [['gb18030', 'GBK/GB18030'], ['big5', 'Big5']]) {
    try {
      const text = new TextDecoder(enc).decode(u8);
      const score = scoreText(text);
      if (!best || score > best.score) best = { text, encoding: label, score };
    } catch {
      /* encoding unsupported in this browser — skip */
    }
  }
  if (best) return { text: best.text, encoding: best.encoding };
  return { text: new TextDecoder().decode(u8), encoding: 'UTF-8' };
}
