import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { FedExSessions, fedexSessionNumber } from './fedex-session.mjs';

const API = 'https://api.fedex.com/track/v2/shipments';
const NUMBER = '999999999999';
const OTHER = '999999999998';
const capture = { captureResponses: [API] };
const url = number => `https://www.fedex.com/fedextrack/?trknbr=${number}`;
const payload = number => JSON.stringify({ output: { packages: [{ trackingNbr: number, keyStatus: 'Delivered' }] } });
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(replies = [], settings = {}) {
  const browser = new EventEmitter();
  const contexts = [], requests = [], replacements = [];
  let policies = 0, navigations = 0;
  browser.newContext = async () => {
    const page = new EventEmitter();
    const context = { closed: false, async close() { this.closed = true; }, async newPage() { return page; } };
    contexts.push(context);
    page.isClosed = () => context.closed;
    page.goto = async target => { navigations++; assert.equal(target, 'https://www.fedex.com/fedextrack/'); await settings.navigationGate; };
    page.content = async () => '<html><body>Tracking</body></html>';
    let entered, opened = false;
    page.locator = () => ({ first: () => ({
      fill: async number => { entered = number; },
      inputValue: async () => entered,
      isVisible: async () => opened,
    }) });
    page.getByRole = (_, { name }) => {
      const act = async () => {
      if (name === 'Track Another Shipment') { opened = true; return; }
      if (!(name instanceof RegExp)) return;
      const spec = replies.shift() ?? {};
      const request = number => ({ url: () => API, method: () => 'POST',
        postDataJSON: () => ({ trackingInfo: [{ trackNumberInfo: { trackingNumber: number } }] }) });
      const response = (req, body, part = spec) => ({ request: () => req,
        status: () => part.status ?? 200,
        headers: () => ({ 'content-type': 'application/json', ...part.headers }),
        body: async () => { await part.bodyGate; return Buffer.from(body); },
      });
      requests.push(entered);
      const req = request(entered);
      if (spec.stale) page.emit('response', response(request(entered), 'stale response'));
      page.emit('request', req);
      if (spec.unrelated) {
        const unrelated = request(OTHER);
        page.emit('request', unrelated);
        page.emit('response', response(unrelated, payload(OTHER)));
      }
      page.emit('response', response(req, spec.body ?? payload(entered)));
      const submittedNumber = entered;
      for (const following of spec.following ?? []) setTimeout(() => {
        if (context.closed) return;
        const next = request(following.number ?? submittedNumber);
        page.emit('request', next);
        if (following.pending) return;
        if (following.failed) page.emit('requestfailed', next);
        else page.emit('response', response(next, following.body ?? payload(submittedNumber), following));
      }, following.after ?? 0);
      opened = false;
      };
      return { evaluate: act, click: async () => {
        if (settings.mouseStallsBeforeSubmit && name instanceof RegExp) throw new Error('Mouse stalled');
        if (settings.mouseStallsBeforeMenu && name === 'Track Another Shipment') throw new Error('Mouse stalled');
        await act();
        if (settings.mouseStallsAfterSubmit && name instanceof RegExp) throw new Error('Mouse stalled');
      } };
    };
    return context;
  };
  const sessions = settings.sessions ?? new FedExSessions({ settleMs: 0, incompleteSettleMs: 0, onRefusal: () => {}, onSessionEnd: () => {}, ...settings });
  const handle = { browser, requestBrowserReplacement: reason => replacements.push(reason) };
  const run = (number = NUMBER, options = {}) => sessions.run({ url: url(number), handle, tier: 3,
    maxTimeout: 1000, capture, installPolicy: async () => { policies++; }, ...options });
  const close = async () => { browser.emit('disconnected'); await tick(); };
  return { browser, contexts, requests, replacements, run, close, policies: () => policies, navigations: () => navigations };
}

test('session route requires the exact FedEx page, one number and one capture endpoint', () => {
  assert.equal(fedexSessionNumber(url(NUMBER), capture), NUMBER);
  assert.equal(fedexSessionNumber(url(NUMBER).replace('/fedextrack/', '/wtrk/track/'), capture), NUMBER);
  // A made-up twenty-digit Ground Economy number.
  assert.equal(fedexSessionNumber(url('61299999999900000010'), capture), '61299999999900000010');
  for (const candidate of [url(NUMBER).replace('www.fedex.com', 'other.test'),
    url(NUMBER).replace('/fedextrack/', '/other/'), url('wrong'), url(NUMBER) + '&trknbr=' + OTHER,
    url('6129999999990000001'), url('612999999999000000100')]) {
    assert.equal(fedexSessionNumber(candidate, capture), null);
  }
  assert.equal(fedexSessionNumber(url(NUMBER), { captureResponses: [API, 'https://other.test'] }), null);
  assert.equal(fedexSessionNumber(url(NUMBER)), null);
});

test('keeps a verified context across tiers and makes a new request for each number', async () => {
  const f = fixture([{}, { unrelated: true }]);
  const cold = await f.run();
  const warm = await f.run(OTHER, { tier: 2 });
  assert.equal(cold.reason, 'fedex-session-new');
  assert.equal(warm.reason, 'fedex-session-reused');
  assert.equal(warm.tier, 2);
  assert.deepEqual(f.requests, [NUMBER, OTHER]);
  assert.equal(f.contexts.length, 1);
  assert.equal(f.policies(), 1);
  assert.equal(f.navigations(), 2);
  assert.equal(JSON.parse(warm.capturedResponses[0].body).output.packages[0].trackingNbr, OTHER);
  assert.deepEqual(warm.cookies, []);
  await f.close();
  assert.equal(f.contexts[0].closed, true);
});

test('ignores a response for another submitted number', async () => {
  const f = fixture([{ unrelated: true }]);
  const result = await f.run();
  assert.equal(JSON.parse(result.capturedResponses[0].body).output.packages[0].trackingNbr, NUMBER);
  await f.close();
});

test('ignores a late response for the same number from an earlier request', async () => {
  const f = fixture([{}, { stale: true }]);
  await f.run();
  const result = await f.run();
  assert.equal(result.capturedResponses[0].body, payload(NUMBER));
  assert.equal(result.reason, 'fedex-session-reused');
  await f.close();
});

test('classifies an edge denial while retaining only safe response headers', async () => {
  const f = fixture([{ status: 403, headers: {
    'content-type': 'text/html; charset=utf-8',
    server: 'AkamaiGHost',
    'retry-after': '30',
    'set-cookie': 'private-value',
    'x-reference-error': 'private-reference',
  } }]);
  const result = await f.run();
  assert.deepEqual(result.capturedResponses[0], {
    url: API,
    status: 403,
    body: null,
    truncated: false,
    base64Encoded: false,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      server: 'AkamaiGHost',
      'retry-after': '30',
    },
    error: 'fedex-edge-denial',
  });
  await f.close();
});

test('retains a refusal and the page\'s later automatic successful reply without submitting twice', async () => {
  const reports = [];
  const full = JSON.stringify({ output: { packages: [{ trackingNbr: NUMBER, keyStatus: 'Delivered', scanEventList: [{}] }] } });
  const f = fixture([{ status: 403, following: [{ after: 10, body: full }] }],
    { settleMs: 5, incompleteSettleMs: 25, onRefusal: fields => reports.push(fields) });
  const result = await f.run();
  assert.deepEqual(result.capturedResponses.map(x => x.status), [403, 200]);
  assert.deepEqual(f.requests, [NUMBER]);
  assert.equal(f.contexts[0].closed, false);
  assert.equal(reports[0].responses, 2);
  assert.equal(reports[0].recovered, true);
  await f.close();
});

test('waits for the history after an initial scan-less summary and retains the sequence', async () => {
  const full = JSON.stringify({ output: { packages: [{ trackingNbr: NUMBER, keyStatus: 'Delivered', scanEventList: [{}] }] } });
  const f = fixture([{ following: [{ after: 10, body: full }] }], { settleMs: 5, incompleteSettleMs: 25 });
  const result = await f.run();
  assert.equal(result.capturedResponses.length, 2);
  assert.equal(result.capturedResponses.at(-1).body, full);
  await f.close();
});

test('keeps a final refusal after an earlier success and discards that context', async () => {
  const f = fixture([{ following: [{ after: 10, status: 403 }] }], { incompleteSettleMs: 25 });
  const result = await f.run();
  assert.deepEqual(result.capturedResponses.map(x => x.status), [200, 403]);
  assert.equal(f.contexts[0].closed, true);
  await f.close();
});

test('an unfinished later request cannot leave an earlier success as the answer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture([{ following: [{ after: 10, pending: true }] }], { incompleteSettleMs: 25 });
  const pending = f.run(NUMBER, { maxTimeout: 1000 });
  await tick();
  t.mock.timers.tick(10);
  await tick();
  t.mock.timers.tick(970);
  const result = await pending;
  assert.deepEqual(result.capturedResponses.map(x => x.status), [200, 0]);
  assert.equal(result.capturedResponses.at(-1).error, 'fedex-tracking-request-failed');
  assert.equal(f.contexts[0].closed, true);
  await f.close();
});

test('caps an automatic response sequence and leaves no response listeners behind', async () => {
  const f = fixture([{ following: Array.from({ length: 30 }, () => ({})) }], { incompleteSettleMs: 25 });
  const result = await f.run();
  assert.equal(result.capturedResponses.length, 20);
  await f.close();
});

test('refusal diagnostics distinguish a new browser from a reused verified session without live data', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const reports = [];
  const f = fixture([{ status: 403 }, {}, { status: 401 }, { status: 403 }], { onRefusal: fields => reports.push(fields) });
  await f.run();
  t.mock.timers.tick(10);
  await f.run();
  t.mock.timers.tick(20);
  await f.run(OTHER);
  t.mock.timers.tick(30);
  await f.run();
  assert.deepEqual(reports, [
    { host: 'api.fedex.com', tier: 3, browser: undefined, statusCode: 403, cause: 'api', session: 'new',
      sessionAgeMs: 0, idleMs: null, browserLookups: 1, sinceSuccessMs: null },
    { host: 'api.fedex.com', tier: 3, browser: undefined, statusCode: 401, cause: 'api', session: 'reused',
      sessionAgeMs: 20, idleMs: 20, browserLookups: 3, sinceSuccessMs: 20 },
    { host: 'api.fedex.com', tier: 3, browser: undefined, statusCode: 403, cause: 'api', session: 'new',
      sessionAgeMs: 0, idleMs: 30, browserLookups: 4, sinceSuccessMs: 50 },
  ]);
  assert.ok(!JSON.stringify(reports).includes(NUMBER));
  assert.ok(!JSON.stringify(reports).includes(OTHER));
  await f.close();
});

test('refusal reporting cannot turn a captured refusal into a different failure', async () => {
  const f = fixture([{ status: 403 }], { onRefusal: () => { throw new Error('logging unavailable'); } });
  const result = await f.run();
  assert.equal(result.status, 'success');
  assert.equal(result.capturedResponses[0].status, 403);
  assert.equal(f.contexts[0].closed, true);
  await f.close();
});

test('refreshes the same number through the blank form without replacing its context', async () => {
  const f = fixture();
  await f.run();
  assert.equal((await f.run()).reason, 'fedex-session-reused');
  assert.equal(f.contexts.length, 1);
  assert.equal(f.navigations(), 2);
  assert.deepEqual(f.requests, [NUMBER, NUMBER]);
  await f.close();
});

for (const spec of [
  { status: 403 },
  { status: 429, headers: { 'retry-after': '120' } },
  { body: payload(OTHER) },
  { body: '{invalid' },
  { body: JSON.stringify({ output: { packages: [] } }) },
  { headers: { 'content-length': '2000001' } },
]) test(`discards an unverified session and preserves its reply: ${JSON.stringify(spec)}`, async () => {
  const f = fixture([{}, spec, {}]);
  await f.run();
  const rejected = await f.run();
  assert.equal(f.contexts[0].closed, true);
  assert.equal(rejected.capturedResponses[0].status, spec.status ?? 200);
  if (spec.headers?.['retry-after']) assert.equal(rejected.capturedResponses[0].headers['retry-after'], '120');
  assert.equal((await f.run()).reason, 'fedex-session-new');
  assert.equal(f.contexts.length, 2);
  await f.close();
});

test('expires idle contexts and removes their browser listener', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture([], { idleMs: 50 });
  await f.run();
  assert.equal(f.browser.listenerCount('disconnected'), 1);
  t.mock.timers.tick(51);
  await tick();
  assert.equal(f.contexts[0].closed, true);
  assert.equal(f.browser.listenerCount('disconnected'), 0);
  assert.equal((await f.run()).reason, 'fedex-session-new');
  await f.close();
});

test('successful activity does not extend the maximum session age', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture([], { idleMs: 100, maxAgeMs: 150 });
  await f.run();
  t.mock.timers.tick(80);
  assert.equal((await f.run()).reason, 'fedex-session-reused');
  t.mock.timers.tick(71);
  await tick();
  assert.equal(f.contexts[0].closed, true);
  assert.equal((await f.run()).reason, 'fedex-session-new');
  await f.close();
});

test('rejects overlapping calls without disturbing the active session', async () => {
  let release;
  const f = fixture([{ bodyGate: new Promise(resolve => { release = resolve; }) }]);
  const active = f.run();
  await tick();
  assert.equal((await f.run()).reason, 'FedEx browser session is busy');
  release();
  assert.equal((await active).capturedResponses[0].status, 200);
  assert.equal((await f.run()).reason, 'fedex-session-reused');
  await f.close();
});

test('a budget timeout closes the context and cannot leave a reusable session', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let release;
  const f = fixture([], { navigationGate: new Promise(resolve => { release = resolve; }) });
  const pending = f.run(NUMBER, { maxTimeout: 20 });
  await tick();
  t.mock.timers.tick(20);
  assert.equal((await pending).status, 'error');
  assert.equal(f.contexts[0].closed, true);
  release();
  await tick();
  assert.equal((await f.run()).reason, 'fedex-session-new');
  await f.close();
});

test('returns a captured unreadable body before the deadline without keeping its context', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture([{ bodyGate: new Promise(() => {}) }]);
  const pending = f.run(NUMBER, { maxTimeout: 1000 });
  await tick();
  t.mock.timers.tick(980);
  const result = await pending;
  assert.equal(result.status, 'success');
  assert.equal(result.capturedResponses.length, 1);
  assert.equal(result.capturedResponses[0].status, 200);
  assert.equal(result.capturedResponses[0].body, null);
  assert.equal(result.capturedResponses[0].truncated, true);
  assert.equal(result.capturedResponses[0].error, 'tracking response could not be read');
  assert.equal(f.contexts[0].closed, true);
  assert.equal((await f.run()).reason, 'fedex-session-new');
  await f.close();
});

test('failed cleanup requests browser replacement instead of waiting indefinitely', async () => {
  const f = fixture([{}, { status: 403 }], { closeMs: 10 });
  await f.run();
  f.contexts[0].close = () => new Promise(() => {});
  const result = await f.run();
  assert.equal(result.capturedResponses[0].status, 403);
  assert.deepEqual(f.replacements, ['FedEx session cleanup failed']);
  await f.close();
});

test('a context created after the deadline is closed instead of retained', async () => {
  const f = fixture();
  let finish;
  const context = { closed: false, async close() { this.closed = true; } };
  f.browser.newContext = () => new Promise(resolve => { finish = resolve; });
  assert.equal((await f.run(NUMBER, { maxTimeout: 20 })).status, 'error');
  assert.deepEqual(f.replacements, ['FedEx session setup did not finish']);
  finish(context);
  await tick();
  assert.equal(context.closed, true);
  assert.equal(f.browser.listenerCount('disconnected'), 0);
});

for (const setting of ['mouseStallsBeforeMenu', 'mouseStallsBeforeSubmit', 'mouseStallsAfterSubmit']) {
  test(`recovers a stalled mouse action without duplicate tracking: ${setting}`, async () => {
    const f = fixture([], { [setting]: true });
    assert.equal((await f.run()).capturedResponses[0].status, 200);
    assert.deepEqual(f.requests, [NUMBER]);
    await f.close();
  });
}

test('pool affinity returns to a verified browser and releases rejected affinity', async () => {
  const sessions = new FedExSessions();
  const a = fixture([{ status: 403 }], { sessions });
  const b = fixture([{}, { status: 403 }], { sessions });
  const entries = [{ browser: a.browser }, { browser: b.browser }];
  assert.equal(sessions.preferred(entries, 'www.fedex.com'), entries[0]);
  await a.run();
  assert.equal(sessions.preferred(entries, 'www.fedex.com'), entries[1]);
  await b.run();
  assert.equal(sessions.preferred(entries, 'www.fedex.com'), entries[1]);
  await b.run();
  assert.equal(sessions.preferred(entries, 'www.fedex.com'), entries[0]);
  assert.equal(sessions.preferred(entries, 'other.test'), undefined);
  await a.close(); await b.close();
});


test('session-end warnings identify an inconclusive read that discards verified clearance without exposing reply data', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const reports = [];
  const empty = JSON.stringify({ output: { packages: [{ trackingNbr: NUMBER, keyStatus: 'PRIVATE placeholder',
    recipient: 'PRIVATE recipient', errorList: [{ code: 'TRACKINGNUMBER.NOTFOUND' }] }] } });
  const f = fixture([{}, { body: empty }], { onSessionEnd: fields => reports.push(fields) });
  await f.run();
  t.mock.timers.tick(7);
  const result = await f.run();
  assert.equal(result.capturedResponses[0].body, empty);
  assert.equal(f.contexts[0].closed, true);
  assert.deepEqual(reports, [{ host: 'api.fedex.com', browser: undefined, reason: 'no_tracking',
    sessionAgeMs: 7, lookups: 2, digits: 12, hadVerifiedLookup: true, idleMs: 0, sinceVerifiedMs: 7 }]);
  assert.equal(JSON.stringify(reports).includes(NUMBER), false);
  assert.equal(JSON.stringify(reports).includes('PRIVATE'), false);
  assert.equal((await f.run()).reason, 'fedex-session-new');
  await f.close();
});

for (const [reason, spec] of [
  ['no_tracking', { body: JSON.stringify({ output: { packages: [{ trackingNbr: NUMBER, errorList: [{ code: 'TRACKINGNUMBER.INVALID' }] }] } }) }],
  ['identity', { body: JSON.stringify({ output: { packages: [{ trackingNbr: OTHER, keyStatus: 'PRIVATE' }] } }) }],
  ['empty_result', { body: JSON.stringify({ output: { packages: [] } }) }],
  ['verification_required', { body: JSON.stringify({ output: { packages: [{ trackingNbr: NUMBER, errorList: [{ code: 'AUTHORIZATION.REQUIRED' }] }] } }) }],
  ['missing_status', { body: JSON.stringify({ output: { packages: [{ trackingNbr: NUMBER }] } }) }],
  ['unreadable', { body: '{PRIVATE' }],
  ['api_denied', { status: 403 }],
  ['api_error', { status: 503 }],
]) test(`session-end diagnostics distinguish ${reason} without promoting a cold context`, async () => {
  const reports = [], f = fixture([spec], { onSessionEnd: fields => reports.push(fields) });
  await f.run();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].reason, reason);
  assert.equal(reports[0].hadVerifiedLookup, false);
  assert.equal(reports[0].sinceVerifiedMs, null);
  assert.equal(f.contexts[0].closed, true);
  assert.equal((await f.run()).reason, 'fedex-session-new');
  await f.close();
});

for (const [reason, settings] of [['idle', { idleMs: 20, maxAgeMs: 100 }], ['max_age', { idleMs: 100, maxAgeMs: 20 }]]) {
  test(`records ${reason} expiry exactly once with the last verified lookup age`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const reports = [], f = fixture([], { ...settings, onSessionEnd: fields => reports.push(fields) });
    await f.run();
    t.mock.timers.tick(21);
    await tick();
    assert.equal(f.contexts[0].closed, true);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].reason, reason);
    assert.equal(reports[0].hadVerifiedLookup, true);
    assert.equal(reports[0].idleMs, 21);
    assert.equal(reports[0].sinceVerifiedMs, 21);
    await f.close();
    assert.equal(reports.length, 1);
  });
}

test('names a disconnected browser and an unexpectedly closed page separately', async () => {
  const reports = [], f = fixture([], { onSessionEnd: fields => reports.push(fields) });
  await f.run();
  f.contexts[0].closed = true;
  await f.run();
  assert.equal(reports[0].reason, 'page_closed');
  await f.close();
  assert.equal(reports[1].reason, 'browser_disconnected');
});

test('a failed session-end reporter cannot prevent disposal or change the captured reply', async () => {
  const f = fixture([{ status: 403 }], { onSessionEnd: () => { throw new Error('PRIVATE diagnostics'); } });
  assert.equal((await f.run()).capturedResponses[0].status, 403);
  assert.equal(f.contexts[0].closed, true);
  assert.equal((await f.run()).reason, 'fedex-session-new');
  await f.close();
});
