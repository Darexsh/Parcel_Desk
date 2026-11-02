import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWanbBrowser, wanbBrowserNumber } from './wanbexpress-browser.mjs';

const number = 'WNBZZ9990000001YQ';
const api = 'https://tracking.wanbexpress.com/TrackPoints/Track';
const url = `https://tracking.wanbexpress.com/?trackingNumbers=${number}`;
const capture = { captureResponses: [api] };
const challenge = JSON.stringify({ Succeeded: false, Error: { Code: '0x110012' } });
const body = JSON.stringify({ Succeeded: true, Data: { TrackingNumber: number } });
const response = (value = body, status = 200, id = number) => ({
  url: () => `${api}?TrackingNumber=${id}`, status: () => status, request: () => ({ method: () => 'GET' }),
  headers: () => ({ 'content-type': 'application/json', 'set-cookie': 'PRIVATE' }), body: async () => Buffer.from(value),
});
function fixture() {
  const handlers = {}, state = { closed: 0, counted: 0, replaced: 0, policy: 0 };
  const page = { on: (name, fn) => { handlers[name] = fn; }, off: name => { delete handlers[name]; },
    goto: async target => { state.navigation = target; handlers.response(response(challenge)); return { status: () => 200 }; },
    evaluate: async (_script, requested) => {
      if (requested === undefined) return 'V3';
      state.requested = requested; handlers.response(response(body, 200, 'WNBZZ9990000002YQ')); handlers.response(response());
    },
  };
  const context = { newPage: async () => page, close: async () => { state.closed++; } };
  const options = { url, capture, tier: 3, maxTimeout: 500, handle: { browser: { newContext: async () => context },
    noteTemporaryContext: () => { state.counted++; }, requestBrowserReplacement: () => { state.replaced++; } },
  installPolicy: async () => { state.policy++; } };
  return { options, handlers, state, page };
}

test('WanbExpress runner accepts only its exact tracking URL and capture endpoint', () => {
  assert.equal(wanbBrowserNumber(url, capture), number);
  for (const candidate of [url + '#extra', url + '&trackingNumbers=' + number, url.replace('tracking.wanbexpress.com', 'example.test'),
    url.replace('tracking.wanbexpress.com', 'user@tracking.wanbexpress.com'), url.replace(number, '1234567890')]) {
    assert.equal(wanbBrowserNumber(candidate, capture), null);
  }
  assert.equal(wanbBrowserNumber(url, { captureResponses: [api, 'https://example.test'] }), null);
});

test('observes before navigation, retains the verification transition and ignores another parcel', async () => {
  const { options, handlers, state } = fixture();
  const result = await runWanbBrowser(options);
  assert.deepEqual(result.capturedResponses.map(row => row.body), [challenge, body]);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(result.html, '');
  assert.equal(state.navigation, 'https://tracking.wanbexpress.com/');
  assert.equal(state.requested, number);
  assert.equal(result.effectiveUrl, url);
  assert.equal(state.closed, 1);
  assert.equal(state.counted, 1);
  assert.equal(state.policy, 1);
  assert.deepEqual(handlers, {});
});

test('preserves a final rejection and closes when verification fails or the budget expires', async () => {
  for (const status of [403, 429]) {
    const active = fixture(); active.page.evaluate = async () => { active.handlers.response(response('PRIVATE', status)); };
    const result = await runWanbBrowser(active.options);
    assert.equal(result.capturedResponses.at(-1).status, status);
    assert.equal(result.capturedResponses.at(-1).body, null);
    assert.equal(active.state.closed, 1);
  }
  const failed = fixture(); failed.page.evaluate = async () => { throw new Error('verification failed'); };
  assert.equal((await runWanbBrowser(failed.options)).capturedResponses[0].body, challenge);
  const hung = fixture(); hung.options.maxTimeout = 20; hung.page.evaluate = () => new Promise(() => {});
  assert.equal((await runWanbBrowser(hung.options)).capturedResponses[0].body, challenge);
  assert.equal(hung.state.closed, 1);
});

test('bounds response bodies and repeated tracking responses', async () => {
  const large = fixture(); large.page.evaluate = async () => { large.handlers.response(response('x'.repeat(1_000_001))); };
  assert.equal((await runWanbBrowser(large.options)).capturedResponses.at(-1).truncated, true);
  const many = fixture(); many.page.evaluate = async () => { for (let i = 0; i < 12; i++) many.handlers.response(response(challenge)); };
  const result = await runWanbBrowser(many.options);
  assert.equal(result.capturedResponses.length, 10);
  assert.match(result.capturedResponses.at(-1).error, /limit/);
});

const verification = () => response('', 200, number);
function checkboxFixture() {
  const f = fixture();
  f.options.maxTimeout = 6000;
  f.page.evaluate = async () => 'V2';
  f.page.locator = selector => {
    assert.equal(selector, 'textarea.trackingNumberText');
    return { fill: async value => { f.state.input = value; } };
  };
  f.page.getByRole = (role, options) => {
    assert.equal(role, 'button'); assert.deepEqual(options, { name: 'Track', exact: true });
    return { click: async () => { f.state.submitted = true; } };
  };
  f.verify = () => f.handlers.response?.({ ...verification(),
    url: () => 'https://tracking.wanbexpress.com/Home/CaptchaVerify?token=SYNTHETIC_VERIFY_TOKEN&version=V2' });
  return f;
}

test('submits before solving and waits for the carrier callback and delayed history body', async () => {
  const f = checkboxFixture();
  let releaseInitial;
  f.page.goto = async () => {
    f.handlers.response({ ...response(challenge), body: () => new Promise(resolve => { releaseInitial = resolve; }) });
    return { status: () => 200 };
  };
  f.options.solveCaptcha = async () => {
    assert.equal(f.state.submitted, true);
    assert.equal(f.state.input, number);
    setTimeout(() => { f.verify(); releaseInitial(Buffer.from(challenge)); }, 5);
    setTimeout(() => {
      f.handlers.response?.(response(body, 200, 'WNBZZ9990000002YQ'));
      f.handlers.response?.({ ...response(), body: async () => {
        await new Promise(resolve => setTimeout(resolve, 5)); return Buffer.from(body);
      } });
    }, 15);
    return true;
  };
  const result = await runWanbBrowser(f.options);
  assert.deepEqual(result.capturedResponses.map(row => row.body), [challenge, body]);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_VERIFY_TOKEN'), false);
  assert.equal(f.state.closed, 1);
});

test('retains the final carrier rejection after Google accepts verification', async () => {
  for (const status of [200, 403, 429]) {
    const f = checkboxFixture();
    f.options.solveCaptcha = async () => {
      setTimeout(() => { f.verify(); f.handlers.response?.(response(challenge, status)); }, 5);
      return true;
    };
    const result = await runWanbBrowser(f.options);
    assert.equal(result.capturedResponses.length, 2);
    assert.equal(result.capturedResponses.at(-1).status, status);
    assert.equal(result.capturedResponses.at(-1).body, status === 200 ? challenge : null);
    assert.equal(f.state.closed, 1);
  }
});

test('a refused passive flow can recover through the public checkbox form', async () => {
  for (const sdkFails of [false, true]) {
    const f = checkboxFixture();
    f.options.maxTimeout = 10000;
    f.page.goto = async target => { f.state.navigation = target; return { status: () => 200 }; };
    f.page.evaluate = async (_script, requested) => {
      if (requested === undefined) return f.state.navigation === url ? 'V2' : 'V3';
      assert.equal(requested, number); f.handlers.response(response(challenge));
      if (sdkFails) throw new Error('Passive SDK is unavailable');
    };
    f.options.solveCaptcha = async () => {
      assert.equal(f.state.navigation, url); assert.equal(f.state.input, number);
      setTimeout(() => { f.verify(); f.handlers.response?.(response()); }, 5);
      return true;
    };
    const result = await runWanbBrowser(f.options);
    assert.deepEqual(result.capturedResponses.map(row => row.body), [challenge, body]);
    assert.equal(result.effectiveUrl, url);
    assert.equal(f.state.closed, 1);
  }
});

test('does not retry passive HTTP failures or malformed data through another widget', async () => {
  for (const value of [response(challenge, 429), response('malformed'), response(body)]) {
    const f = checkboxFixture(); f.options.maxTimeout = 10000;
    let navigations = 0;
    f.page.goto = async () => { navigations++; return { status: () => 200 }; };
    f.page.evaluate = async (_script, requested) => {
      if (requested === undefined) return 'V3';
      f.handlers.response(value);
    };
    const result = await runWanbBrowser(f.options);
    assert.equal(navigations, 1);
    assert.equal(result.capturedResponses.length, 1);
  }
});

test('ends refused verification without issuing a manual tracking request', async () => {
  const f = checkboxFixture();
  f.options.solveCaptcha = async () => false;
  assert.deepEqual((await runWanbBrowser(f.options)).capturedResponses.map(row => row.body), [challenge]);
  assert.equal(f.state.closed, 1);
});

test('bounds callback waits by deadline and cancellation and closes the context', async () => {
  for (const cancelled of [false, true]) {
    const f = checkboxFixture(), controller = new AbortController();
    f.options.maxTimeout = cancelled ? 6000 : 30;
    f.options.signal = controller.signal;
    f.page.getByRole = () => ({ click: async () => { f.verify(); } });
    f.options.solveCaptcha = async () => { setTimeout(() => controller.abort(), 5); return true; };
    const result = await runWanbBrowser(f.options);
    assert.deepEqual(result.capturedResponses.map(row => row.body), [challenge]);
    assert.equal(f.state.closed, 1);
    assert.deepEqual(f.handlers, {});
  }
  const stopped = checkboxFixture(); stopped.options.signal = AbortSignal.abort();
  assert.equal((await runWanbBrowser(stopped.options)).status, 'error');
  assert.equal(stopped.state.counted, 0);
});
