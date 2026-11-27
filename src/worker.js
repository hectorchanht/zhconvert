// ZhConvert Web Worker — runs the conversion core off the main thread so
// even a 20 MB novel never janks the UI. Thin shell around convert-core.js:
// jobs in, progress/stage/done/error messages out.
//
// Wire format:
//   in : { id, job, transferBuffer? }  (job.buffer may arrive as a
//        transferred ArrayBuffer for epub jobs)
//   out: { id, type:'progress', done, total, unit, headPreview }
//        { id, type:'stage', stage, label }
//        { id, type:'done', result }
//        { id, type:'error', message }

import { processJob } from './convert-core.js';

self.onmessage = async (e) => {
  const { id, job } = e.data || {};
  if (id == null || !job) return;
  const emit = {
    progress: (p) => self.postMessage({ id, type: 'progress', ...p }),
    stage: (stage, label) => self.postMessage({ id, type: 'stage', stage, label })
  };
  try {
    const result = await processJob(job, emit);
    self.postMessage({ id, type: 'done', result });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
