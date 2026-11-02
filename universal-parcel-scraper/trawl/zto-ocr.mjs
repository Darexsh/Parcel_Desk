import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKERS = 2;
// What the worker itself reports it could not read.
const READ_FAILURES = new Set(['targets', 'image', 'region', 'boxes', 'charset', 'exception']);
const waiting = [];
let active = 0;

/** A worker slot, waiting for one to free up for as long as the caller can. */
function acquire(signal, timeoutMs) {
  if (active < WORKERS) { active++; return Promise.resolve(true); }
  return new Promise(resolve => {
    const finish = granted => { clearTimeout(timer); signal.removeEventListener('abort', cancel); resolve(granted); };
    const cancel = () => { const index = waiting.indexOf(finish); if (index >= 0) waiting.splice(index, 1); finish(false); };
    const timer = setTimeout(cancel, timeoutMs);
    signal.addEventListener('abort', cancel, { once: true });
    waiting.push(finish);
  });
}

// A released slot passes straight to the next waiter.
function release() {
  const next = waiting.shift();
  if (next) next(true); else active--;
}

const count = value => Number.isInteger(value) && value >= 0 && value <= 50 ? value : undefined;
const ratio = value => Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;

function answer(failure, code, output) {
  if (failure) return { failure };
  if (code !== 0) return { failure: 'exit' };
  let value;
  try { value = JSON.parse(output); } catch { return { failure: 'output' }; }
  if (READ_FAILURES.has(value?.failure)) return { failure: value.failure, boxes: count(value.boxes) };
  if (!Array.isArray(value?.points)) return { failure: 'output' };
  return { points: value.points, boxes: count(value.boxes), confidence: ratio(value.confidence), margin: ratio(value.margin) };
}

/**
 * One disposable, offline worker per challenge. No screenshots or tokens persist.
 * Resolves to the points in order, or a fixed failure label, with the time spent.
 */
export async function solveZtoCharacters(input, signal, timeoutMs) {
  const start = Date.now();
  if (signal.aborted || timeoutMs < 1000) return { failure: 'budget', ms: 0, waitMs: 0 };
  if (!await acquire(signal, timeoutMs - 1000)) {
    return { failure: signal.aborted ? 'budget' : 'busy', ms: Date.now() - start, waitMs: Date.now() - start };
  }
  const waitMs = Date.now() - start;
  return new Promise(resolve => {
    let output = '', failure = null;
    const child = spawn('/opt/zto-ocr/bin/python', [fileURLToPath(new URL('./zto-ocr.py', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' } });
    const stop = label => { failure ??= label; child.kill('SIGKILL'); };
    const abort = () => stop('budget');
    const timer = setTimeout(() => stop('timeout'), Math.min(16000, timeoutMs - waitMs));
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', data => { output += data.toString(); if (output.length > 4096) stop('output'); });
    child.stdin.on('error', () => {});
    child.on('error', () => { failure ??= 'spawn'; });
    child.on('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', abort); release();
      resolve({ ...answer(failure, code, output), ms: Date.now() - start, waitMs });
    });
    if (signal.aborted) abort();
    else child.stdin.end(JSON.stringify(input));
  });
}
