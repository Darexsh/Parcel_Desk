import { test } from 'node:test';
import assert from 'node:assert/strict';
import { magyarPostaBrowserNumber, runMagyarPostaBrowser } from './magyar-posta-browser.mjs';

const number = 'ZZ000000014HU';
const url = `https://www.posta.hu/nyomkovetes/nyitooldal?searchvalue=${number}`;
const tracker = 'https://www.posta.hu/ikrnyomkovproxy/';
const search = 'https://www.posta.hu/ikrnyomkovproxy/Search/Search';
const endpoint = 'https://www.posta.hu/ikrnyomkovproxy/Result/Index';
const capture = { captureResponses: [endpoint] };
const page = '<form><input id="Ids" value="ZZ000000014HU" /><script>PRIVATE</script>'
  + '<input name="__RequestVerificationToken" type="hidden" value="PRIVATE" /></form>';
const post = (ids = number, typed = ids) => ({ method: () => 'POST',
  postData: () => new URLSearchParams({ Ids: ids, CaptchaResponse: 'PRIVATE', SearchIds: typed }).toString() });
const response = (target, status, request, value = '') => ({ url: () => target, status: () => status, request: () => request,
  headers: () => ({ 'set-cookie': 'PRIVATE', 'content-type': 'text/html' }), body: async () => Buffer.from(value) });
const get = from => ({ method: () => 'GET', redirectedFrom: () => from });
// A frame whose page shows Google's block page, an audio error, or neither, in any language.
const frame = (address, { blocked = false, error = '' } = {}) => ({ url: () => address, evaluate: async fn => {
  const shown = (visible, text) => visible ? { getClientRects: () => [{}], textContent: text } : null;
  const document = { querySelector: selector => selector.includes('rc-doscaptcha') ? shown(blocked, 'PRIVATE')
    : selector === '.rc-audiochallenge-error-message' ? { getClientRects: () => error ? [{}] : [], textContent: error } : null };
  const saved = [globalThis.document, globalThis.getComputedStyle];
  Object.assign(globalThis, { document, getComputedStyle: () => ({ visibility: 'visible' }) });
  try { return fn(); } finally { [globalThis.document, globalThis.getComputedStyle] = saved; }
} });
const challenge = 'https://www.google.com/recaptcha/api2/bframe?hl=HU&v=PRIVATE&k=PRIVATE';

function fixture() {
  const handlers = {}, state = { closed: 0, policy: 0, cookies: [], visited: [], filled: [], clicked: 0 };
  const searched = post();
  const tab = { on: (name, fn) => { handlers[name] = fn; }, off: name => { delete handlers[name]; },
    goto: async target => { state.visited.push(target); return { status: () => 200 }; },
    frames: () => [],
    locator: selector => ({
      fill: async value => { state.filled.push([selector, value]); },
      click: async () => {
        state.clicked++;
        // Another number's search and a result page nobody searched for are ignored.
        const other = post('ZZ000000028HU');
        handlers.response(response(search, 302, other));
        handlers.response(response(endpoint, 200, get(other), page.replace(number, 'ZZ000000028HU')));
        handlers.response(response(endpoint, 200, get(null), page));
        handlers.response(response(search, 302, searched));
        handlers.response(response(endpoint, 200, get(searched), page));
      },
    }),
  };
  const options = { url, capture, tier: 3, maxTimeout: 6000,
    handle: { browser: { newContext: async () => ({ newPage: async () => tab, addCookies: async rows => { state.cookies.push(...rows); },
      close: async () => { state.closed++; } }) } },
    installPolicy: async () => { state.policy++; },
    solveCaptcha: async () => true,
  };
  return { options, handlers, state, tab, searched };
}

test('accepts only the public page for one whole number and the exact result endpoint', () => {
  assert.equal(magyarPostaBrowserNumber(url, capture), number);
  for (const candidate of [url + '#extra', url + '&searchvalue=' + number, url.replace(number, 'ZZ00000'),
    url.replace(number, number.toLowerCase()), url.replace(number, `${number},ZZ000000028HU`), url.replace(number, 'ABCDEFGHIJ'),
    url.replace('www.posta.hu', 'example.test'), url.replace('www.posta.hu', 'user@www.posta.hu'),
    url.replace('/nyomkovetes/nyitooldal', '/ikrnyomkovproxy/')]) {
    assert.equal(magyarPostaBrowserNumber(candidate, capture), null);
  }
  assert.equal(magyarPostaBrowserNumber(url, { captureResponses: [endpoint + '?extra'] }), null);
  assert.equal(magyarPostaBrowserNumber(url, { captureResponses: [endpoint, search] }), null);
});

test('searches the framed tracker in Hungarian and keeps the bound result without scripts or tokens', async () => {
  const active = fixture();
  const result = await runMagyarPostaBrowser(active.options);
  assert.deepEqual(active.state.visited, ['https://www.posta.hu/ikrnyomkovproxy/']);
  assert.deepEqual(active.state.cookies.map(row => [row.name, row.value, row.path]), [['.Nyomkov.Culture', 'HU', '/ikrnyomkovproxy']]);
  assert.deepEqual(active.state.filled, [['#main_search_content', number]]);
  assert.deepEqual(result.capturedResponses.map(row => [row.url, row.status, row.trackingNumberSubmitted]),
    [[search, 302, undefined], [endpoint, 200, number]]);
  assert.match(result.capturedResponses[1].body, /value="ZZ000000014HU"/);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(result.html, ''); assert.equal(active.state.closed, 1); assert.equal(active.state.policy, 1);
  assert.deepEqual(active.handlers, {});
});

test('does not search without a solved checkbox and keeps refusals and failures', async () => {
  const unsolved = fixture(); unsolved.options.solveCaptcha = async () => false;
  assert.deepEqual((await runMagyarPostaBrowser(unsolved.options)).capturedResponses, []);
  assert.equal(unsolved.state.clicked, 0); assert.equal(unsolved.state.closed, 1);

  const refused = fixture();
  refused.tab.locator = () => ({ fill: async () => {}, click: async () => {
    refused.handlers.response(response(search, 200, refused.searched, '<span>IKRNYOM_HIBA_CAPTCHA_VALIDATACIO</span> PRIVATE'));
  } });
  const answer = await runMagyarPostaBrowser(refused.options);
  assert.deepEqual(answer.capturedResponses.map(row => [row.url, row.status, row.body, row.error]),
    [[search, 200, null, 'Magyar Posta refused the verification']]);

  for (const status of [429, 503]) {
    const failed = fixture();
    failed.tab.locator = () => ({ fill: async () => {}, click: async () => {
      failed.handlers.response(response(search, status, failed.searched));
    } });
    assert.equal((await runMagyarPostaBrowser(failed.options)).capturedResponses.at(-1).status, status);
  }

  const blocked = fixture(); blocked.tab.goto = async () => ({ status: () => 403 });
  const page = await runMagyarPostaBrowser(blocked.options);
  assert.equal(page.statusCode, 403); assert.deepEqual(page.capturedResponses, []); assert.equal(blocked.state.clicked, 0);

  const late = fixture(); late.options.maxTimeout = 30;
  late.tab.goto = () => { late.handlers.response(response(search, 302, late.searched)); return new Promise(() => {}); };
  const ended = await runMagyarPostaBrowser(late.options);
  assert.deepEqual(ended.capturedResponses.map(row => row.status), [302]); assert.equal(late.state.closed, 1);
});

test('bounds bodies and repeated responses', async () => {
  const large = fixture();
  large.tab.locator = () => ({ fill: async () => {}, click: async () => {
    large.handlers.response(response(search, 302, large.searched));
    large.handlers.response(response(endpoint, 200, get(large.searched), 'x'.repeat(1_000_001)));
  } });
  assert.equal((await runMagyarPostaBrowser(large.options)).capturedResponses.at(-1).truncated, true);
  const many = fixture();
  many.tab.locator = () => ({ fill: async () => {}, click: async () => {
    for (let i = 0; i < 12; i++) many.handlers.response(response(search, 302, many.searched));
  } });
  const result = await runMagyarPostaBrowser(many.options);
  assert.equal(result.capturedResponses.length, 10); assert.match(result.capturedResponses.at(-1).error, /limit/);
});

test('ends the solve as a challenge once Google refuses the audio answer or the address', async () => {
  for (const shows of [{ error: 'Több helyes megoldást kell megadni. PRIVATE' }, { blocked: true }]) {
    const refused = fixture(); let aborted;
    refused.options.maxTimeout = 20000;
    refused.options.solveCaptcha = (page, timeout, signal) => new Promise(() => { signal.addEventListener('abort', () => { aborted = true; }); });
    refused.tab.frames = () => [frame('https://www.posta.hu/'), frame(challenge, shows)];
    const result = await runMagyarPostaBrowser(refused.options);
    assert.equal(result.status, 'success'); assert.ok(result.durationMs < 2000);
    assert.deepEqual(result.capturedResponses.map(row => [row.url, row.status, row.body, row.error]),
      [[tracker, 200, null, 'Google refused the audio challenge']]);
    assert.equal(aborted, true); assert.equal(refused.state.clicked, 0); assert.equal(refused.state.closed, 1);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  }

  // The solver can stop at the refusal first. The frame still shows it, so it is still a refusal.
  const first = fixture(); let shown = false;
  first.options.maxTimeout = 20000;
  first.options.solveCaptcha = async () => { shown = true; return false; };
  first.tab.frames = () => [frame(challenge, { blocked: shown })];
  assert.equal((await runMagyarPostaBrowser(first.options)).capturedResponses.at(-1).error, 'Google refused the audio challenge');

  // Only the challenge frame counts: the checkbox frame and a lookalike host are ignored.
  const asking = fixture(); asking.options.maxTimeout = 20000;
  asking.options.solveCaptcha = () => new Promise(resolve => setTimeout(resolve, 900, true));
  asking.tab.frames = () => [frame(challenge.replace('bframe', 'anchor'), { blocked: true }),
    frame(challenge.replace('www.google.com', 'www.google.com.example'), { blocked: true }), frame(challenge)];
  assert.equal((await runMagyarPostaBrowser(asking.options)).capturedResponses.at(-1).trackingNumberSubmitted, number);

  // A failed solve without a refusal stays unsolved, and a frame that never answers cannot hold the lookup.
  const unsolved = fixture(); unsolved.options.maxTimeout = 20000;
  unsolved.options.solveCaptcha = async () => false;
  unsolved.tab.frames = () => [frame(challenge), { url: () => challenge, evaluate: () => new Promise(() => {}) }];
  const started = Date.now();
  assert.deepEqual((await runMagyarPostaBrowser(unsolved.options)).capturedResponses, []);
  assert.ok(Date.now() - started < 3000); assert.equal(unsolved.state.clicked, 0);
});

test('ends a solve that does not answer before the browser deadline', async () => {
  const stuck = fixture(); stuck.options.maxTimeout = 5600;
  stuck.options.solveCaptcha = () => new Promise(() => {});
  const result = await runMagyarPostaBrowser(stuck.options);
  assert.equal(result.status, 'success'); assert.deepEqual(result.capturedResponses, []);
  assert.ok(result.durationMs < 5000); assert.equal(stuck.state.clicked, 0); assert.equal(stuck.state.closed, 1);
});
