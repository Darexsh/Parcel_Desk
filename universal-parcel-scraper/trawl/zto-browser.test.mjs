import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectZtoReply, runZtoBrowser, widgetState, ztoBrowserNumber } from './zto-browser.mjs';

const number = '79990000000001', api = 'https://hdgateway.zto.com/batchGetTrace';
const url = `https://www.zto.com/check/detail?waybills=${number}`, capture = { captureResponses: [api] };
const challenge = { status: false, statusCode: '10201', message: '请输入验证码', token: 'PRIVATE' };
const found = { status: true, statusCode: 'E0000', result: { items: [{ billCode: number, recipient: 'PRIVATE', traces: [
  { traceTime: 1900000000000, traceTypeCode: 'SIGNED', traceTypeDesc: '签收', traceSiteName: 'Example depot', traceDescText: 'PRIVATE' },
] }] } };
const response = (payload = found, overrides = {}) => ({ url: () => api, status: () => 200,
  request: () => ({ method: () => 'POST', postDataJSON: () => ({ items: [{ billCode: number }] }) }),
  headers: () => ({ 'content-type': 'application/json', 'set-cookie': 'PRIVATE' }),
  body: async () => Buffer.from(JSON.stringify(payload)), ...overrides });
function fixture() {
  const handlers = {}, state = { closed: 0, counted: 0, navigated: 0, reports: [] };
  const page = { on: (name, fn) => { handlers[name] = fn; }, off: name => { delete handlers[name]; },
    goto: async () => { state.navigated++; handlers.response(response()); return { status: () => 200 }; }, evaluate: async () => null,
    route: async (pattern, handler) => {
      assert.equal(pattern.test('https://hm.baidu.com/hm.js'), true);
      assert.equal(pattern.test('https://dlswbr.baidu.com/heicha/script.js'), true);
      assert.equal(pattern.test('https://api.map.baidu.com/api'), false);
      assert.equal(pattern.test('https://cap-8.dingxiang-inc.com/api/a'), false);
      let refused = false; await handler({ abort: async () => { refused = true; } }); assert.equal(refused, true);
    } };
  const context = { newPage: async () => page, close: async () => { state.closed++; } };
  return { page, context, handlers, state, options: { url, capture, tier: 3, maxTimeout: 500, report: event => state.reports.push(event),
    handle: { browser: { newContext: async () => context }, noteTemporaryContext: () => { state.counted++; } } } };
}
test('only the domestic ZTO page and exact capture endpoint enter the helper', () => {
  assert.equal(ztoBrowserNumber(url, capture), number);
  for (const value of [url + '&extra=1', url + '#x', url.replace('www.zto.com', 'example.test'), url.replace(number, number + '0'), url.replace('www.zto.com', 'user@www.zto.com')]) assert.equal(ztoBrowserNumber(value, capture), null);
  assert.equal(ztoBrowserNumber(url, { captureResponses: [api, 'https://example.test'] }), null);
});
test('projects identity and scan clocks without token or recipient fields', () => {
  assert.equal(JSON.stringify(projectZtoReply(found, number)).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(projectZtoReply(challenge, number)).includes('PRIVATE'), false);
  assert.equal(projectZtoReply(found, '79990000000002').result, undefined);
  assert.equal(projectZtoReply({ ...challenge, message: '访问频繁' }, number).message, 'rate limit');
});
test('observes before navigation and retains challenge then tracking with cleanup', async () => {
  const f = fixture();
  f.page.goto = async () => { f.handlers.response(response(challenge)); f.handlers.response(response()); return { status: () => 200 }; };
  const result = await runZtoBrowser(f.options);
  assert.equal(result.capturedResponses.length, 2);
  assert.equal(JSON.parse(result.capturedResponses[0].body).statusCode, '10201');
  assert.equal(JSON.parse(result.capturedResponses[1].body).statusCode, 'E0000');
  assert.equal(result.capturedResponses[1].trackingNumberSubmitted, number);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(f.state.closed, 1); assert.equal(f.state.counted, 1); assert.deepEqual(f.handlers, {});
});
test('ignores another identifier, method, origin and ambiguous batch', async () => {
  const f = fixture();
  f.page.goto = async () => {
    for (const r of [response(found, { url: () => api + '?x=1' }), response(found, { url: () => 'https://example.test/batchGetTrace' }),
      response(found, { request: () => ({ method: () => 'GET' }) }),
      response(found, { request: () => ({ method: () => 'POST', postDataJSON: () => ({ items: [{ billCode: '79990000000002' }] }) }) }),
      response(found, { request: () => ({ method: () => 'POST', postDataJSON: () => ({ items: [{ billCode: number }, { billCode: number }] }) }) })]) f.handlers.response(r);
    f.handlers.response(response());
  };
  assert.equal((await runZtoBrowser(f.options)).capturedResponses.length, 1);
});
test('bounds response bytes and preserves final HTTP rejections', async () => {
  for (const status of [403, 429, 503]) {
    const f = fixture(); f.page.goto = async () => { f.handlers.response(response(found, { status: () => status })); };
    const result = await runZtoBrowser(f.options);
    assert.equal(result.capturedResponses[0].status, status); assert.equal(result.capturedResponses[0].body, null);
  }
  for (const declared of [true, false]) {
    const f = fixture(); f.page.goto = async () => { f.handlers.response(response(found, {
      headers: () => ({ 'content-length': declared ? '1000001' : '20' }),
      body: async () => { assert.equal(declared, false); return Buffer.alloc(1000001); },
    })); };
    assert.equal((await runZtoBrowser(f.options)).capturedResponses[0].truncated, true);
  }
});
test('retains the challenge on deadline or cancellation and closes late contexts', async () => {
  const f = fixture(); f.page.goto = async () => { f.handlers.response(response(challenge)); return new Promise(() => {}); };
  const result = await runZtoBrowser({ ...f.options, maxTimeout: 10 });
  assert.equal(JSON.parse(result.capturedResponses[0].body).statusCode, '10201'); assert.equal(f.state.closed, 1);
  const cancelled = fixture();
  assert.equal((await runZtoBrowser({ ...cancelled.options, signal: AbortSignal.abort() })).status, 'error');
  assert.equal(cancelled.state.counted, 0);
  const late = fixture(); let release;
  late.options.handle.browser.newContext = () => new Promise(resolve => { release = resolve; });
  assert.equal((await runZtoBrowser({ ...late.options, maxTimeout: 5 })).status, 'error');
  release(late.context); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(late.state.closed, 1); assert.equal(late.state.navigated, 0);
});

const verdict = (success, path = '/api/v1', msg) => {
  const request = { method: () => 'POST', url: () => `https://cap-8.dingxiang-inc.com${path}` };
  return { url: request.url, request: () => request,
    body: async () => Buffer.from(JSON.stringify({ success, msg, token: 'PRIVATE' })) };
};
const verification = (f, success, path, msg) => {
  const r = verdict(success, path, msg);
  f.handlers.request(r.request()); f.handlers.response(r);
};
const withoutTimings = puzzles => puzzles.map(puzzle => Object.fromEntries(Object.entries(puzzle).filter(([key]) => !['readyMs', 'solveMs', 'inputMs', 'verificationMs'].includes(key))));
const slider = key => ({ type: 'slider', key: `slider:${key}` });
const characters = key => ({ type: 'characters', targets: '中通快', key: `characters:${key}`,
  box: { x: 0, y: 0, width: 330, height: 300 }, region: { x: 0, y: 40, width: 330, height: 200 } });
/** A page showing each widget in turn: Dingxiang's refresh and our answers advance it. */
function puzzlePage(f, widgets, onAnswer = () => {}) {
  let shown = 0;
  f.page.goto = async () => { f.handlers.response(response(challenge)); return { status: () => 200 }; };
  f.page.locator = () => ({ screenshot: async () => Buffer.from('image') });
  f.page.evaluate = async fn => {
    if (fn.name === 'widgetState') return widgets[shown] ?? null;
    if (fn.name === 'solveSlider') return { score: 0.83, distance: 120, start: { x: 0, y: 0 } };
    if (fn.name === 'requestReplacement') { shown++; return true; }
    if (!fn.name) return onAnswer(widgets[shown], () => { shown++; });
    return null;
  };
}

test('reports a verified run without a puzzle and leaves no reason', async () => {
  const f = fixture();
  const result = await runZtoBrowser(f.options);
  assert.equal(result.reason, undefined);
  assert.deepEqual(f.state.reports.map(({ outcome, stop, replies, firstCode, puzzles }) => ({ outcome, stop, replies, firstCode, puzzles })),
    [{ outcome: 'verified', stop: 'reply', replies: 1, firstCode: 'E0000', puzzles: [] }]);
});
test('names a challenge without a puzzle, and one the verification refused', async () => {
  const f = fixture(); f.page.goto = async () => { f.handlers.response(response(challenge)); };
  assert.equal((await runZtoBrowser({ ...f.options, maxTimeout: 1700 })).reason, 'zto-no_puzzle');
  assert.equal(f.state.reports[0].firstCode, '10201');
  const refused = fixture();
  puzzlePage(refused, [slider('a')], () => verification(refused, false));
  const result = await runZtoBrowser({ ...refused.options, maxTimeout: 2400 });
  assert.equal(result.reason, 'zto-refused');
  const [event] = refused.state.reports;
  assert.equal(event.outcome, 'refused'); assert.equal(event.stop, 'deadline');
  assert.deepEqual(withoutTimings(event.puzzles), [{ type: 'slider', verdict: 'refused', score: 0.83, method: 'fill' }]);
  assert.equal(JSON.stringify(event).includes('PRIVATE') || JSON.stringify(event).includes(number), false);
});
test('records an accepted answer before the tracking reply it unlocks', async () => {
  const f = fixture();
  puzzlePage(f, [slider('a')], () => { verification(f, true); f.handlers.response(response()); });
  const result = await runZtoBrowser({ ...f.options, maxTimeout: 5000 });
  assert.equal(result.reason, undefined);
  assert.equal(JSON.parse(result.capturedResponses.at(-1).body).statusCode, 'E0000');
  assert.equal(f.state.reports[0].outcome, 'verified');
  assert.equal(f.state.reports[0].puzzles[0].verdict, 'accepted');
  assert.equal(typeof f.state.reports[0].firstPuzzleMs, 'number');
});
test('replaces an unreadable puzzle and names a busy solver', async () => {
  const f = fixture(), answers = [{ failure: 'boxes', boxes: 9, ms: 900, waitMs: 0 }, { failure: 'busy', ms: 8000, waitMs: 8000 }];
  puzzlePage(f, [characters('a'), characters('b')]);
  const result = await runZtoBrowser({ ...f.options, maxTimeout: 12000, solveCharacters: async () => answers.shift() });
  assert.equal(result.reason, 'zto-solver_unavailable');
  const [event] = f.state.reports;
  assert.equal(event.replacements, 1);
  assert.deepEqual(withoutTimings(event.puzzles), [
    { type: 'characters', verdict: 'replaced', targets: 3, boxes: 9, ocrMs: 900, failure: 'boxes' },
    { type: 'characters', verdict: 'unanswered', targets: 3, ocrMs: 8000, waitMs: 8000, failure: 'busy' },
  ]);
});
test('answers characters in the OCR order and keeps its confidence', async () => {
  const f = fixture(), clicks = [];
  puzzlePage(f, [characters('a')], (_, next) => { clicks.push(true); if (clicks.length === 3) { verification(f, true, '/api/v2'); f.handlers.response(response()); next(); } });
  const points = [{ x: 10, y: 50 }, { x: 100, y: 60 }, { x: 200, y: 70 }];
  await runZtoBrowser({ ...f.options, maxTimeout: 12000, solveCharacters: async () => ({ points, boxes: 4, confidence: 0.4213, margin: 1.5, ms: 3100, waitMs: 0 }) });
  assert.equal(clicks.length, 3);
  assert.deepEqual(withoutTimings(f.state.reports[0].puzzles), [{ type: 'characters', verdict: 'accepted', targets: 3, boxes: 4, confidence: 0.42, margin: 1.5, ocrMs: 3100 }]);
});

test('secondary verification is escalation, and its unfinished follow-up is a deadline', async () => {
  const f = fixture();
  puzzlePage(f, [slider('a')], () => verification(f, false, '/api/v1', '二次验证'));
  const result = await runZtoBrowser({ ...f.options, maxTimeout: 2400 });
  assert.equal(result.reason, 'zto-deadline');
  const puzzle = f.state.reports[0].puzzles[0];
  assert.equal(puzzle.verdict, 'escalated');
  for (const key of ['readyMs', 'solveMs', 'inputMs', 'verificationMs']) assert.ok(Number.isFinite(puzzle[key]) && puzzle[key] >= 0, key);
  assert.equal(JSON.stringify(f.state.reports[0]).includes('二次验证'), false);
});

test('late verification replies stay with their submitted puzzle', async () => {
  const f = fixture();
  let release, clicks = 0;
  puzzlePage(f, [slider('a'), characters('b')], (state, next) => {
    if (state.type === 'slider') {
      const r = verdict(false, '/api/v1', '二次验证');
      release = () => f.handlers.response(r);
      f.handlers.request(r.request()); next();
    } else if (++clicks === 3) {
      release(); verification(f, true, '/api/v2'); f.handlers.response(response());
    }
  });
  const points = [{ x: 10, y: 50 }, { x: 100, y: 60 }, { x: 200, y: 70 }];
  const result = await runZtoBrowser({ ...f.options, maxTimeout: 10000, solveCharacters: async () => ({ points }) });
  assert.equal(result.reason, undefined);
  assert.deepEqual(f.state.reports[0].puzzles.map(p => p.verdict), ['escalated', 'accepted']);
});

test('an earlier refusal does not hide a later unfinished verification', async () => {
  const f = fixture();
  puzzlePage(f, [slider('a'), slider('b')], (state, next) => {
    if (state.key === 'slider:a') { verification(f, false); next(); }
  });
  const result = await runZtoBrowser({ ...f.options, maxTimeout: 3000 });
  assert.equal(result.reason, 'zto-deadline');
  assert.deepEqual(f.state.reports[0].puzzles.map(p => p.verdict), ['refused', 'answered']);
});

test('does not drag coordinates from a replaced slider or after cancellation', async () => {
  for (const cancelled of [false, true]) {
    const f = fixture(), controller = new AbortController();
    let current = slider('old'), drags = 0;
    f.page.goto = async () => { f.handlers.response(response(challenge)); };
    f.page.evaluate = async fn => {
      if (fn.name === 'widgetState') return current;
      if (fn.name === 'solveSlider') {
        current = null;
        if (cancelled) controller.abort();
        return { score: 0.9, distance: 100, start: { x: 0, y: 0 } };
      }
      drags++;
    };
    await runZtoBrowser({ ...f.options, maxTimeout: 1800, signal: controller.signal });
    assert.equal(drags, 0);
    assert.equal(f.state.closed, 1);
    if (!cancelled) assert.equal(f.state.reports[0].puzzles[0].verdict, 'expired');
  }
});

test('a fading puzzle is not ready merely because it has a bounding box', () => {
  const previous = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle };
  const root = { parentElement: null, getBoundingClientRect: () => ({ x: 0, y: 0, width: 330, height: 300 }) };
  const pic = { parentElement: root, getBoundingClientRect: () => ({ x: 0, y: 40, width: 330, height: 200 }), getAttribute: () => 'synthetic' };
  root.querySelector = selector => ({ '.dx_captcha_clickword_pic': pic, '.dx_captcha_clickword_hint-cnt': { textContent: '中通快' } })[selector];
  let opacity = '0';
  globalThis.document = { querySelectorAll: () => [root] };
  globalThis.getComputedStyle = node => ({ opacity: node === pic ? opacity : '1', visibility: 'visible', display: 'block' });
  try {
    assert.equal(widgetState(), null);
    opacity = '0.5'; assert.equal(widgetState(), null);
    opacity = '1'; assert.equal(widgetState().type, 'characters');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});
