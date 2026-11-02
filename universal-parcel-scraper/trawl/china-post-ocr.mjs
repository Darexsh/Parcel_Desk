import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { solveZtoCharacters } from './zto-ocr.mjs';

let active = 0;

function readTargets(image, signal, timeoutMs) {
  if (active >= 2 || signal.aborted || timeoutMs < 1000) return Promise.resolve(null);
  active++;
  return new Promise(resolve => {
    let output = '', invalid = false;
    const child = spawn('/opt/zto-ocr/bin/python', [fileURLToPath(new URL('./china-post-ocr.py', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' } });
    const stop = () => { invalid = true; child.kill('SIGKILL'); };
    const timer = setTimeout(stop, Math.min(8000, timeoutMs));
    signal.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', data => { output += data.toString(); if (output.length > 512) stop(); });
    child.stdin.on('error', () => {});
    child.on('error', () => { invalid = true; });
    child.on('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', stop); active--;
      try { resolve(!invalid && code === 0 ? JSON.parse(output) : null); } catch { resolve(null); }
    });
    if (signal.aborted) stop();
    else child.stdin.end(JSON.stringify(image));
  });
}

/** Disposable offline OCR; the carrier verifies the resulting ordered clicks. */
export async function solveChinaPostCharacters(challenge, signal, timeoutMs, report) {
  const started = Date.now();
  const decode = value => typeof value === 'string' && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(value)
    ? value.split(',')[1] : null;
  const template = decode(challenge?.templateImage), image = decode(challenge?.backgroundImage);
  const width = challenge?.backgroundImageWidth, height = challenge?.backgroundImageHeight;
  if (!template || !image || template.length > 100_000 || image.length > 1_400_000
    || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || width > 600 || height < 1 || height > 400) return null;
  report?.('prompt');
  const targets = await readTargets(template, signal, timeoutMs);
  // Only a completed model read can request another prompt. Busy, timed-out,
  // malformed and crashed workers still return null and stop this lookup.
  if (targets?.failure === 'unreadable') report?.('prompt-unreadable');
  if (typeof targets !== 'string' || !/^[\u3400-\u9fff]{2,4}$/.test(targets)) return null;
  report?.('positions');
  const result = await solveZtoCharacters({ targets, image, region: { x: 0, y: 0, width, height } }, signal,
    Math.max(0, timeoutMs - (Date.now() - started)));
  return Array.isArray(result.points) ? result.points : null;
}
