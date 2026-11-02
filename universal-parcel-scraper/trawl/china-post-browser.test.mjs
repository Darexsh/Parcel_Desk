import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chinaPostBrowserNumber, projectChinaPostWebReply, runChinaPostBrowser } from './china-post-browser.mjs';

const number = 'ZS00000000001', other = 'ZS00000000002';
const flag = 'https://www.ems.com.cn/ems-web/trackTestQuery/getLogisticsTestFlag';
const api = 'https://www.ems.com.cn/ems-web/mailTrack/queryTrack';
const url = `https://www.ems.com.cn/queryList?mailNo=${number}`, capture = { captureResponses: [flag, api] };
const found = { success: true, token: 'PRIVATE', value: { domesticMailResultDtoList: [{ resCode: 'true', traceNo: '',
  receiverAddress: 'PRIVATE', resObj: [{ traceNo: number, bubbleTime: '2030-01-02 12:30', opStateCode: 'O_051',
    opName: '到达境外目的地', opDesc: 'PRIVATE', senderPhone: 'PRIVATE', gis: 'PRIVATE' }] }] } };
const response = (payload = found, overrides = {}) => ({ url: () => api, status: () => 200,
  request: () => ({ url: () => api, method: () => 'POST', postDataJSON: () => ({ list: [number], value: [{ orderNum: [number] }] }) }),
  headers: () => ({ 'content-type': 'application/json', 'set-cookie': 'PRIVATE' }),
  body: async () => Buffer.from(JSON.stringify(payload)), ...overrides });
function fixture() {
  const handlers = {}, state = { closed: 0, counted: 0, navigated: 0 };
  let submitted = number;
  const page = {
    on: (name, fn) => { handlers[name] = fn; }, off: name => { delete handlers[name]; },
    goto: async () => { state.navigated++; return { status: () => 200 }; },
    url: () => 'https://www.ems.com.cn/queryList',
    reload: async () => { state.navigated++; return { status: () => 200 }; },
    locator: () => ({ fill: async n => { submitted = n; }, inputValue: async () => submitted,
      waitFor: async () => {}, evaluate: async () => {} }),
    waitForResponse: async () => ({ status: () => 200, body: async () => Buffer.from(JSON.stringify({ data: {
      backgroundImageWidth: 100, backgroundImageHeight: 100,
    } })) }),
    getByRole: (_role, { name }) => ({ evaluate: async () => { if (name === '验证') handlers.response(response()); } }),
  };
  const context = { newPage: async () => page, close: async () => { state.closed++; } };
  return { page, context, handlers, state, options: { url, capture, tier: 3, maxTimeout: 200,
    solveCharacters: async () => [{ x: 20, y: 20 }, { x: 40, y: 40 }],
    handle: { browser: { newContext: async () => context }, noteTemporaryContext: () => { state.counted++; } } } };
}

test('refreshes only a completed unreadable prompt, observes the new picture and binds its history', async t => {
  const logs = []; t.mock.method(console, 'warn', text => logs.push(JSON.parse(text)));
  const f = fixture(); let pictures = 0, solves = 0, refreshes = 0, verifies = 0, displayed;
  f.page.waitForResponse = async () => ({ status: () => 200, body: async () => Buffer.from(JSON.stringify({ data: {
    id: ++pictures, backgroundImage: `synthetic-${pictures}`, backgroundImageWidth: 100, backgroundImageHeight: 100,
  } })) });
  f.page.waitForFunction = async (_predicate, image) => { displayed = image; };
  f.options.solveCharacters = async (_challenge, _signal, _budget, report) => {
    if (++solves === 1) { report('prompt'); report('prompt-unreadable'); return null; }
    assert.equal(displayed, 'synthetic-2');
    return [{ x: 20, y: 20 }, { x: 40, y: 40 }];
  };
  f.page.getByRole = (_role, { name }) => ({ evaluate: async () => {
    if (name === '刷新') { assert.equal(pictures, 1); refreshes++; }
    if (name === '验证') { verifies++; f.handlers.response(response()); }
  } });
  const result = await runChinaPostBrowser({ ...f.options, maxTimeout: 14000 });
  assert.equal(pictures, 2); assert.equal(solves, 2); assert.equal(refreshes, 1); assert.equal(verifies, 1);
  assert.equal(JSON.parse(result.capturedResponses[0].body).match, true);
  assert.equal(f.state.closed, 1);
  assert.deepEqual(logs, [{ level: 'warn', event: 'china-post.prompt-refresh', host: 'www.ems.com.cn', scans: 1 }]);
});

test('prompt refresh cannot extend the two-puzzle limit or retry an unchanged picture', async t => {
  t.mock.method(console, 'warn', () => {});
  for (const mode of ['unreadable', 'same-picture', 'same-background', 'not-displayed', 'refused']) {
    const f = fixture(); let pictures = 0, solves = 0, refreshes = 0, verifies = 0;
    f.page.waitForResponse = async () => ({ status: () => 200, body: async () => {
      pictures++;
      return Buffer.from(JSON.stringify({ data: { id: mode === 'same-picture' ? 1 : pictures,
        backgroundImage: `synthetic-${mode === 'same-background' ? 1 : pictures}`, backgroundImageWidth: 100, backgroundImageHeight: 100 } }));
    } });
    f.page.waitForFunction = async () => { if (mode === 'not-displayed') throw new Error('Display timeout'); };
    f.options.solveCharacters = async (_challenge, _signal, _budget, report) => {
      solves++; report('prompt');
      if (solves === 1 || mode === 'unreadable') { report('prompt-unreadable'); return null; }
      return [{ x: 20, y: 20 }, { x: 40, y: 40 }];
    };
    f.page.getByRole = (_role, { name }) => ({ evaluate: async () => {
      if (name === '刷新') refreshes++;
      if (name === '验证') { verifies++; f.handlers.response(response({ success: false, message: '验证失败' })); }
    } });
    const result = await runChinaPostBrowser({ ...f.options, maxTimeout: 14000 });
    assert.equal(refreshes, 1); assert.equal(pictures, 2);
    assert.equal(solves, ['same-picture', 'same-background', 'not-displayed'].includes(mode) ? 1 : 2);
    assert.equal(verifies, mode === 'refused' ? 1 : 0);
    assert.equal(result.capturedResponses.length, mode === 'refused' ? 1 : 0);
    assert.equal(f.state.closed, 1);
  }
});

test('does not refresh a worker failure, after tracking starts, cancellation or a short budget', async t => {
  t.mock.method(console, 'warn', () => {});
  for (const mode of ['worker', 'positions', 'tracking', 'cancel', 'short']) {
    const f = fixture(), control = new AbortController(); let refreshes = 0;
    f.options.solveCharacters = async (_challenge, _signal, _budget, report) => {
      report(mode === 'positions' ? 'positions' : 'prompt');
      if (!['worker', 'positions'].includes(mode)) report('prompt-unreadable');
      if (mode === 'tracking') f.handlers.request(response().request());
      if (mode === 'cancel') control.abort();
      return null;
    };
    f.page.getByRole = (_role, { name }) => ({ evaluate: async () => { if (name === '刷新') refreshes++; } });
    await runChinaPostBrowser({ ...f.options, signal: control.signal, maxTimeout: mode === 'short' ? 200 : 14000 });
    assert.equal(refreshes, 0); assert.equal(f.state.closed, 1);
  }
});

test('a recovered prompt does not misclassify stalled tracking as an unreadable challenge', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const logs = []; t.mock.method(console, 'warn', text => logs.push(JSON.parse(text)));
  const f = fixture(); let pictures = 0, solves = 0;
  f.page.waitForResponse = async () => ({ status: () => 200, body: async () => Buffer.from(JSON.stringify({ data: {
    id: ++pictures, backgroundImage: `synthetic-${pictures}`, backgroundImageWidth: 100, backgroundImageHeight: 100,
  } })) });
  f.page.waitForFunction = async () => {};
  f.options.solveCharacters = async (_challenge, _signal, _budget, report) => {
    if (++solves === 1) { report('prompt'); report('prompt-unreadable'); return null; }
    return [{ x: 20, y: 20 }, { x: 40, y: 40 }];
  };
  f.page.getByRole = () => ({ evaluate: async () => {} });
  const pending = runChinaPostBrowser({ ...f.options, maxTimeout: 14000 });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(14000);
  const result = await pending;
  assert.equal(result.reason, 'china-post-history');
  assert.equal(result.status, 'error');
  assert.equal(f.state.closed, 1);
  assert.deepEqual(logs, [{ level: 'warn', event: 'china-post.prompt-refresh', host: 'www.ems.com.cn', scans: 0 }]);
});

test('scopes the helper to the exact China Post page, number and endpoints', () => {
  assert.equal(chinaPostBrowserNumber(url, capture), number);
  for (const raw of [url + '#x', url + '&extra=1', url.replace('www.ems.com.cn', 'example.test'),
    url.replace('www.ems.com.cn', 'user@www.ems.com.cn'), url.replace(number, number + '0')]) assert.equal(chinaPostBrowserNumber(raw, capture), null);
  assert.equal(chinaPostBrowserNumber(url, { captureResponses: [api] }), null);
  assert.equal(chinaPostBrowserNumber(url.replace(number, 'ZC00000000001'), capture), 'ZC00000000001');
  assert.equal(chinaPostBrowserNumber(url.replace(number, 'ZA00000000001'), capture), 'ZA00000000001');
  assert.equal(chinaPostBrowserNumber(url.replace(number, 'ZT00000000001'), capture), null);
});
test('projects only matching scan identity, clocks and state labels', () => {
  const value = projectChinaPostWebReply(found, number);
  assert.equal(value.match, true); assert.equal(value.scans[0].state, '到达境外目的地');
  assert.equal(JSON.stringify(value).includes('PRIVATE'), false);
  assert.equal(projectChinaPostWebReply(found, other).match, false);
  assert.equal(projectChinaPostWebReply({ success: false, message: '验证失败 PRIVATE' }, number).reason, 'verification');
  assert.equal(projectChinaPostWebReply({ success: false, message: '请输入手机后四位' }, number).reason, 'phone');
});
test('observes before navigation, retains the response sequence and cleans up', async () => {
  const f = fixture();
  f.page.getByRole = (_role, { name }) => ({ evaluate: async () => {
    if (name === '验证') { f.handlers.response(response({ success: false, message: '验证失败' })); f.handlers.response(response()); }
  } });
  const result = await runChinaPostBrowser(f.options);
  assert.equal(result.capturedResponses.length, 2);
  assert.equal(JSON.parse(result.capturedResponses[0].body).reason, 'verification');
  assert.equal(JSON.parse(result.capturedResponses[1].body).match, true);
  assert.equal(result.capturedResponses[1].trackingNumberSubmitted, number);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(result.html, ''); assert.equal(f.state.closed, 1); assert.equal(f.state.counted, 1); assert.deepEqual(f.handlers, {});
});
test('ignores unrelated, partial, batched and non-POST requests', async () => {
  const f = fixture(); f.page.getByRole = (_role, { name }) => ({ evaluate: async () => {
    if (name !== '验证') return;
    for (const r of [response(found, { url: () => api + '/wrong' }), response(found, { request: () => ({ url: () => api, method: () => 'GET' }) }),
      ...[other, number.slice(0, -1)].map(n => response(found, { request: () => ({ url: () => api, method: () => 'POST', postDataJSON: () => ({ list: [n], value: [{ orderNum: [n] }] }) }) })),
      response(found, { request: () => ({ url: () => api, method: () => 'POST', postDataJSON: () => ({ list: [number, other], value: [{ orderNum: [number] }] }) }) })]) f.handlers.response(r);
    f.handlers.response(response());
  } });
  assert.equal((await runChinaPostBrowser(f.options)).capturedResponses.length, 1);
});
test('drops firewall query material while binding the endpoint and request body', async () => {
  const f = fixture(); f.page.getByRole = (_role, { name }) => ({ evaluate: async () => {
    if (name === '验证') f.handlers.response(response(found, { url: () => api + '?firewall=PRIVATE' }));
  } });
  const result = await runChinaPostBrowser(f.options);
  assert.equal(result.capturedResponses[0].url, api);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});
test('uses a fresh puzzle after an explicit refusal and keeps the refused attempt', async () => {
  const f = fixture(); let submissions = 0, solves = 0;
  f.options.solveCharacters = async () => { solves++; return [{ x: 20, y: 20 }, { x: 40, y: 40 }]; };
  f.page.getByRole = (_role, { name }) => ({ evaluate: async () => {
    if (name !== '验证') return;
    submissions++;
    f.handlers.response(submissions === 1 ? response({ success: false, message: '验证失败' }) : response());
  } });
  const r = await runChinaPostBrowser({ ...f.options, maxTimeout: 14000 });
  assert.equal(solves, 2); assert.equal(submissions, 2);
  assert.equal(JSON.parse(r.capturedResponses[0].body).reason, 'verification');
  assert.equal(JSON.parse(r.capturedResponses[1].body).match, true);
});
test('preserves rejections and bounds body reads', async () => {
  for (const overrides of [{ status: () => 403 }, { status: () => 429 }, { headers: () => ({ 'content-length': '1000001' }) },
    { body: async () => Buffer.alloc(1000001) }]) {
    const f = fixture(); f.page.getByRole = (_role, { name }) => ({ evaluate: async () => { if (name === '验证') f.handlers.response(response(found, overrides)); } });
    const r = (await runChinaPostBrowser(f.options)).capturedResponses[0];
    assert.ok(r.status !== 200 || r.truncated); assert.equal(r.body, null);
  }
});
test('distinguishes prompt and position failures without retaining solver data', async t => {
  const logs = []; t.mock.method(console, 'warn', text => { logs.push(JSON.parse(text)); });
  for (const stage of ['prompt', 'positions']) {
    const f = fixture();
    f.options.solveCharacters = async (_challenge, _signal, _timeout, report) => { report(stage); return null; };
    const result = await runChinaPostBrowser(f.options);
    assert.equal(result.reason, `china-post-characters-${stage}`);
    assert.equal(result.status, 'success');
    assert.equal(result.statusCode, 200);
    assert.equal(result.capturedResponses.length, 0);
    assert.equal(f.state.closed, 1);
  }
  const f = fixture();
  f.options.solveCharacters = async (_challenge, _signal, _timeout, report) => { report('PRIVATE'); return null; };
  const result = await runChinaPostBrowser(f.options);
  assert.equal(result.reason, 'china-post-characters');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.deepEqual(logs.map(row => row.phase), ['characters-prompt', 'characters-positions', 'characters']);
  assert.ok(logs.every(row => row.event === 'china-post.verification' && row.cause === 'unreadable'));
  assert.equal(JSON.stringify(logs).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(logs).includes(number), false);
});
test('ends stalled work, aborts OCR and closes late contexts', async () => {
  const f = fixture(); let signal;
  f.options.solveCharacters = async (_challenge, s) => { signal = s; return new Promise(() => {}); };
  await runChinaPostBrowser({ ...f.options, maxTimeout: 10 });
  assert.equal(signal.aborted, true); assert.equal(f.state.closed, 1);
  const late = fixture(); let release;
  late.options.handle.browser.newContext = () => new Promise(resolve => { release = resolve; });
  await runChinaPostBrowser({ ...late.options, maxTimeout: 5 });
  release(late.context); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(late.state.closed, 1); assert.equal(late.state.navigated, 0);
});

test('reloads a missing form once before searching and keeps only bound tracking history', async t => {
  const logs = [];
  t.mock.method(console, 'warn', text => { logs.push(JSON.parse(text)); });
  const f = fixture(), locator = f.page.locator;
  let fills = 0, searches = 0, verifies = 0;
  f.page.locator = (...args) => {
    const item = locator(...args), fill = item.fill;
    item.fill = async (...values) => {
      if (++fills === 1) {
        f.handlers.request({ url: () => api, method: () => 'POST', postDataJSON: () => ({ list: [other], value: [{ orderNum: [other] }] }) });
        throw new Error('PRIVATE selector');
      }
      await fill(...values);
    };
    return item;
  };
  f.page.getByRole = (_role, { name }) => ({ evaluate: async () => {
    if (name === '查询') searches++;
    if (name === '验证') { verifies++; f.handlers.response(response()); }
  } });
  const result = await runChinaPostBrowser({ ...f.options, maxTimeout: 30000 });
  assert.equal(f.state.navigated, 2);
  assert.equal(searches, 1); assert.equal(verifies, 1);
  assert.equal(result.capturedResponses.length, 1);
  assert.equal(JSON.parse(result.capturedResponses[0].body).match, true);
  assert.equal(f.state.closed, 1);
  assert.deepEqual(logs, [{ level: 'warn', event: 'china-post.form-reload', host: 'www.ems.com.cn', formReady: true, scans: 1 }]);
  assert.equal(JSON.stringify(logs).includes(number), false);
  assert.equal(JSON.stringify(logs).includes('PRIVATE'), false);
});

test('does not reload repeatedly, after cancellation, with a short budget or on another page', async t => {
  t.mock.method(console, 'warn', () => {});
  for (const mode of ['twice', 'short', 'aborted', 'other']) {
    const f = fixture(), control = new AbortController();
    let reloads = 0, fills = 0;
    f.page.locator = () => ({ fill: async () => { fills++; if (mode === 'aborted') control.abort(); throw new Error('PRIVATE'); } });
    f.page.reload = async () => { reloads++; return { status: () => 200 }; };
    if (mode === 'other') f.page.url = () => 'https://example.test/queryList';
    await runChinaPostBrowser({ ...f.options, maxTimeout: mode === 'short' ? 200 : 30000, signal: control.signal });
    assert.equal(reloads, mode === 'twice' ? 1 : 0);
    assert.equal(fills, mode === 'twice' ? 2 : 1);
    assert.equal(f.state.closed, 1);
  }
});

test('preserves a known firewall challenge after its final page becomes HTTP 200', async t => {
  const logs = []; t.mock.method(console, 'warn', text => { logs.push(JSON.parse(text)); });
  const f = fixture(), frame = {};
  f.page.mainFrame = () => frame;
  f.page.goto = async () => {
    f.handlers.response({ url: () => 'https://www.ems.com.cn/queryList', status: () => 412,
      request: () => ({ isNavigationRequest: () => true }), frame: () => frame });
    return { status: () => 200 };
  };
  f.page.locator = () => ({ fill: async () => { throw new Error('PRIVATE'); } });
  const result = await runChinaPostBrowser(f.options);
  assert.equal(result.status, 'success');
  assert.equal(result.statusCode, 200);
  assert.equal(result.verificationStatus, 412);
  assert.equal(result.capturedResponses.length, 0);
  assert.deepEqual(logs, [{ level: 'warn', event: 'china-post.verification', host: 'www.ems.com.cn',
    phase: 'form', cause: 'firewall', pageStatus: 200, verificationStatus: 412 }]);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('an earlier firewall response does not turn later stalled tracking into a verification failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const logs = []; t.mock.method(console, 'warn', text => { logs.push(JSON.parse(text)); });
  const f = fixture(), frame = {};
  f.page.mainFrame = () => frame;
  f.page.goto = async () => {
    f.handlers.response({ url: () => 'https://www.ems.com.cn/queryList', status: () => 412,
      request: () => ({ isNavigationRequest: () => true }), frame: () => frame });
    return { status: () => 200 };
  };
  f.page.getByRole = () => ({ evaluate: async () => {} });
  const pending = runChinaPostBrowser({ ...f.options, maxTimeout: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1000);
  const result = await pending;
  assert.equal(result.reason, 'china-post-history');
  assert.equal(result.status, 'error');
  assert.equal(result.verificationStatus, 412);
  assert.equal(result.capturedResponses.length, 0);
  assert.equal(f.state.closed, 1);
  assert.deepEqual(logs, []);
});

test('never reloads after its matching tracking request starts, even before the reply arrives', async t => {
  t.mock.method(console, 'warn', () => {});
  const f = fixture(); let reloads = 0;
  f.page.locator = () => ({ fill: async () => {
    f.handlers.request(response().request());
    throw new Error('PRIVATE pending request');
  } });
  f.page.reload = async () => { reloads++; return { status: () => 200 }; };
  const result = await runChinaPostBrowser({ ...f.options, maxTimeout: 30000 });
  assert.equal(reloads, 0);
  assert.equal(result.capturedResponses.length, 0);
  assert.equal(result.status, 'error');
  assert.equal(f.state.closed, 1);
  assert.deepEqual(f.handlers, {});
});
