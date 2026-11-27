// Conversion core — the whole pipeline in one environment-agnostic module.
// It runs inside the Web Worker normally, and on the main thread as a
// fallback (dynamic import) if the Worker cannot start. No DOM access.
//
// Job protocol (see worker.js / main.js):
//   job = { kind:'text',  text, ext, config, direction }
//       | { kind:'line',  text, config, direction }        (one-liners, e.g. filenames)
//       | { kind:'epub-inspect', buffer }
//       | { kind:'epub',  buffer, config, direction }
//   emit.progress({ done, total, unit, headPreview })
//   emit.stage('loading-engine', label) / emit.stage('engine-ready')
// Results:
//   text  -> { kind:'text', text }
//   line  -> { kind:'line', text }
//   epub-inspect -> { kind:'epub-meta', headText, totalChars, hanCount, totalDocs }
//   epub  -> { kind:'epub', blob, totalDocs, changedDocs, headPreview, totalChars }
//
// LAZY dictionaries: the engine for the chosen config/direction is loaded
// only when a job actually needs it, and the lib memoizes it afterwards.

import { warmScript, lockScriptSync, detectLang, convertWithConfig, warmConfig } from '@dawn-studio/zh-convert';
import { inspectEpub, convertEpub } from './epub-core.js';

// ---- engine ---------------------------------------------------------------

async function warmEngine({ config, direction }, emit) {
  let label;
  if (config) label = `載入緊字庫… OpenCC ${config}（只載呢個）`;
  else if (direction === 's2t') label = '載入緊字庫… 簡→繁';
  else if (direction === 't2s') label = '載入緊字庫… 繁→簡';
  else label = '載入緊字庫… 自動方向';
  const stage = emit && typeof emit.stage === 'function' ? emit.stage : null;
  if (stage) stage('loading-engine', label);
  if (config) await warmConfig(config);
  else if (direction === 's2t') await warmScript('zh-Hant');
  else if (direction === 't2s') await warmScript('zh-Hans');
  else await Promise.allSettled([warmScript('zh-Hant'), warmScript('zh-Hans')]);
  if (stage) stage('engine-ready');
}

// Tongwen path (direction control): synchronous script lock.
function segConvertSync(text, dir) {
  if (!text) return text;
  if (dir === 's2t') return lockScriptSync(text, 'zh-Hant');
  if (dir === 't2s') return lockScriptSync(text, 'zh-Hans');
  const d = detectLang(text);
  if (d === 'zh-Hans') return lockScriptSync(text, 'zh-Hant');
  if (d === 'zh-Hant') return lockScriptSync(text, 'zh-Hans');
  return text; // en/ja/ko/empty passthrough
}

function makeSegConvert({ config, direction }) {
  if (config) return async (text) => (text ? convertWithConfig(text, config) : text);
  return async (text) => segConvertSync(text, direction);
}

// ---- text pipeline ----------------------------------------------------------

const CHUNK_LINES = 500;

async function convertChunk(lines, settings) {
  if (settings.config) return convertWithConfig(lines.join('\n'), settings.config);
  return lines.map((ln) => segConvertSync(ln, settings.direction)).join('\n');
}

// Compare source vs converted text line-by-line (trailing \r ignored —
// the subtitle converters split on /\r?\n/ and re-join with '\n').
// Returns the 0-based indices of changed lines, or null when the line
// counts differ and no meaningful per-line alignment exists (JSON).
function diffLineIndices(srcText, outText) {
  const a = srcText.split('\n');
  const b = outText.split('\n');
  if (a.length !== b.length) return null;
  const idx = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i].replace(/\r$/, '') !== b[i].replace(/\r$/, '')) idx.push(i);
  }
  return idx;
}

// Returns { text, changedLines } — changedLines are 0-based indices into
// text.split('\n'), computed per chunk as conversion proceeds (the
// conversion is line-preserving, so comparing chunk in/out is exact and
// costs almost nothing even on a 50k-line novel).
async function lineConvert(text, settings, onProgress) {
  const lines = text.split('\n');
  const total = lines.length;
  const chunks = [];
  const changedLines = [];
  let headPreview = '';
  for (let i = 0; i < lines.length; i += CHUNK_LINES) {
    const inChunk = lines.slice(i, i + CHUNK_LINES);
    const outChunk = await convertChunk(inChunk, settings);
    chunks.push(outChunk);
    const outLines = outChunk.split('\n');
    if (outLines.length === inChunk.length) {
      for (let j = 0; j < inChunk.length; j++) {
        if (outLines[j] !== inChunk[j]) changedLines.push(i + j);
      }
    } else if (outChunk !== inChunk.join('\n')) {
      // Line count changed (converters never touch '\n', so this is a
      // belt-and-braces fallback): mark the whole chunk as changed.
      for (let j = 0; j < inChunk.length; j++) changedLines.push(i + j);
    }
    if (!headPreview) headPreview = chunks[0].split('\n').slice(0, 12).join('\n');
    if (onProgress) onProgress({ done: Math.min(i + CHUNK_LINES, total), total, unit: '行', headPreview });
  }
  return { text: chunks.join('\n'), changedLines };
}

// Format-aware converters: only human text, never timestamps/tags.
async function convertSrt(text, seg, onProgress) {
  const total = text.split(/\r?\n/).length;
  const blocks = text.split(/\r?\n\r?\n/);
  const out = [];
  let lineNo = 0;
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    lineNo += lines.length + 1;
    if (lines.length >= 3 && /^\d+$/.test(lines[0].trim()) && /-->/.test(lines[1])) {
      const head = lines.slice(0, 2).join('\n');
      const body = [];
      for (const ln of lines.slice(2)) body.push(await seg(ln));
      out.push(head + '\n' + body.join('\n'));
    } else {
      out.push(block);
    }
    if (out.length % 100 === 0 && onProgress) {
      onProgress({ done: Math.min(lineNo, total), total, unit: '行', headPreview: out.slice(0, 4).join('\n\n') });
    }
  }
  return out.join('\n\n');
}

async function convertVtt(text, seg, onProgress) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const t = ln.trim();
    if (!t || /^WEBVTT/i.test(t) || /-->/.test(t) || /^(NOTE|STYLE|REGION)/.test(t) || /^\d{2}:\d{2}/.test(t)) {
      out.push(ln);
    } else {
      out.push(await seg(ln));
    }
    if (i % 100 === 99 && onProgress) onProgress({ done: i + 1, total: lines.length, unit: '行', headPreview: out.slice(0, 12).join('\n') });
  }
  return out.join('\n');
}

async function convertLrc(text, seg, onProgress) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const m = ln.match(/^((?:\[[^\]]+\])+)(.*)$/);
    if (!m) out.push(await seg(ln));
    else out.push(m[1] + (await seg(m[2])));
    if (i % 100 === 99 && onProgress) onProgress({ done: i + 1, total: lines.length, unit: '行', headPreview: out.slice(0, 12).join('\n') });
  }
  return out.join('\n');
}

async function convertAss(text, seg, onProgress) {
  const allLines = text.split(/\r?\n/);
  const out = [];
  for (let li = 0; li < allLines.length; li++) {
    const ln = allLines[li];
    if (li % 100 === 99 && onProgress) onProgress({ done: li + 1, total: allLines.length, unit: '行', headPreview: out.slice(0, 12).join('\n') });
    if (!/^Dialogue:/.test(ln)) { out.push(ln); continue; }
    // Dialogue: Layer, Start, End, Style, Name, ML, MR, MV, Effect, Text
    let commas = 0, idx = -1;
    for (let i = 0; i < ln.length; i++) {
      if (ln[i] === ',') { commas++; if (commas === 9) { idx = i; break; } }
    }
    if (idx < 0) { out.push(ln); continue; }
    const head = ln.slice(0, idx + 1);
    const textPart = ln.slice(idx + 1);
    // keep {\...} override tags unconverted (ASCII anyway, but stay safe)
    const parts = textPart.split(/(\{[^}]*\})/g);
    const conv = [];
    for (const p of parts) conv.push(/^\{[^}]*\}$/.test(p) ? p : await seg(p));
    out.push(head + conv.join(''));
  }
  return out.join('\n');
}

async function convertJson(text, settings, onProgress) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return lineConvert(text, settings, onProgress);
  }
  // Progress in converted string characters (JSON has no meaningful "lines").
  let totalChars = 0;
  const countWalk = (v) => {
    if (typeof v === 'string') totalChars += v.length;
    else if (Array.isArray(v)) v.forEach(countWalk);
    else if (v && typeof v === 'object') Object.values(v).forEach(countWalk);
  };
  countWalk(obj);
  let doneChars = 0;
  const walk = async (v) => {
    if (typeof v === 'string') {
      const r = await lineConvert(v, settings, null);
      doneChars += v.length;
      if (onProgress) onProgress({ done: doneChars, total: Math.max(totalChars, 1), unit: '字', headPreview: '' });
      return r.text;
    }
    if (Array.isArray(v)) {
      const arr = [];
      for (const item of v) arr.push(await walk(item));
      return arr;
    }
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = await walk(v[k]);
      return o;
    }
    return v;
  };
  // Pretty-printed JSON has no source-line alignment — changedLines: null
  // tells the UI there is no per-line diff to show for this result.
  return { text: JSON.stringify(await walk(obj), null, 2), changedLines: null };
}

// All text converters return { text, changedLines } — changedLines is an
// array of 0-based changed line indices, or null when not meaningful.
async function convertTextByExt(text, ext, settings, onProgress) {
  const seg = makeSegConvert(settings);
  switch (ext) {
    case '.srt':
    case '.vtt':
    case '.lrc':
    case '.ass':
    case '.ssa': {
      const convert = { '.srt': convertSrt, '.vtt': convertVtt, '.lrc': convertLrc, '.ass': convertAss, '.ssa': convertAss }[ext];
      const out = await convert(text, seg, onProgress);
      return { text: out, changedLines: diffLineIndices(text, out) };
    }
    case '.json': return convertJson(text, settings, onProgress);
    default: return lineConvert(text, settings, onProgress); // .txt .md .csv .tsv .text
  }
}

// ---- job processor -----------------------------------------------------------

export async function processJob(job, emit = {}) {
  const onProgress = typeof emit.progress === 'function' ? emit.progress : null;
  const settings = { config: job.config ?? '', direction: job.direction ?? 'auto' };

  switch (job.kind) {
    case 'line': {
      await warmEngine(settings, emit);
      const seg = makeSegConvert(settings);
      return { kind: 'line', text: await seg(job.text || '') };
    }
    case 'text': {
      await warmEngine(settings, emit);
      const r = await convertTextByExt(job.text || '', job.ext || '.txt', settings, onProgress);
      return { kind: 'text', text: r.text, changedLines: r.changedLines };
    }
    case 'epub-inspect': {
      const meta = await inspectEpub(job.buffer);
      return { kind: 'epub-meta', ...meta };
    }
    case 'epub': {
      await warmEngine(settings, emit);
      const seg = makeSegConvert(settings);
      const res = await convertEpub(job.buffer, {
        convertSeg: seg,
        onProgress: onProgress
          ? (done, total, headPreview) => onProgress({ done, total, unit: '個文件', headPreview })
          : null
      });
      const blob = await res.zip.generateAsync({ type: 'blob' });
      return {
        kind: 'epub',
        blob,
        totalDocs: res.totalDocs,
        changedDocs: res.changedDocs,
        docChanges: res.docChanges,
        headPreview: res.headPreview,
        totalChars: res.totalChars
      };
    }
    default:
      throw new Error('未知嘅 job 類型：' + job.kind);
  }
}
