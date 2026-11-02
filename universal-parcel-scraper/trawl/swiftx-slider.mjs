import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const API = 'https://swiftx-express.com/api/graphql';
const MAX_IMAGE = 1_500_000;
let active = 0;
const reportVerification = fields => console.warn(JSON.stringify({ level: 'warn', event: 'swiftx.verification', ...fields }));

/** Disposable image analysis, with no number, session or verification token. */
export function locateSwiftxSlider(challenge, signal, timeoutMs, onAnalysis = () => {}) {
  const report = outcome => { try { onAnalysis(outcome); } catch { /* Diagnostics cannot change analysis. */ } };
  if (signal.aborted || timeoutMs < 100 || active >= 2) {
    report(signal.aborted ? 'cancelled' : timeoutMs < 100 ? 'budget' : 'capacity');
    return Promise.resolve(null);
  }
  active++;
  return new Promise(resolve => {
    let output = '', invalid = false, failureReason;
    const complete = (answer, outcome) => { report(outcome); resolve(answer); };
    const child = spawn('/opt/zto-ocr/bin/python', [fileURLToPath(new URL('./swiftx-slider.py', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH ?? '', OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' } });
    const stop = reason => { invalid = true; failureReason = reason; child.kill('SIGKILL'); };
    const aborted = () => stop('cancelled');
    const timer = setTimeout(() => stop('timeout'), Math.min(4000, timeoutMs));
    signal.addEventListener('abort', aborted, { once: true });
    child.stdout.on('data', data => { output += data.toString(); if (output.length > 512) stop('output_limit'); });
    child.stdin.on('error', () => {});
    child.on('error', () => { invalid = true; failureReason = 'worker_error'; });
    child.on('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', aborted); active--;
      try {
        const answer = !invalid && code === 0 ? JSON.parse(output) : null;
        const missing = failureReason ?? (code === 0 ? 'no_plan' : 'worker_error');
        if (challenge.type === 'ICON_CLICK') {
          const points = answer?.points;
          const valid = Array.isArray(points) && Number.isInteger(challenge.clickCount) && challenge.clickCount >= 2
            && challenge.clickCount <= 6 && points.length === challenge.clickCount
            && points.every(point => Number.isInteger(point?.x) && Number.isInteger(point?.y)
              && point.x > 0 && point.x < challenge.backgroundImageWidth && point.y > 0 && point.y < challenge.backgroundImageHeight);
          complete(valid ? { points: points.map(({ x, y }) => ({ x, y })) } : null, valid ? 'planned' : answer == null ? missing : 'invalid_plan');
          return;
        }
        const maximum = ['CONCAT', 'ROTATE'].includes(challenge.type) ? challenge.backgroundImageWidth
          : challenge.backgroundImageWidth - challenge.templateImageWidth;
        const valid = Number.isInteger(answer?.x) && answer.x >= 0 && answer.x < maximum;
        complete(valid ? answer : null, valid ? 'planned' : answer == null ? missing : 'invalid_plan');
      } catch { complete(null, 'unreadable'); }
    });
    if (signal.aborted) aborted();
    else child.stdin.end(JSON.stringify(Object.fromEntries(['type', 'backgroundImage', 'templateImage',
      'backgroundImageWidth', 'backgroundImageHeight', 'templateImageWidth', 'templateImageHeight', 'concatTopHeight', 'clickCount']
      .map(key => [key, challenge[key]]))));
  });
}

function validChallenge(value) {
  const image = text => typeof text === 'string' && text.length <= MAX_IMAGE
    && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(text);
  return value?.success === true && typeof value.captchaId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.captchaId)
    && typeof value.type === 'string' && ['SLIDER', 'ROTATE', 'CONCAT', 'ICON_CLICK'].includes(value.type)
    && image(value.backgroundImage) && (value.templateImage == null || image(value.templateImage))
    && Number.isInteger(value.backgroundImageWidth) && value.backgroundImageWidth >= 32 && value.backgroundImageWidth <= 1024
    && Number.isInteger(value.backgroundImageHeight) && value.backgroundImageHeight >= 32 && value.backgroundImageHeight <= 1024;
}

/** The page's own image and slider geometry; a refreshed puzzle cannot use an old plan. */
export function swiftxSliderGeometry({ number, challenge }) {
  const url = new URL(location.href);
  if (url.origin !== 'https://swiftx-express.com' || url.pathname !== '/track'
    || url.searchParams.getAll('trackingNumber').length !== 1 || url.searchParams.get('trackingNumber') !== number) return null;
  const entered = [...document.querySelectorAll('textarea')];
  if (entered.length && !entered.some(input => input.value.trim().toUpperCase() === number)) return null;
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return null;
  const images = [...dialog.querySelectorAll('img')];
  const background = images.find(image => image.src === challenge.backgroundImage);
  const template = images.find(image => image.src === challenge.templateImage);
  if (!background?.complete || !background.naturalWidth) return null;
  const bg = background.getBoundingClientRect();
  if (bg.width < 100 || bg.height <= 0 || background.naturalWidth !== challenge.backgroundImageWidth
    || background.naturalHeight !== challenge.backgroundImageHeight) return null;
  if (challenge.type === 'ICON_CLICK') {
    if (!template?.complete || template.naturalWidth !== challenge.templateImageWidth
      || template.naturalHeight !== challenge.templateImageHeight) return null;
    return { x: bg.x, y: bg.y, scaleX: bg.width / background.naturalWidth,
      scaleY: bg.height / background.naturalHeight, width: bg.width, height: bg.height };
  }
  const knob = [...dialog.querySelectorAll('button')].find(button => button.style.width === '44px'
    && button.style.height === '44px' && !button.disabled);
  if (!knob) return null;
  const handle = knob.getBoundingClientRect();
  if (handle.width !== 44) return null;
  let maxImage = bg.width;
  if (['SLIDER', 'ROTATE'].includes(challenge.type)) {
    if (!template?.complete || !template.naturalWidth || template.naturalWidth !== challenge.templateImageWidth
      || template.naturalHeight !== challenge.templateImageHeight) return null;
    const piece = template.getBoundingClientRect();
    if (piece.width <= 0 || piece.width >= bg.width) return null;
    if (challenge.type === 'SLIDER') maxImage -= piece.width;
  } else if (challenge.type === 'CONCAT') {
    if (![...dialog.querySelectorAll('div')].some(element => element.style.backgroundImage.includes(challenge.backgroundImage)
      && Math.abs(element.getBoundingClientRect().height - challenge.concatTopHeight * bg.width / background.naturalWidth) <= 1)) return null;
  } else return null;
  return { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2,
    scale: bg.width / background.naturalWidth, maxKnob: bg.width - handle.width, maxImage };
}

export function swiftxSliderDrag(geometry, plan) {
  if (!geometry || !Number.isInteger(plan?.x) || !['x', 'y', 'scale', 'maxKnob', 'maxImage'].every(key => Number.isFinite(geometry[key]))
    || geometry.scale <= 0 || geometry.maxKnob <= 0 || geometry.maxImage <= 0) return null;
  const distance = plan.x * geometry.scale * geometry.maxKnob / geometry.maxImage;
  return Number.isFinite(distance) && distance >= 8 && distance <= geometry.maxKnob
    ? { x: geometry.x, y: geometry.y, distance } : null;
}

export function swiftxIconClicks(geometry, plan, count) {
  if (!geometry || !Number.isInteger(count) || count < 2 || count > 6 || !Array.isArray(plan?.points)
    || plan.points.length !== count || !['x', 'y', 'scaleX', 'scaleY', 'width', 'height'].every(key => Number.isFinite(geometry[key]))
    || geometry.scaleX <= 0 || geometry.scaleY <= 0 || geometry.width <= 0 || geometry.height <= 0) return null;
  const points = plan.points.map(point => ({ x: point?.x * geometry.scaleX, y: point?.y * geometry.scaleY }));
  if (points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y)
    || point.x <= 0 || point.x >= geometry.width || point.y <= 0 || point.y >= geometry.height)
    || new Set(points.map(point => `${point.x},${point.y}`)).size !== count) return null;
  return points.map(point => ({ x: geometry.x + point.x, y: geometry.y + point.y }));
}

/** Choose the public summary rather than supplying recipient verification. */
export function swiftxSkipPhonePrompt({ number }) {
  const url = new URL(location.href);
  if (url.origin !== 'https://swiftx-express.com' || url.pathname !== '/track' || url.hash
    || [...url.searchParams].length !== 1 || url.searchParams.get('trackingNumber') !== number) return false;
  const visible = element => element.getBoundingClientRect().width > 0;
  const numbers = [...document.querySelectorAll('textarea')];
  const inputs = [...document.querySelectorAll('input[maxlength="4"]')].filter(visible);
  const skip = [...document.querySelectorAll('button')].filter(button => visible(button) && !button.disabled
    && /^skip, show parcel status$/i.test(button.textContent.trim()));
  if (numbers.length !== 1 || numbers[0].value.trim().toUpperCase() !== number
    || inputs.length !== 1 || inputs[0].value !== '' || inputs[0].disabled || skip.length !== 1
    || !/phone/i.test(document.body.innerText)) return false;
  skip[0].click();
  return true;
}

/** Observe before navigation; only the official UI obtains and submits verification. */
export function attachSwiftxSlider(page, number, { signal: parent, solve = locateSwiftxSlider, onVerification = reportVerification } = {}) {
  const stopped = new AbortController();
  const signal = parent ? AbortSignal.any([parent, stopped.signal]) : stopped.signal;
  const digest = createHash('sha256').update(number).digest('hex');
  let current, generation = 0, verified = false, refusal, disposed = false, reads = 0;
  let deadline = 0, attempted = 0, seen = 0, running, hasRequest = () => false, onRefusal;
  const started = Date.now();
  let sawImage = false, prepared = false, phonePromptSkipped = false, puzzleType = 'none', outcome = 'not_seen', analysisOutcome = 'not_started';
  const remaining = () => Math.max(0, deadline - Date.now());
  const refused = value => { refusal = value; onRefusal?.(value); };
  const pending = new Set();
  const onResponse = response => {
    if (disposed || signal.aborted || response.url() !== API || response.request().method() !== 'POST') return;
    if (response.request().frame && response.request().frame() !== page.mainFrame()) return;
    let request;
    try { request = response.request().postDataJSON(); } catch { return; }
    const query = request?.query;
    if (typeof query !== 'string') return;
    const image = /\bgetOfficialTrackingSliderCaptcha\b/.test(query);
    const verification = /\bverifyOfficialTrackingSlider\b/.test(query) && current
      && request.variables?.input?.captchaId === current.captchaId && request.variables?.input?.bindingDigest === digest;
    if (!image && !verification) return;
    if (image) { sawImage = true; outcome = 'image_unreadable'; }
    const status = response.status(), headers = response.headers();
    if (status !== 200) {
      if (status >= 400) { outcome = 'http_refused'; refused({ status, retryAfter: headers['retry-after'] }); }
      return;
    }
    const length = Number(headers['content-length'] ?? 0);
    if (++reads > 6 || !String(headers['content-type'] ?? '').includes('application/json')
      || !Number.isSafeInteger(length) || length < 0 || length > 3_100_000) return;
    const read = response.body().then(body => {
      if (disposed || signal.aborted || body.length > 3_100_000) return;
      let payload;
      try { payload = JSON.parse(body.toString('utf8'))?.data; } catch { return; }
      if (image) {
        const challenge = payload?.getOfficialTrackingSliderCaptcha;
        puzzleType = ['SLIDER', 'ROTATE', 'CONCAT', 'ICON_CLICK'].includes(challenge?.type) ? challenge.type : 'other';
        outcome = 'invalid_challenge';
        if (challenge?.errorCode === 'SLIDER_FETCH_RATE_LIMITED') { outcome = 'rate_limited'; refused({ status: 429 }); }
        if (validChallenge(challenge)) {
          current = Object.fromEntries(['captchaId', 'type', 'backgroundImage', 'templateImage', 'backgroundImageWidth',
            'backgroundImageHeight', 'templateImageWidth', 'templateImageHeight', 'concatTopHeight', 'clickCount']
            .map(key => [key, challenge[key]]));
          generation++; verified = false; outcome = 'received'; analysisOutcome = 'not_started'; startDrive();
        }
      } else {
        const result = payload?.verifyOfficialTrackingSlider;
        // The issued token is consumed by the page's callback and never returned.
        verified = result?.success === true && typeof result.sliderToken === 'string' && result.sliderToken.length > 0;
        outcome = verified ? 'verified' : 'verification_refused';
      }
    }).catch(() => {}).finally(() => pending.delete(read));
    pending.add(read);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true; stopped.abort(); current = undefined;
    page.off('response', onResponse); page.off('close', dispose);
    // Fixed labels distinguish page checks from image analysis and carrier
    // refusal. Never include the challenge, answer, digest or tracking number.
    try {
      const trackingRequested = prepared ? Boolean(hasRequest()) : null;
      if (sawImage || (prepared && !trackingRequested)) onVerification({ host: 'swiftx-express.com', puzzleType, outcome, analysisOutcome, prepared,
        ...(phonePromptSkipped ? { phonePromptSkipped: true } : {}),
        attempts: attempted, generations: generation, verified, trackingRequested, pendingReads: pending.size,
        cancelled: parent?.aborted === true, timedOut: deadline > 0 && remaining() === 0, durationMs: Date.now() - started });
    } catch { /* Diagnostics cannot affect cleanup or tracking. */ }
  };
  page.on('response', onResponse); page.on('close', dispose);
  function startDrive() {
    if (!running && current && remaining() > 3500 && !disposed && !signal.aborted && !refusal) {
      running = drive().catch(() => { if (!disposed && !signal.aborted) outcome = 'automation_error'; }).finally(() => { running = undefined; });
    }
  }
  async function drive() {
    const pause = () => new Promise(resolve => setTimeout(resolve, Math.min(100, remaining())));
    let phoneDeadline;
    while (!disposed && !signal.aborted && remaining() > 0 && !hasRequest() && !refusal) {
      if (verified) {
        // The current page waits for an optional phone prompt after a solve.
        // Its Skip control sends a public BASIC reply; never fill the field,
        // replay the verification token or submit another tracking form.
        phoneDeadline ??= Date.now() + Math.min(1500, remaining());
        if (phonePromptSkipped || Date.now() >= phoneDeadline) break;
        if (await page.evaluate(swiftxSkipPhonePrompt, { number }) === true) { phonePromptSkipped = true; break; }
        await pause();
        continue;
      }
      if (!current || generation === seen) { await pause(); continue; }
      if (attempted >= 2 || remaining() < 3500) break;
      seen = generation; attempted++;
      const challenge = current;
      analysisOutcome = 'unreported';
      const plan = await solve(challenge, signal, remaining(), value => {
        if (!disposed && current === challenge && ['cancelled', 'budget', 'capacity', 'timeout', 'output_limit',
          'worker_error', 'no_plan', 'invalid_plan', 'planned', 'unreadable'].includes(value)) analysisOutcome = value;
      });
      if (disposed || signal.aborted || remaining() < 2000 || current !== challenge) continue;
      const geometry = plan && await page.evaluate(swiftxSliderGeometry, { number, challenge });
      const drag = swiftxSliderDrag(geometry, plan);
      const clicks = challenge.type === 'ICON_CLICK' && swiftxIconClicks(geometry, plan, challenge.clickCount);
      if (!drag && !clicks) {
        outcome = !plan ? 'analysis_unresolved' : !geometry ? 'geometry_unavailable' : 'plan_rejected';
        if (attempted >= 2 || remaining() < 5000) break;
        await page.getByRole('dialog').locator('button').first().evaluate(button => button.click());
        continue;
      }
      outcome = 'input_started';
      if (clicks) {
        for (const point of clicks) {
          if (disposed || signal.aborted || remaining() < 1000 || current !== challenge
            || !await page.evaluate(swiftxSliderGeometry, { number, challenge })) break;
          await page.mouse.click(point.x, point.y);
        }
        continue;
      }
      await page.mouse.move(drag.x, drag.y);
      if (signal.aborted || remaining() < 1500) break;
      if (current !== challenge || !await page.evaluate(swiftxSliderGeometry, { number, challenge })) continue;
      await page.mouse.down();
      try {
        await page.mouse.move(drag.x + drag.distance / 2, drag.y + .6);
        if (signal.aborted || !remaining()) break;
        await page.mouse.move(drag.x + drag.distance, drag.y);
      } finally { if (!signal.aborted) await page.mouse.up(); }
    }
  }
  return { dispose,
    async prepare(budgetMs, requested = () => false, retainRefusal) {
      prepared = true;
      deadline = Date.now() + Math.max(0, budgetMs - 1000);
      hasRequest = requested; onRefusal = retainRefusal;
      if (refusal) { onRefusal?.(refusal); return refusal; }
      // Do not delay the generic Turnstile solver while the page still uses it.
      // If it later offers its image dialog, the observer starts the scoped
      // solver while capture continues to wait for the tracking request.
      startDrive();
      if (running) await running;
      return refusal;
    },
  };
}
