import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let active = 0;
// Why the worker declined: a prompt or scene in another layout, an unreadable image, no icon in
// the prompt, no pose, or no clear winner.
const DECLINES = new Set(['geometry', 'image', 'foreground', 'matching', 'ambiguous']);
const image = value => typeof value === 'string' && value.length <= 200_000
  && /^data:image\/(?:png|jpeg|jpg);base64,[A-Za-z0-9+/=]+$/.test(value);

/** A bounded offline plan, not proof that the official widget accepted it. */
export function locateJdIcon(challenge, signal, timeoutMs, onAnalysis = () => {}) {
  const report = (value, count) => { try { onAnalysis(value, count); } catch { /* Diagnostics cannot change the plan. */ } };
  if (signal.aborted || !Number.isFinite(timeoutMs) || timeoutMs < 100 || active >= 2
    || !image(challenge?.scene) || !image(challenge?.tip)) {
    report(signal.aborted ? 'cancelled' : active >= 2 ? 'capacity' : 'input_or_budget');
    return Promise.resolve(null);
  }
  active++;
  return new Promise(resolve => {
    let output = '', invalid = false, failure;
    const child = spawn('/opt/zto-ocr/bin/python', [fileURLToPath(new URL('./jd-icon.py', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH ?? '', OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' } });
    const stop = reason => { invalid = true; failure = reason; child.kill('SIGKILL'); };
    const aborted = () => stop('cancelled');
    const timer = setTimeout(() => stop('timeout'), Math.min(3000, timeoutMs));
    signal.addEventListener('abort', aborted, { once: true });
    child.stdout.on('data', bytes => { output += bytes.toString(); if (output.length > 256) stop('output_limit'); });
    child.stdin.on('error', () => {});
    child.on('error', () => { invalid = true; failure = 'worker_error'; });
    child.on('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', aborted); active--;
      try {
        const plan = !invalid && code === 0 ? JSON.parse(output) : null;
        const valid = Number.isFinite(plan?.x) && Number.isFinite(plan?.y)
          && plan.x > 0 && plan.x < 275 && plan.y > 0 && plan.y < 170;
        const declined = DECLINES.has(plan?.failure) ? plan.failure : 'unreadable';
        const count = plan?.foregroundPixels;
        const foregroundPixels = !invalid && code === 0 && !valid && declined === 'foreground'
          && Number.isSafeInteger(count) && count >= 0 && count <= 108 * 36 && (count < 60 || count > 900)
          ? count : undefined;
        report(valid ? 'planned' : failure ?? (code === 0 ? declined : 'worker_error'), foregroundPixels);
        resolve(valid ? { x: plan.x, y: plan.y } : null);
      } catch { report('unreadable'); resolve(null); }
    });
    if (signal.aborted) aborted();
    else child.stdin.end(JSON.stringify({ scene: challenge.scene, tip: challenge.tip }));
  });
}

/** Run in the official page immediately before a click; neither image may change. */
export function jdIconGeometry({ challenge, point }) {
  if (location.origin !== 'https://www.jdl.com' || !/^\/orderSearch\/?$/.test(location.pathname)
    || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)
    || point.x <= 0 || point.x >= 275 || point.y <= 0 || point.y >= 170) return null;
  const scenes = document.querySelectorAll('.cpc-img-container img'), tips = document.querySelectorAll('img.tip_pic');
  if (scenes.length !== 1 || tips.length !== 1) return null;
  const scene = scenes[0], tip = tips[0];
  const shown = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible'
    && getComputedStyle(element).opacity === '1';
  if (!shown(scene) || !shown(tip)) return null;
  if (!scene.complete || !tip.complete || scene.src !== challenge?.scene || tip.src !== challenge?.tip
    || scene.naturalWidth !== 275 || scene.naturalHeight !== 170 || tip.naturalWidth !== 108 || tip.naturalHeight !== 36) return null;
  const rect = scene.getBoundingClientRect(), prompt = tip.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || prompt.width <= 0 || prompt.height <= 0) return null;
  return { x: rect.x + point.x * rect.width / 275, y: rect.y + point.y * rect.height / 170 };
}
