import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { attachSwiftxSlider, locateSwiftxSlider, swiftxSliderDrag, swiftxIconClicks, swiftxSkipPhonePrompt } from './swiftx-slider.mjs';

const API = 'https://swiftx-express.com/api/graphql';
const NUMBER = 'SWX000000000000000001';
const digest = createHash('sha256').update(NUMBER).digest('hex');
const tick = () => new Promise(resolve => setImmediate(resolve));
const challenge = (id = 'SYNTHETIC_A', type = 'SLIDER') => ({ success: true, captchaId: id, type,
  backgroundImage: 'data:image/png;base64,AA==', templateImage: 'data:image/png;base64,AQ==',
  backgroundImageWidth: 600, backgroundImageHeight: 360, templateImageWidth: 110, templateImageHeight: 360 });
const imageQuery = { query: 'query { getOfficialTrackingSliderCaptcha { success } }' };
const verifyQuery = (id = 'SYNTHETIC_A', bindingDigest = digest) => ({ query: 'mutation { verifyOfficialTrackingSlider(input: $input) { success } }',
  variables: { input: { captchaId: id, bindingDigest } } });

function fixture(options = {}) {
  const page = new EventEmitter();
  let refreshes = 0, moves = 0, downs = 0, ups = 0;
  const clicks = [];
  const geometry = { x: 30, y: 100, scale: 320 / 600, maxKnob: 276, maxImage: 261 };
  page.evaluate = async fn => fn === swiftxSkipPhonePrompt ? (options.skipPhone?.() ?? false) : (options.geometry ?? geometry);
  page.getByRole = () => ({ locator: () => ({ first: () => ({ evaluate: async () => { refreshes++; await options.refresh?.(); } }) }) });
  page.mouse = { move: async () => { moves++; await options.move?.(); }, down: async () => { downs++; }, up: async () => { ups++; await options.up?.(); } };
  page.mouse.click = async (x, y) => { clicks.push({ x, y }); await options.click?.(clicks.length); };
  const controller = attachSwiftxSlider(page, NUMBER, { solve: async () => null, onVerification: () => {}, ...options });
  const respond = async (payload, request = imageQuery, { status = 200, headers = {}, read, url = API } = {}) => {
    page.emit('response', { url: () => url, status: () => status, headers: () => ({ 'content-type': 'application/json', ...headers }),
      request: () => ({ method: () => 'POST', postDataJSON: () => request }), body: read ?? (async () => Buffer.from(JSON.stringify({ data: payload }))) });
    await tick();
  };
  return { page, controller, respond, clicks, stats: () => ({ refreshes, moves, downs, ups }) };
}

test('only skips an empty optional phone prompt for the same whole number', () => {
  for (const invalid of [null, 'number', 'page', 'query', 'filled', 'disabled', 'hidden', 'duplicate', 'label']) {
    let clicks = 0;
    const button = { textContent: invalid === 'label' ? 'Continue' : 'Skip, show parcel status', disabled: invalid === 'disabled',
      getBoundingClientRect: () => ({ width: invalid === 'hidden' ? 0 : 100 }), click: () => { clicks++; } };
    const document = { body: { innerText: 'Enter the last four digits of the recipient phone number' },
      querySelectorAll: selector => selector === 'textarea' ? [{ value: invalid === 'number' ? 'SWX000000000000000002' : NUMBER }]
        : selector === 'input[maxlength="4"]' ? [{ value: invalid === 'filled' ? '1234' : '', disabled: false,
          getBoundingClientRect: () => ({ width: 100 }) }] : invalid === 'duplicate' ? [button, button] : [button] };
    const href = `https://${invalid === 'page' ? 'other.test' : 'swiftx-express.com'}/track?trackingNumber=${NUMBER}${invalid === 'query' ? '&other=1' : ''}`;
    const result = runInNewContext(`(${swiftxSkipPhonePrompt})({number})`, { URL, location: { href }, document, number: NUMBER });
    assert.equal(result, invalid === null, invalid);
    assert.equal(clicks, invalid === null ? 1 : 0, invalid);
  }
});

test('uses the optional Skip only after bound verification and never repeats it', async () => {
  let f, skips = 0;
  f = fixture({ solve: async () => ({ x: 200 }), skipPhone: () => { skips++; return true; },
    up: () => f.respond({ verifyOfficialTrackingSlider: { success: true, sliderToken: 'PRIVATE_TOKEN' } }, verifyQuery()) });
  await f.respond({ getOfficialTrackingSliderCaptcha: challenge() });
  await f.controller.prepare(6000);
  await f.controller.prepare(6000);
  f.controller.dispose();
  assert.equal(skips, 1);
  const refused = fixture({ skipPhone: () => { throw new Error('must not skip without verification'); } });
  await refused.controller.prepare(0);
  refused.controller.dispose();
});

test('maps each icon through the rendered image and refuses incomplete or repeated answers', () => {
  const geometry = { x: 20, y: 50, width: 300, height: 180, scaleX: .5, scaleY: .5 };
  const plan = { points: [{ x: 80, y: 200 }, { x: 440, y: 60 }] };
  assert.deepEqual(swiftxIconClicks(geometry, plan, 2), [{ x: 60, y: 150 }, { x: 240, y: 80 }]);
  for (const points of [[], [plan.points[0]], [plan.points[0], plan.points[0]], [{ x: 600, y: 50 }, plan.points[1]],
    [{ x: 80, y: NaN }, plan.points[1]]]) assert.equal(swiftxIconClicks(geometry, { points }, 2), null);
});

test('reports bound image verification once without its number, digest, images or token', async () => {
  const reports = []; let f, requested = false;
  f = fixture({ onVerification: row => reports.push(row), solve: async () => ({ x: 200 }),
    up: () => f.respond({ verifyOfficialTrackingSlider: { success: true, sliderToken: 'PRIVATE_TOKEN' } }, verifyQuery()) });
  await f.respond({ getOfficialTrackingSliderCaptcha: challenge() });
  await f.controller.prepare(6000, () => requested);
  requested = true;
  f.controller.dispose(); f.controller.dispose();
  assert.equal(reports.length, 1);
  const { durationMs, ...row } = reports[0];
  assert.ok(Number.isInteger(durationMs) && durationMs >= 0);
  assert.deepEqual(row, { host: 'swiftx-express.com', puzzleType: 'SLIDER', outcome: 'verified', analysisOutcome: 'unreported', prepared: true,
    attempts: 1, generations: 1, verified: true, trackingRequested: true, pendingReads: 0,
    cancelled: false, timedOut: false });
  for (const value of [NUMBER, digest, 'PRIVATE_TOKEN', 'SYNTHETIC_A', 'data:image']) assert.equal(JSON.stringify(reports).includes(value), false);
});

test('distinguishes unresolved analysis, missing geometry and an unsupported puzzle without logging its data', async () => {
  for (const mode of ['analysis', 'geometry', 'unsupported']) {
    const reports = []; let f;
    f = fixture({ onVerification: row => reports.push(row),
      solve: async () => mode === 'geometry' ? { x: 200 } : null,
      refresh: () => f.respond({ getOfficialTrackingSliderCaptcha: challenge('SYNTHETIC_B', 'ROTATE') }) });
    if (mode === 'geometry') f.page.evaluate = async () => null;
    await f.respond({ getOfficialTrackingSliderCaptcha: challenge('PRIVATE_CAPTCHA', mode === 'unsupported' ? 'PRIVATE_TYPE' : 'SLIDER') });
    await f.controller.prepare(mode === 'unsupported' ? 0 : 8000);
    f.controller.dispose();
    assert.equal(reports.length, 1);
    assert.equal(reports[0].outcome, { analysis: 'analysis_unresolved', geometry: 'geometry_unavailable', unsupported: 'invalid_challenge' }[mode]);
    assert.equal(reports[0].puzzleType, mode === 'unsupported' ? 'other' : 'ROTATE');
    assert.equal(reports[0].attempts, mode === 'unsupported' ? 0 : 2);
    assert.equal(reports[0].verified, false);
    assert.equal(JSON.stringify(reports).includes('PRIVATE'), false);
  }
});

test('reports an unobserved page check safely, leaves clear lookups quiet and closes despite reporter failure', async t => {
  const logs = []; t.mock.method(console, 'warn', value => logs.push(JSON.parse(value)));
  const page = new EventEmitter(), controller = attachSwiftxSlider(page, NUMBER);
  await controller.prepare(0); controller.dispose(); controller.dispose();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'swiftx.verification');
  assert.equal(logs[0].puzzleType, 'none'); assert.equal(logs[0].outcome, 'not_seen');
  assert.equal(logs[0].attempts, 0); assert.equal(logs[0].trackingRequested, false);
  assert.equal(JSON.stringify(logs).includes(NUMBER), false);
  const reports = [], clear = fixture({ onVerification: row => reports.push(row) });
  await clear.controller.prepare(0, () => true); clear.controller.dispose();
  assert.deepEqual(reports, []);
  const unprepared = fixture({ onVerification: row => reports.push(row) });
  unprepared.controller.dispose(); assert.deepEqual(reports, []);
  const earlyImage = fixture({ onVerification: row => reports.push(row) });
  await earlyImage.respond({ getOfficialTrackingSliderCaptcha: challenge() });
  earlyImage.controller.dispose();
  assert.equal(reports[0].prepared, false); assert.equal(reports[0].trackingRequested, null);
  const failed = fixture({ onVerification: () => { throw new Error('PRIVATE'); } });
  await failed.controller.prepare(0);
  failed.controller.dispose();
  assert.equal(failed.page.listenerCount('response'), 0); assert.equal(failed.page.listenerCount('close'), 0);
});

test('clicks the ordered icons through the official UI and requires bound verification', async () => {
  let f;
  const puzzle = { ...challenge('SYNTHETIC_A', 'ICON_CLICK'), clickCount: 2 };
  f = fixture({ geometry: { x: 20, y: 50, width: 300, height: 180, scaleX: .5, scaleY: .5 },
    solve: async () => ({ points: [{ x: 80, y: 200 }, { x: 440, y: 60 }] }),
    click: async count => { if (count === 2) await f.respond({ verifyOfficialTrackingSlider: { success: true, sliderToken: 'SYNTHETIC_TOKEN' } }, verifyQuery()); } });
  await f.respond({ getOfficialTrackingSliderCaptcha: puzzle });
  await f.controller.prepare(6000);
  assert.deepEqual(f.clicks, [{ x: 60, y: 150 }, { x: 240, y: 80 }]);
  assert.equal(f.stats().downs, 0);
  f.controller.dispose();
});

test('stops an icon sequence when the caller cancels between clicks', async () => {
  const stopped = new AbortController();
  const f = fixture({ signal: stopped.signal,
    geometry: { x: 20, y: 50, width: 300, height: 180, scaleX: .5, scaleY: .5 },
    solve: async () => ({ points: [{ x: 80, y: 200 }, { x: 440, y: 60 }] }), click: () => stopped.abort() });
  await f.respond({ getOfficialTrackingSliderCaptcha: { ...challenge('SYNTHETIC_A', 'ICON_CLICK'), clickCount: 2 } });
  await f.controller.prepare(6000);
  assert.equal(f.clicks.length, 1);
  f.controller.dispose();
});

test('maps native puzzle displacement through the page’s scaled slider geometry', () => {
  const drag = swiftxSliderDrag({ x: 30, y: 100, scale: .5, maxKnob: 256, maxImage: 245 }, { x: 245 });
  assert.deepEqual(drag, { x: 30, y: 100, distance: 128 });
  for (const geometry of [null, {}, { x: 0, y: 0, scale: 1, maxKnob: 100, maxImage: 0 }]) assert.equal(swiftxSliderDrag(geometry, { x: 100 }), null);
  assert.equal(swiftxSliderDrag({ x: 0, y: 0, scale: 1, maxKnob: 100, maxImage: 100 }, { x: 1000 }), null);
});

test('does not start image analysis after cancellation', async () => {
  const stopped = new AbortController(); stopped.abort();
  const reports = [];
  assert.equal(await locateSwiftxSlider(challenge(), stopped.signal, 4000, value => reports.push(value)), null);
  assert.deepEqual(reports, ['cancelled']);
  assert.equal(await locateSwiftxSlider(challenge(), new AbortController().signal, 0, value => reports.push(value)), null);
  assert.deepEqual(reports, ['cancelled', 'budget']);
  assert.equal(await locateSwiftxSlider(challenge(), stopped.signal, 4000, () => { throw new Error('PRIVATE'); }), null);
});

test('refreshes an unreadable puzzle only once', async () => {
  let f;
  f = fixture({ refresh: () => f.respond({ getOfficialTrackingSliderCaptcha: challenge('SYNTHETIC_B', 'ROTATE') }) });
  await f.respond({ getOfficialTrackingSliderCaptcha: challenge() });
  assert.equal(await f.controller.prepare(8000), undefined);
  assert.deepEqual(f.stats(), { refreshes: 1, moves: 0, downs: 0, ups: 0 });
  f.controller.dispose();
  assert.equal(f.page.listenerCount('response'), 0);
});

test('does not drag a stale generation after image analysis', async () => {
  let f, calls = 0;
  f = fixture({ solve: async () => {
    calls++;
    if (calls === 1) { await f.respond({ getOfficialTrackingSliderCaptcha: challenge('SYNTHETIC_B') }); return { x: 200 }; }
    return null;
  } });
  await f.respond({ getOfficialTrackingSliderCaptcha: challenge() });
  await f.controller.prepare(6000);
  assert.equal(calls, 2);
  assert.equal(f.stats().downs, 0);
  f.controller.dispose();
});

test('stops before dragging when the caller cancels during pointer placement', async () => {
  const stopped = new AbortController();
  const f = fixture({ signal: stopped.signal, solve: async () => ({ x: 200 }), move: () => stopped.abort() });
  await f.respond({ getOfficialTrackingSliderCaptcha: challenge() });
  await f.controller.prepare(6000);
  assert.equal(f.stats().downs, 0);
  f.controller.dispose();
});

test('uses the official pointer control, then stops once its bound verification succeeds', async () => {
  let f;
  f = fixture({ solve: async () => ({ x: 200 }), up: () => f.respond({ verifyOfficialTrackingSlider: { success: true, sliderToken: 'SYNTHETIC_TOKEN' } }, verifyQuery()) });
  await f.respond({ getOfficialTrackingSliderCaptcha: challenge() });
  assert.equal(await f.controller.prepare(6000), undefined);
  assert.deepEqual(f.stats(), { refreshes: 0, moves: 3, downs: 1, ups: 1 });
  f.controller.dispose();
});

test('ignores verification for another number or challenge generation', async () => {
  const f = fixture();
  await f.respond({ getOfficialTrackingSliderCaptcha: challenge() });
  for (const request of [verifyQuery('SYNTHETIC_B'), verifyQuery('SYNTHETIC_A', 'OTHER_DIGEST')]) {
    await f.respond({}, request, { status: 429, read: () => { throw new Error('must not read refusal'); } });
  }
  assert.equal(await f.controller.prepare(0), undefined);
  f.controller.dispose();
});

test('preserves a bound verification refusal without reading its body or cookies', async () => {
  const f = fixture();
  await f.respond({ getOfficialTrackingSliderCaptcha: challenge() });
  await f.respond({}, verifyQuery(), { status: 429, headers: { 'retry-after': '60', 'set-cookie': 'PRIVATE' }, read: () => { throw new Error('must not read refusal'); } });
  assert.deepEqual(await f.controller.prepare(0), { status: 429, retryAfter: '60' });
  f.controller.dispose();
});

test('preserves an explicit image-fetch rate limit and closes its observer with the page', async () => {
  const f = fixture();
  await f.respond({ getOfficialTrackingSliderCaptcha: { success: false, errorCode: 'SLIDER_FETCH_RATE_LIMITED' } });
  assert.deepEqual(await f.controller.prepare(0), { status: 429 });
  f.page.emit('close');
  assert.equal(f.page.listenerCount('response'), 0);
});

test('an image offered after preparation is solved without blocking the existing Turnstile path', async () => {
  let f, done;
  const finished = new Promise(resolve => { done = resolve; });
  f = fixture({ solve: async () => ({ x: 200 }), up: async () => {
    await f.respond({ verifyOfficialTrackingSlider: { success: true, sliderToken: 'SYNTHETIC_TOKEN' } }, verifyQuery());
    done();
  } });
  assert.equal(await f.controller.prepare(6000), undefined);
  await f.respond({ getOfficialTrackingSliderCaptcha: challenge() });
  await finished;
  assert.equal(f.stats().downs, 1);
  f.controller.dispose();
});

const python = process.env.SWIFTX_SLIDER_PYTHON ?? '/opt/zto-ocr/bin/python';
test('locates synthetic cutouts and image seams and rejects ambiguous images', { skip: !existsSync(python) }, () => {
  execFileSync(python, [fileURLToPath(new URL('./swiftx-slider.test.py', import.meta.url))], {
    timeout: 10_000, stdio: 'pipe', env: { ...process.env, OPENBLAS_NUM_THREADS: '1' },
  });
});
