// ZhConvert main thread: UI, file reading, encoding detection, progress,
// preview, alerts, downloads — and nothing else. ALL conversion runs
// through runJob(), which talks to the Web Worker (src/worker.js) and
// falls back to running src/convert-core.js on this thread if the Worker
// cannot start or dies. The zh-convert dictionaries are never imported
// here anymore (the filename one-liner goes through a 'line' job too).

import { decodeTextBytes } from './encoding.js';
import { encodeTextBlob, DOWNLOAD_ENCODINGS } from './download-encoding.js';
import { uniqueZipName } from './batch-utils.js';

const $ = (id) => document.getElementById(id);
const input = $('input'), output = $('output');
const inCount = $('inCount'), outCount = $('outCount');
const libStatus = $('libStatus'), filenameEl = $('filename'), encodingEl = $('encoding');
const configSel = $('config');
const encodingSel = $('encodingSel');
const batchEl = $('batch'), batchListEl = $('batchList'), batchSummaryEl = $('batchSummary');
const downloadZipBtn = $('downloadZip');
const progressEl = $('progress'), progressText = $('progressText'), progressPct = $('progressPct');
const progressFill = $('progressFill'), spinnerEl = $('spinner');
const outStats = $('outStats');

// ---- remembered settings ----------------------------------------------------
// localStorage: zhconvert:config / zhconvert:direction. Restored at boot
// WITHOUT loading any dictionary (lazy principle unchanged); every change
// is saved immediately. All access is try/catch — private mode must not
// kill the app.
const SETTINGS_KEYS = { config: 'zhconvert:config', direction: 'zhconvert:direction', encoding: 'zhconvert:encoding', theme: 'zhconvert:theme' };
function loadSetting(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function saveSetting(key, value) {
  try { window.localStorage.setItem(key, value); } catch { /* private mode */ }
}

// ---- theme (dark / light / system; first visit defaults to dark) ------------
// data-theme on <html> is the single theme mechanism; the inline script in
// index.html already applied the saved preference (or the dark default)
// before first paint. Here we only sync state and wire the header toggle,
// which cycles dark → light → system and persists every change.
const THEME_ORDER = ['dark', 'light', 'system'];
const THEME_LABELS = { dark: '深色', light: '淺色', system: '跟系統' };
let theme = loadSetting(SETTINGS_KEYS.theme);
if (!THEME_ORDER.includes(theme)) theme = 'dark';
const themeBtn = $('themeToggle');
function paintTheme() {
  document.documentElement.dataset.theme = theme;
  if (themeBtn) {
    themeBtn.textContent = '主題：' + THEME_LABELS[theme];
    themeBtn.setAttribute('aria-label', '切換主題（目前：' + THEME_LABELS[theme] + '）');
  }
}
if (themeBtn) {
  themeBtn.addEventListener('click', () => {
    theme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
    saveSetting(SETTINGS_KEYS.theme, theme);
    paintTheme();
  });
}
paintTheme();

let direction = 'auto';
{
  const saved = loadSetting(SETTINGS_KEYS.direction);
  if (saved === 'auto' || saved === 's2t' || saved === 't2s') direction = saved;
}

// The OpenCC config chosen in the picker ('' = follow the direction
// segment control with the default tongwen engine). Restored from
// localStorage when it is still one of the offered values.
let openccConfig = '';
if (configSel) {
  const saved = loadSetting(SETTINGS_KEYS.config);
  if (saved !== null && [...configSel.options].some((o) => o.value === saved)) {
    configSel.value = saved;
  }
  openccConfig = configSel.value;
}

document.querySelectorAll('.seg button').forEach((b) => {
  b.classList.toggle('on', b.dataset.dir === direction);
  b.addEventListener('click', () => {
    document.querySelectorAll('.seg button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    direction = b.dataset.dir;
    saveSetting(SETTINGS_KEYS.direction, direction);
  });
});
if (configSel) {
  configSel.addEventListener('change', () => {
    openccConfig = configSel.value; // no warming here — lazy means lazy
    saveSetting(SETTINGS_KEYS.config, openccConfig);
  });
}

// Download encoding (text downloads only; EPUB is always UTF-8). Also
// remembered across visits, same lazy/try-catch pattern.
let downloadEncoding = 'utf8';
if (encodingSel) {
  const savedEnc = loadSetting(SETTINGS_KEYS.encoding);
  if (savedEnc !== null && DOWNLOAD_ENCODINGS.includes(savedEnc)
      && [...encodingSel.options].some((o) => o.value === savedEnc)) {
    encodingSel.value = savedEnc;
  }
  downloadEncoding = encodingSel.value;
  encodingSel.addEventListener('change', () => {
    downloadEncoding = encodingSel.value;
    saveSetting(SETTINGS_KEYS.encoding, downloadEncoding);
  });
}

// ---- worker RPC ---------------------------------------------------------------
// Jobs are defined in convert-core.js (processJob). The worker wraps it;
// if anything about the worker fails, the same core is imported here and
// run on the main thread instead — the site never hard-dies.
let worker = null;
let workerBroken = false;
let jobSeq = 0;
const pendingJobs = new Map();
let coreModulePromise = null;

function getWorker() {
  if (worker || workerBroken) return worker;
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const msg = e.data || {};
      const entry = pendingJobs.get(msg.id);
      if (!entry) return;
      if (msg.type === 'progress') {
        if (entry.handlers.onProgress) {
          entry.handlers.onProgress({ done: msg.done, total: msg.total, unit: msg.unit, headPreview: msg.headPreview });
        }
      } else if (msg.type === 'stage') {
        if (entry.handlers.onStage) entry.handlers.onStage(msg.stage, msg.label);
      } else if (msg.type === 'done') {
        pendingJobs.delete(msg.id);
        entry.resolve(msg.result);
      } else if (msg.type === 'error') {
        pendingJobs.delete(msg.id);
        entry.reject(new Error(msg.message || 'Worker 出錯'));
      }
    };
    worker.onerror = () => {
      workerBroken = true;
      try { worker.terminate(); } catch { /* already gone */ }
      worker = null;
      for (const [, entry] of pendingJobs) entry.reject(new Error('Worker 出錯'));
      pendingJobs.clear();
    };
  } catch {
    workerBroken = true;
    worker = null;
  }
  return worker;
}

function runWorkerJob(job, handlers, transferBuffer) {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    if (!w) { reject(new Error('Worker 起唔到')); return; }
    const id = ++jobSeq;
    pendingJobs.set(id, { resolve, reject, handlers });
    let wireJob = job;
    let transfer = [];
    if (transferBuffer && job.buffer instanceof ArrayBuffer) {
      // Transfer a COPY — the caller's buffer stays valid for fallback.
      const copy = job.buffer.slice(0);
      wireJob = { ...job, buffer: copy };
      transfer = [copy];
    }
    try {
      w.postMessage({ id, job: wireJob }, transfer);
    } catch (err) {
      pendingJobs.delete(id);
      reject(err);
    }
  });
}

async function runCoreJob(job, handlers) {
  if (!coreModulePromise) coreModulePromise = import('./convert-core.js');
  const core = await coreModulePromise;
  return core.processJob(job, {
    progress: handlers.onProgress || null,
    stage: handlers.onStage || (() => {})
  });
}

/**
 * Run a conversion job. handlers: { onProgress({done,total,unit,headPreview}),
 * onStage(stage, label) }. transfer=true moves a copy of job.buffer to the
 * worker (the original stays usable for the fallback path).
 */
async function runJob(job, handlers = {}, transfer = false) {
  if (!workerBroken) {
    try {
      return await runWorkerJob(job, handlers, transfer);
    } catch {
      workerBroken = true; // fall through to the main-thread core
    }
  }
  return runCoreJob(job, handlers);
}

// Stage events from the core: dictionary loading is reported, never silent.
function stageHandler({ quiet = false } = {}) {
  return (stage, label) => {
    if (stage === 'loading-engine') {
      if (!quiet) setProgress(label, null);
    } else if (stage === 'engine-ready') {
      libStatus.textContent = '字庫 ready ✓（已懶載入）';
    }
  };
}

// ---- progress / busy state ----------------------------------------------------
let busy = false;
const tick = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

function setProgress(label, pct) {
  progressEl.hidden = false;
  progressEl.classList.remove('done');
  progressEl.classList.remove('alertbox');
  spinnerEl.classList.remove('done');
  spinnerEl.classList.remove('error');
  spinnerEl.classList.remove('alert');
  progressText.textContent = label;
  const bar = progressFill.parentElement;
  if (pct == null) { // indeterminate stage (reading / decoding / loading dicts)
    bar.classList.add('indet');
    progressFill.style.width = '';
    progressPct.textContent = '';
  } else {
    bar.classList.remove('indet');
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    progressFill.style.width = p + '%';
    progressPct.textContent = p + '%';
  }
}

function setDone(label) {
  progressEl.hidden = false;
  progressEl.classList.add('done');
  progressEl.classList.remove('alertbox');
  spinnerEl.classList.remove('error');
  spinnerEl.classList.remove('alert');
  spinnerEl.classList.add('done');
  progressText.textContent = label;
  progressFill.parentElement.classList.remove('indet');
  progressFill.style.width = '100%';
  progressPct.textContent = '100%';
}

function setProgressError(label) {
  progressEl.hidden = false;
  progressEl.classList.remove('done');
  progressEl.classList.remove('alertbox');
  spinnerEl.classList.remove('done');
  spinnerEl.classList.remove('alert');
  spinnerEl.classList.add('error');
  progressText.textContent = label;
  progressFill.parentElement.classList.remove('indet');
}

// In-page ⚠ banner in the progress card (no native dialog) — used by
// batch mode, where per-file native alerts would be a mess.
function showInfoBanner(bannerText) {
  progressEl.hidden = false;
  progressEl.classList.remove('done');
  progressEl.classList.add('alertbox');
  spinnerEl.classList.remove('done');
  spinnerEl.classList.remove('error');
  spinnerEl.classList.add('alert');
  progressText.textContent = bannerText;
  progressFill.parentElement.classList.remove('indet');
  progressFill.style.width = '0%';
  progressPct.textContent = '';
}

// Empty / nothing-to-do: STOP processing and make sure the user notices —
// a persistent in-page banner AND a native alert dialog.
function alertNothingToDo(bannerText, dialogText) {
  showInfoBanner(bannerText);
  alert(dialogText);
}

const HAS_HAN = /\p{Script=Han}/u;

// ---- text / result state ------------------------------------------------------
// Full text lives in MEMORY, never in the panes (million-char textareas
// were the lag). resultPayload is what 下載/複製 use:
//   { kind:'text', text, chars } | { kind:'epub', blob, chars, docs }
let sourceText = '';
let resultPayload = null;
let fileMode = false;
let currentExt = '.txt';
let epubFile = null; // { buffer, name } — retained so config changes can re-convert
let epubMeta = null;

const firstDozen = (t) => {
  const head = t.split('\n').slice(0, 12).join('\n');
  return head.length > 4000 ? head.slice(0, 4000) + '\n…' : head;
};

function refreshActions() {
  const copyBtn = $('copy');
  const isEpub = resultPayload && resultPayload.kind === 'epub';
  copyBtn.disabled = busy || !!isEpub;
  copyBtn.title = isEpub ? 'EPUB 冇全文複製，請用下載' : '';
  $('download').disabled = busy || !resultPayload;
}

function setBusy(on) {
  busy = on;
  for (const id of ['convert', 'clear']) {
    const b = $(id);
    if (b) b.disabled = on;
  }
  const f = $('file');
  if (f) f.disabled = on;
  if (configSel) configSel.disabled = on;
  if (encodingSel) encodingSel.disabled = on;
  refreshActions();
}

function sourceChars() {
  if (fileMode && epubFile) return epubMeta ? epubMeta.totalChars : 0;
  return fileMode ? sourceText.length : input.value.length;
}

function updateCounts() {
  inCount.textContent = `${sourceChars()} 字`;
  outCount.textContent = `${resultPayload ? resultPayload.chars : output.value.length} 字`;
}
input.addEventListener('input', () => {
  // The user typing/pasting takes over from any uploaded file.
  fileMode = false;
  epubFile = null;
  epubMeta = null;
  sourceText = input.value;
  resultPayload = null;
  hideDiff();
  refreshActions();
  updateCounts();
});

// LAZY dictionaries: nothing loads at boot, nothing loads when settings
// change — only the chosen engine, at conversion time, inside the core.
libStatus.textContent = '字庫懶載入 · 轉換嗰陣先載入要用嗰個';

// ---- result stats ---------------------------------------------------------------
function setOutStats(src, out) {
  const srcLines = src.split('\n');
  const outLines = out.split('\n');
  const n = Math.min(srcLines.length, outLines.length);
  let changed = 0;
  for (let i = 0; i < n; i++) if (srcLines[i] !== outLines[i]) changed++;
  outStats.textContent = `共 ${outLines.length} 行 · ${changed} 行有變動 · ${src.length} 字 → ${out.length} 字 · 輸出框只顯示頭 12 行預覽，下載／複製係全文`;
}

// ---- diff report ---------------------------------------------------------
// A collapsed <details> under the stats line: WHICH lines (or, for EPUB,
// which documents) changed. The core reports changed line indices with
// the conversion result, so this costs almost nothing even at 50k lines;
// the DOM list is rendered LAZILY on first expand and capped at 200 rows.
const diffBox = $('diffBox'), diffSummary = $('diffSummary'), diffList = $('diffList');
let lastDiff = null; // { kind:'text', changedLines } | { kind:'epub', docChanges }
let lastDiffRendered = false;

function hideDiff() {
  lastDiff = null;
  lastDiffRendered = false;
  if (diffBox) { diffBox.hidden = true; diffBox.open = false; diffList.innerHTML = ''; }
}

function setTextDiff(changedLines, src, out) {
  let idx = changedLines;
  if (idx == null) {
    // No per-line info from the core (e.g. pretty-printed JSON): fall back
    // to an aligned comparison when the line counts happen to match.
    const a = src.split('\n'), b = out.split('\n');
    if (a.length === b.length) {
      idx = [];
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) idx.push(i);
    }
  }
  if (!idx || idx.length === 0 || !diffBox) { hideDiff(); return; }
  lastDiff = { kind: 'text', changedLines: idx };
  lastDiffRendered = false;
  diffSummary.textContent = `變動明細（${idx.length} 行）`;
  diffList.innerHTML = '';
  diffBox.hidden = false;
  diffBox.open = false;
}

function setEpubDiff(docChanges) {
  if (!docChanges || !docChanges.length || !diffBox) { hideDiff(); return; }
  const changed = docChanges.filter((d) => d.changed).length;
  lastDiff = { kind: 'epub', docChanges };
  lastDiffRendered = false;
  diffSummary.textContent = `變動明細（${changed} / ${docChanges.length} 個文件有變動）`;
  diffList.innerHTML = '';
  diffBox.hidden = false;
  diffBox.open = false;
}

const truncLine = (s) => (s.length > 120 ? s.slice(0, 120) + '…' : s);

function renderDiff() {
  if (!lastDiff || lastDiffRendered) return;
  lastDiffRendered = true;
  const frag = document.createDocumentFragment();
  if (lastDiff.kind === 'text') {
    // Lines are sliced from the in-memory full texts at render time —
    // nothing per-line is materialised before the user expands the box.
    const srcLines = sourceText.split('\n');
    const outLines = resultPayload && resultPayload.kind === 'text' ? resultPayload.text.split('\n') : [];
    const MAX = 200;
    for (const i of lastDiff.changedLines.slice(0, MAX)) {
      const row = document.createElement('div');
      row.className = 'diffrow';
      const ln = document.createElement('span'); ln.className = 'ln'; ln.textContent = `#${i + 1} `;
      const oldS = document.createElement('span'); oldS.className = 'old'; oldS.textContent = truncLine(srcLines[i] ?? '');
      const newS = document.createElement('span'); newS.className = 'new'; newS.textContent = truncLine(outLines[i] ?? '');
      row.append(ln, oldS, document.createTextNode(' → '), newS);
      frag.append(row);
    }
    if (lastDiff.changedLines.length > MAX) {
      const more = document.createElement('div');
      more.className = 'diffmore';
      more.textContent = `…仲有 ${lastDiff.changedLines.length - MAX} 行變動未顯示`;
      frag.append(more);
    }
  } else {
    for (const d of lastDiff.docChanges) {
      const row = document.createElement('div');
      row.className = 'diffrow';
      row.textContent = `📄 ${d.name} — ${d.changed ? '有變動' : '冇變動'}`;
      frag.append(row);
    }
  }
  diffList.append(frag);
}
if (diffBox) diffBox.addEventListener('toggle', () => { if (diffBox.open) renderDiff(); });

// ---- conversion flows -------------------------------------------------------------

function progressHandler(prefix) {
  return ({ done, total, unit, headPreview }) => {
    if (headPreview && output.value !== headPreview) output.value = headPreview;
    setProgress(`${prefix} ${done} / ${total} ${unit}`, total ? (done / total) * 100 : null);
  };
}

async function doConvert() {
  if (busy) return;
  if (fileMode && epubFile) return convertEpubCurrent();
  hideDiff();
  if (!fileMode) sourceText = input.value; // paste mode: the pane is the source
  const src = sourceText;
  if (!src.trim()) {
    output.value = ''; resultPayload = null; refreshActions(); updateCounts();
    alertNothingToDo('⚠ 冇內容：輸入係空嘅，冇嘢可以轉換，已停止處理。', '冇內容可以轉換（輸入係空嘅），已停止處理。');
    return;
  }
  if (!HAS_HAN.test(src)) {
    alertNothingToDo('⚠ 冇嘢要做：內容入面冇中文字，唔需要轉換，已停止處理。', '內容入面冇中文字，冇嘢需要轉換，已停止處理。');
    return;
  }
  setBusy(true);
  try {
    output.value = '';
    resultPayload = null;
    outStats.textContent = '';
    refreshActions();
    updateCounts();
    setProgress('準備轉換…', null);
    await tick(); // paint the spinner BEFORE the heavy work starts
    const res = await runJob(
      { kind: 'text', text: src, ext: currentExt, config: openccConfig, direction },
      { onProgress: progressHandler('轉換中…'), onStage: stageHandler() }
    );
    const out = res.text;
    if (out === src) {
      // Nothing to do: the content is ALREADY in the target script.
      output.value = '';
      resultPayload = null;
      refreshActions();
      updateCounts();
      alertNothingToDo('⚠ 冇嘢要做：內容已經係目標文字（轉換前後完全一樣），已停止處理。', '冇嘢需要轉換：內容已經係目標文字，已停止處理。');
      return;
    }
    resultPayload = { kind: 'text', text: out, chars: out.length };
    output.value = firstDozen(out);
    updateCounts();
    setOutStats(src, out);
    setTextDiff(res.changedLines, src, out);
    setDone(`轉換完成 ✓ 輸出框顯示頭 12 行預覽，一 click「下載」攞全文（檔名都會轉埋）`);
  } catch (e) {
    setProgressError('轉換出錯：' + (e && e.message ? e.message : e));
  } finally {
    setBusy(false);
  }
}

async function convertEpubCurrent() {
  if (!epubFile) return;
  hideDiff();
  setBusy(true);
  try {
    output.value = '';
    resultPayload = null;
    outStats.textContent = '';
    refreshActions();
    updateCounts();
    setProgress('準備轉換 EPUB…', null);
    await tick();
    const res = await runJob(
      { kind: 'epub', buffer: epubFile.buffer.slice(0), config: openccConfig, direction },
      { onProgress: progressHandler('轉換緊 EPUB…'), onStage: stageHandler() },
      true
    );
    if (res.changedDocs === 0) {
      // Nothing to do: every document came back identical.
      output.value = '';
      resultPayload = null;
      refreshActions();
      updateCounts();
      alertNothingToDo('⚠ 冇嘢要做：呢本 EPUB 已經係目標文字（轉換前後完全一樣），已停止處理。', '冇嘢需要轉換：呢本 EPUB 已經係目標文字，已停止處理。');
      return;
    }
    resultPayload = { kind: 'epub', blob: res.blob, chars: res.totalChars, docs: res.totalDocs };
    output.value = firstDozen(res.headPreview || '');
    updateCounts();
    outStats.textContent = `EPUB · 共 ${res.totalDocs} 個文件 · ${res.changedDocs} 個有變動 · 全文約 ${res.totalChars} 字 · 輸出框只顯示頭 12 行預覽，下載攞返成書`;
    setEpubDiff(res.docChanges);
    setDone(`轉換完成 ✓ 輸出框顯示頭 12 行預覽，一 click「下載」攞返成書（檔名都會轉埋）`);
  } catch (e) {
    setProgressError('EPUB 轉換出錯：' + (e && e.message ? e.message : e));
  } finally {
    setBusy(false);
  }
}
$('convert').addEventListener('click', doConvert);
$('clear').addEventListener('click', () => {
  input.value = ''; output.value = ''; filenameEl.textContent = ''; encodingEl.textContent = ''; outStats.textContent = ''; currentExt = '.txt';
  sourceText = ''; resultPayload = null; fileMode = false; epubFile = null; epubMeta = null;
  hideDiff();
  // Batch list goes too — 清空 means a clean slate.
  batchItems = [];
  if (batchEl) batchEl.hidden = true;
  if (batchListEl) batchListEl.innerHTML = '';
  if (batchSummaryEl) batchSummaryEl.textContent = '';
  refreshActions();
  updateCounts();
  progressEl.hidden = true;
});

async function copyAll(btn) {
  if (!resultPayload || resultPayload.kind !== 'text') return; // EPUB has no full-text copy
  await navigator.clipboard.writeText(resultPayload.text);
  const old = btn.textContent;
  btn.textContent = '已複製全文 ✓';
  setTimeout(() => (btn.textContent = old), 1200);
}

async function downloadAll() {
  if (!resultPayload) return;
  // The FILENAME is converted too (same config/direction as the content),
  // via a one-line job — the main thread never loads a dictionary itself.
  const rawBase = (filenameEl.textContent || 'zhconvert').replace(/^📄\s*/, '').replace(/\.[a-z0-9]+$/i, '');
  let base = rawBase;
  try {
    const r = await runJob(
      { kind: 'line', text: rawBase, config: openccConfig, direction },
      { onStage: stageHandler({ quiet: true }) }
    );
    if (r && r.text) base = r.text;
  } catch { /* keep the original name */ }
  base = (base || rawBase).replace(/[\\/:*?"<>|]/g, '_').trim() || 'zhconvert';
  let blob;
  let ext;
  if (resultPayload.kind === 'epub') {
    blob = resultPayload.blob;
    ext = '.epub';
  } else {
    // Text downloads use the encoding picked in the 下載編碼 control:
    // UTF-8 by default, UTF-8 BOM / GBK (GB18030) / Big5 on request.
    // (The source encoding was decoded correctly on the way in, so no
    // mojibake travels forward regardless of the output choice.)
    blob = await encodeTextBlob(resultPayload.text, downloadEncoding);
    ext = currentExt;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = base + '-converted' + ext;
  a.click();
  URL.revokeObjectURL(a.href);
}
$('copy').addEventListener('click', (e) => copyAll(e.currentTarget));
$('download').addEventListener('click', downloadAll);

// ---- file handling ----
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ACCEPT_EXTS = ['.txt', '.text', '.md', '.markdown', '.srt', '.vtt', '.lrc', '.ass', '.ssa', '.json', '.csv', '.tsv', '.epub'];
function extOf(name) {
  const m = name.toLowerCase().match(/(\.[a-z0-9]+)$/);
  return m ? m[1] : '.txt';
}

async function handleEpubFile(file) {
  hideDiff();
  setBusy(true);
  outStats.textContent = '';
  try {
    setProgress(`讀取檔案中… ${file.name}（${(file.size / 1024).toFixed(1)} KB）`, null);
    await tick();
    const buf = await file.arrayBuffer();
    epubFile = { buffer: buf, name: file.name };
    epubMeta = null;
    fileMode = true;
    filenameEl.textContent = '📄 ' + file.name;
    encodingEl.textContent = 'EPUB 電子書';
    setProgress('解包緊 EPUB… 睇下本書入面有咩', null);
    await tick();
    const meta = await runJob(
      { kind: 'epub-inspect', buffer: buf.slice(0) },
      {},
      true
    );
    epubMeta = meta;
    if (!meta.totalChars || !meta.headText.trim()) {
      // Empty book: alert + STOP.
      input.value = ''; output.value = ''; resultPayload = null; refreshActions(); updateCounts();
      setBusy(false);
      alertNothingToDo(`⚠ 呢本 EPUB 冇文字內容：「${file.name}」係一本空書，冇嘢可以轉換，已停止處理。`, `EPUB「${file.name}」冇文字內容，冇嘢可以轉換，已停止處理。`);
      return;
    }
    // Show the book's first lines immediately (the upload landed).
    input.value = firstDozen(meta.headText);
    output.value = '';
    resultPayload = null;
    refreshActions();
    updateCounts();
    if (!meta.hanCount) {
      // Nothing to do in this book at all (no Chinese characters).
      setBusy(false);
      alertNothingToDo(`⚠ 冇嘢要做：「${file.name}」入面冇中文字，唔需要轉換，已停止處理。`, `EPUB「${file.name}」入面冇中文字，冇嘢需要轉換，已停止處理。`);
      return;
    }
    setBusy(false); // convertEpubCurrent manages its own busy/progress
    await convertEpubCurrent();
  } catch (e) {
    setBusy(false);
    // REAL error, shown verbatim (e.g. the DRM message from epub-core).
    setProgressError(e && e.message ? e.message : String(e));
  }
}

async function handleFile(file) {
  if (!file || busy) return;
  if (file.size > MAX_FILE_BYTES) { alert('檔案太大（限 20MB）'); return; }
  const ext = extOf(file.name);
  if (!ACCEPT_EXTS.includes(ext)) { alert('唔支援呢個格式：' + ext); return; }
  currentExt = ext === '.markdown' ? '.md' : ext;
  if (ext === '.epub') return handleEpubFile(file);
  epubFile = null;
  epubMeta = null;
  hideDiff();
  setBusy(true);
  outStats.textContent = '';
  try {
    setProgress(`讀取檔案中… ${file.name}（${(file.size / 1024).toFixed(1)} KB）`, null);
    await tick();
    const buf = await file.arrayBuffer();
    setProgress('解碼中… 偵測緊編碼（UTF-8 / GBK / Big5）', null);
    await tick();
    // Decode by DETECTED encoding — file.text() would force UTF-8 and turn
    // GBK/GB18030 (and Big5) files into � mojibake.
    const { text, encoding } = decodeTextBytes(buf);
    filenameEl.textContent = '📄 ' + file.name;
    encodingEl.textContent = '偵測編碼：' + encoding;
    if (!text.trim()) {
      // Empty file: alert + STOP — no conversion, no preview.
      input.value = ''; output.value = ''; sourceText = ''; resultPayload = null; fileMode = false; refreshActions(); updateCounts();
      setBusy(false);
      alertNothingToDo(`⚠ 檔案係空嘅：「${file.name}」冇任何文字內容，冇嘢可以轉換，已停止處理。`, `檔案「${file.name}」係空嘅，冇嘢可以轉換，已停止處理。`);
      return;
    }
    if (!HAS_HAN.test(text)) {
      // Nothing to do in this file at all (no Chinese characters).
      sourceText = text; fileMode = true; resultPayload = null;
      input.value = firstDozen(text); output.value = ''; refreshActions(); updateCounts();
      setBusy(false);
      alertNothingToDo(`⚠ 冇嘢要做：「${file.name}」入面冇中文字，唔需要轉換，已停止處理。`, `檔案「${file.name}」入面冇中文字，冇嘢需要轉換，已停止處理。`);
      return;
    }
    // Keep the FULL text in memory; the input pane shows only the first
    // dozen lines as a preview (a million-char textarea is the lag).
    sourceText = text;
    fileMode = true;
    resultPayload = null;
    input.value = firstDozen(text);
    output.value = '';
    refreshActions();
    updateCounts();
    setBusy(false); // doConvert manages its own busy/progress from here
    await doConvert();
  } catch (e) {
    setBusy(false);
    setProgressError('讀檔出錯：' + (e && e.message ? e.message : e));
  }
}
// ---- batch mode ----------------------------------------------------------
// Picking/dropping MORE than one file switches to batch mode: the files
// are converted ONE BY ONE through the same runJob RPC (text and EPUB
// mixed freely), each finished result is kept as a Blob — one download
// button per row, plus a combined .zip at the end. Nothing-to-do files
// are marked in their row (批量唔彈 native alert — row states + one
// summary banner at the end; single-file mode keeps its alert behaviour).
let batchItems = [];
let batchRunning = false;

function fmtSize(n) {
  return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.max(0.1, n / 1024).toFixed(1) + ' KB';
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function updateBatchZipBtn() {
  if (!downloadZipBtn) return;
  const doneCount = batchItems.filter((i) => i.status === 'done').length;
  downloadZipBtn.disabled = batchRunning || doneCount === 0;
}

function buildBatchRows() {
  batchEl.hidden = batchItems.length === 0;
  batchListEl.innerHTML = '';
  for (const it of batchItems) {
    const li = document.createElement('li');
    const name = document.createElement('span'); name.className = 'bname'; name.textContent = it.file.name;
    const size = document.createElement('span'); size.className = 'bsize'; size.textContent = fmtSize(it.file.size);
    const status = document.createElement('span'); status.className = 'bstatus'; status.textContent = '待處理';
    li.append(name, size, status);
    batchListEl.append(li);
    it.li = li; it.statusEl = status; it.dlBtn = null;
  }
}

function updateBatchRow(it) {
  updateBatchZipBtn();
  if (!it.statusEl) return;
  const s = it.statusEl;
  s.className = 'bstatus';
  if (it.status === 'pending') s.textContent = '待處理';
  else if (it.status === 'working') { s.classList.add('working'); s.textContent = it.pct != null ? `轉換中… ${it.pct}%` : '轉換中…'; }
  else if (it.status === 'done') {
    s.classList.add('ok'); s.textContent = '完成 ✓';
    if (it.blob && !it.dlBtn) {
      const b = document.createElement('button');
      b.textContent = '下載';
      b.addEventListener('click', () => downloadBlob(it.blob, it.outName));
      it.li.append(b);
      it.dlBtn = b;
    }
  } else if (it.status === 'noop') { s.classList.add('noop'); s.textContent = '冇嘢好轉 — ' + it.message; }
  else if (it.status === 'error') { s.classList.add('err'); s.textContent = '失敗：' + it.message; }
}

function batchProgressHandler(it, prefix) {
  return ({ done, total, unit }) => {
    const pct = total ? Math.round((done / total) * 100) : null;
    it.pct = pct;
    if (it.statusEl) it.statusEl.textContent = pct != null ? `轉換中… ${pct}%` : '轉換中…';
    setProgress(`${prefix} — 轉換中… ${done} / ${total} ${unit}`, pct);
  };
}

// Converted output filename for a batch item (same one-line job the
// single-file download uses — the main thread loads no dictionary).
async function convertedFileName(rawName, ext) {
  const rawBase = rawName.replace(/\.[a-z0-9]+$/i, '');
  let base = rawBase;
  try {
    const r = await runJob(
      { kind: 'line', text: rawBase, config: openccConfig, direction },
      { onStage: stageHandler({ quiet: true }) }
    );
    if (r && r.text) base = r.text;
  } catch { /* keep the original name */ }
  base = (base || rawBase).replace(/[\\/:*?"<>|]/g, '_').trim() || 'zhconvert';
  return base + '-converted' + ext;
}

async function processBatchText(it, prefix) {
  const buf = await it.file.arrayBuffer();
  const { text } = decodeTextBytes(buf);
  if (!text.trim()) { it.status = 'noop'; it.message = '檔案係空嘅'; return; }
  if (!HAS_HAN.test(text)) { it.status = 'noop'; it.message = '冇中文字'; return; }
  const ext = it.ext === '.markdown' ? '.md' : it.ext;
  const res = await runJob(
    { kind: 'text', text, ext, config: openccConfig, direction },
    { onProgress: batchProgressHandler(it, prefix), onStage: stageHandler({ quiet: true }) }
  );
  if (res.text === text) { it.status = 'noop'; it.message = '已經係目標文字'; return; }
  // Text results are stored pre-encoded with the chosen download encoding.
  it.blob = await encodeTextBlob(res.text, downloadEncoding);
  it.outName = await convertedFileName(it.file.name, ext);
  it.status = 'done';
}

async function processBatchEpub(it, prefix) {
  const buf = await it.file.arrayBuffer();
  const meta = await runJob({ kind: 'epub-inspect', buffer: buf.slice(0) }, {}, true);
  if (!meta.totalChars || !meta.headText.trim()) { it.status = 'noop'; it.message = '空書，冇文字內容'; return; }
  if (!meta.hanCount) { it.status = 'noop'; it.message = '冇中文字'; return; }
  const res = await runJob(
    { kind: 'epub', buffer: buf.slice(0), config: openccConfig, direction },
    { onProgress: batchProgressHandler(it, prefix), onStage: stageHandler({ quiet: true }) },
    true
  );
  if (res.changedDocs === 0) { it.status = 'noop'; it.message = '已經係目標文字'; return; }
  it.blob = res.blob; // EPUB stays UTF-8 inside, encoding picker doesn't apply
  it.outName = await convertedFileName(it.file.name, '.epub');
  it.status = 'done';
}

async function handleBatch(files) {
  if (busy || batchRunning) return;
  batchItems = files.map((f) => ({
    file: f, ext: extOf(f.name), status: 'pending', pct: null,
    message: '', blob: null, outName: '', li: null, statusEl: null, dlBtn: null
  }));
  const usedNames = new Set();
  buildBatchRows();
  batchSummaryEl.textContent = '';
  batchRunning = true;
  setBusy(true);
  updateBatchZipBtn();
  try {
    for (let i = 0; i < batchItems.length; i++) {
      const it = batchItems[i];
      const prefix = `第 ${i + 1}/${batchItems.length} 個檔 · ${it.file.name}`;
      it.status = 'working';
      updateBatchRow(it);
      setProgress(prefix + ' — 讀取中…', null);
      try {
        if (it.file.size > MAX_FILE_BYTES) throw new Error('檔案太大（限 20MB）');
        if (!ACCEPT_EXTS.includes(it.ext)) throw new Error('唔支援呢個格式：' + it.ext);
        if (it.ext === '.epub') await processBatchEpub(it, prefix);
        else await processBatchText(it, prefix);
        // De-dupe output names across the batch (a-converted.txt, (2), (3)…)
        if (it.status === 'done' && it.outName) it.outName = uniqueZipName(it.outName, usedNames);
      } catch (e) {
        // REAL error, kept on the row verbatim (e.g. the EPUB DRM message).
        it.status = 'error';
        it.message = e && e.message ? e.message : String(e);
      }
      updateBatchRow(it);
    }
  } finally {
    batchRunning = false;
    setBusy(false);
    updateBatchZipBtn();
    const total = batchItems.length;
    const done = batchItems.filter((i) => i.status === 'done').length;
    const noop = batchItems.filter((i) => i.status === 'noop').length;
    const err = batchItems.filter((i) => i.status === 'error').length;
    const summary = `批量完成：${total} 個檔 · ${done} 完成 · ${noop} 冇嘢好轉 · ${err} 失敗`;
    batchSummaryEl.textContent = summary;
    if (done > 0) setDone(summary + (done > 1 ? ' — 㩒「全部下載 (.zip)」一次過攞晒' : ''));
    else if (err > 0 && noop === 0) setProgressError(summary);
    else showInfoBanner('⚠ ' + summary);
  }
}

async function downloadAllZip() {
  const done = batchItems.filter((i) => i.status === 'done' && i.blob);
  if (!done.length) return;
  const JSZip = (await import('jszip')).default; // lazy — only on demand
  const zip = new JSZip();
  const used = new Set();
  for (const it of done) zip.file(uniqueZipName(it.outName, used), it.blob);
  const blob = await zip.generateAsync({ type: 'blob' });
  downloadBlob(blob, 'converted-files.zip');
}
if (downloadZipBtn) {
  downloadZipBtn.addEventListener('click', () => {
    downloadAllZip().catch((e) => setProgressError('打包出錯：' + (e && e.message ? e.message : e)));
  });
}

// One file = the classic single-file flow; several = batch mode.
function dispatchFiles(files) {
  if (!files || files.length === 0) return;
  if (files.length === 1) handleFile(files[0]);
  else handleBatch(files);
}

$('file').addEventListener('change', (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = ''; // allow re-picking the same files afterwards
  dispatchFiles(files);
});
const drop = $('drop');
['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => dispatchFiles([...(e.dataTransfer.files || [])]));

// Initial action states (download/copy disabled until a result exists).
refreshActions();

// PWA: register the service worker for offline use (public/sw.js:
// network-first for the page so deploys land immediately, cache fallback
// when offline). Registration failure is silent — the site works fully
// without it.
if ('serviceWorker' in navigator) {
  try {
    const reg = navigator.serviceWorker.register('/sw.js');
    if (reg && typeof reg.catch === 'function') reg.catch(() => {});
  } catch { /* no service worker — fine */ }
}

// expose for quick console tests
window.__zhc = { runJob, decodeTextBytes };
