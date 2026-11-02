import { test } from 'node:test';
import assert from 'node:assert/strict';
import { posteItalianeBrowserNumber, runPosteItalianeBrowser } from './poste-italiane-browser.mjs';
import { createRecaptchaAudioBackoff } from './recaptcha-backoff.mjs';
const number = 'RA00000000001';
const url = `https://www.poste.it/cerca/index.html#/risultati-spedizioni/${number}`;
const endpoint = 'https://www.poste.it/online/dovequando/DQ-REST/ricercasemplice';
const capture = { captureResponses: [endpoint] };
const gate = { id: 2, tipo: 'error', descrizione: 'CAPTCHA required', token: 'PRIVATE' };
const history = { idTracciatura: number, esitoRicerca: '3', stato: '5', recipient: 'PRIVATE',
  listaMovimenti: [{ statoLavorazione: 'Consegnato', dataOra: 1767484800000, recipient: 'PRIVATE' }] };
function response(status = 200, payload = history, request = {}) {
  const sent = { url: () => endpoint, method: () => 'POST',
    postDataJSON: () => ({ codiceSpedizione: number, tipoRichiedente: 'WEB', ...request }) };
  return { url: () => endpoint, status: () => status, headers: () => ({ 'set-cookie': 'PRIVATE' }),
    request: () => sent,
    body: async () => Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)) };
}
function fixture() {
  const handlers = {}, state = { closed: 0, policy: 0, solved: 0, signal: null, diagnostics: [] };
  const page = { on: (name, fn) => { handlers[name] = fn; }, off: name => { delete handlers[name]; },
    goto: async () => { handlers.response(response(400, gate)); return { status: () => 200 }; },
    getByRole: () => ({ click: async () => {} }) };
  const options = { url, capture, tier: 3, maxTimeout: 6000, audioBackoff: createRecaptchaAudioBackoff(),
    onVerification: fields => state.diagnostics.push(fields),
    handle: { browser: { newContext: async () => ({ newPage: async () => page, close: async () => { state.closed++; } }) } },
    installPolicy: async () => { state.policy++; },
    solveCaptcha: async (_page, _timeout, signal) => {
      state.solved++; state.signal = signal;
      handlers.response(response(200, history, { codiceSpedizione: 'RA00000000002' }));
      handlers.response(response(200, history, { captcha: 'PRIVATE' }));
      // The widget disappears on success before the solver sees its tick.
      return new Promise(resolve => signal.addEventListener('abort', () => resolve(false), { once: true }));
    } };
  return { options, handlers, state, page };
}
test('accepts only one whole identifier on the official page and exact endpoint', () => {
  assert.equal(posteItalianeBrowserNumber(url, capture), number);
  for (const candidate of [url + ',RA00000000002', url + '/extra', url.replace('www.poste.it', 'example.test'),
    url.replace('www.poste.it', 'user@www.poste.it'), url.replace('#', '?extra#'), url.replace(number, 'ABCDEF')]) {
    assert.equal(posteItalianeBrowserNumber(candidate, capture), null);
  }
  assert.equal(posteItalianeBrowserNumber(url, { captureResponses: [endpoint + '?extra'] }), null);
});
test('accepts bound history despite a removed widget, retains challenge provenance and excludes unrelated fields', async () => {
  const f = fixture(); const result = await runPosteItalianeBrowser(f.options);
  assert.deepEqual(result.capturedResponses.map(row => row.status), [400, 200]);
  assert.deepEqual(JSON.parse(result.capturedResponses[1].body), { idTracciatura: number, esitoRicerca: '3', stato: '5',
    listaMovimenti: [{ statoLavorazione: 'Consegnato', dataOra: 1767484800000 }] });
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(result.html, ''); assert.equal(f.state.closed, 1); assert.equal(f.state.policy, 1);
  assert.equal(f.state.signal.aborted, true); assert.deepEqual(f.handlers, {});
});
test('does not solve on a direct result or a non-CAPTCHA error', async () => {
  for (const reply of [response(), response(429), response(400, { id: 3, tipo: 'error' })]) {
    const f = fixture(); f.page.goto = async () => { f.handlers.response(reply); return { status: () => 200 }; };
    await runPosteItalianeBrowser(f.options);
    assert.equal(f.state.solved, 0); assert.equal(f.state.closed, 1);
  }
});
test('a blocked solve suppresses later solves, preserving the observed challenge and clear histories', async () => {
  let now = 1000;
  const backoff = createRecaptchaAudioBackoff(() => now);
  const first = fixture(); first.options.audioBackoff = backoff;
  first.options.solveCaptcha = async (_page, _timeout, _signal, report) => { report('audio_blocked'); return false; };
  assert.equal((await runPosteItalianeBrowser(first.options)).capturedResponses.at(-1).status, 400);
  // While paused, the page is not opened: it would only show the challenge again.
  const second = fixture(); second.options.audioBackoff = backoff;
  const result = await runPosteItalianeBrowser(second.options);
  assert.equal(second.state.solved, 0); assert.equal(second.state.closed, 0); assert.equal(second.state.policy, 0);
  assert.deepEqual(result.capturedResponses, []);
  assert.deepEqual(second.state.diagnostics.map(row => [row.nativeOutcome, row.outcome]), [['audio_cooldown', 'not_opened']]);
  now += 6 * 60 * 60 * 1000;
  const retry = fixture(); retry.options.audioBackoff = backoff;
  await runPosteItalianeBrowser(retry.options);
  assert.equal(retry.state.solved, 1);
});
test('a pause begun while the page loads still finishes an automatically verified tracking request in flight', async () => {
  const f = fixture();
  let deliver;
  f.page.goto = async () => {
    f.options.audioBackoff.block();
    f.handlers.response(response(400, gate));
    const verified = response(200, history, { captcha: 'PRIVATE' });
    f.handlers.request(verified.request());
    deliver = setTimeout(() => f.handlers.response(verified), 10);
    return { status: () => 200 };
  };
  try {
    const result = await runPosteItalianeBrowser(f.options);
    assert.deepEqual(result.capturedResponses.map(row => row.status), [400, 200]);
    assert.equal(f.state.solved, 0); assert.equal(f.state.closed, 1);
    assert.equal(f.state.diagnostics[0].waitedForRequest, true);
  } finally { clearTimeout(deliver); }
});
test('a restored shared pause is awaited before the Poste page opens', async () => {
  const f = fixture();
  f.options.audioBackoff = createRecaptchaAudioBackoff(() => 1000, { load: async () => 21601000 });
  const result = await runPosteItalianeBrowser(f.options);
  assert.equal(f.state.solved, 0); assert.equal(f.state.closed, 0);
  assert.deepEqual(result.capturedResponses, []);
  assert.equal(f.state.diagnostics[0].nativeOutcome, 'audio_cooldown');
});
test('waits for the final response after solver success and retains a rejected token as challenge', async () => {
  const f = fixture(); f.options.solveCaptcha = async () => { setTimeout(() => f.handlers.response(response()), 10); return true; };
  assert.equal((await runPosteItalianeBrowser(f.options)).capturedResponses.at(-1).status, 200);
  const denied = fixture(); denied.options.solveCaptcha = async () => { denied.handlers.response(response(400, gate, { captcha: 'PRIVATE' })); return true; };
  assert.deepEqual((await runPosteItalianeBrowser(denied.options)).capturedResponses.map(row => row.status), [400, 400]);
});
test('returns an unsolved challenge promptly and bounds bodies, response counts and deadline cleanup', async () => {
  const refused = fixture(); refused.options.solveCaptcha = async () => false;
  assert.equal((await runPosteItalianeBrowser(refused.options)).capturedResponses[0].status, 400);
  const large = fixture(); large.options.solveCaptcha = async () => { large.handlers.response(response(200, 'x'.repeat(1_000_001))); return true; };
  assert.equal((await runPosteItalianeBrowser(large.options)).capturedResponses.at(-1).truncated, true);
  const many = fixture(); many.options.solveCaptcha = async () => { for (let i = 0; i < 12; i++) many.handlers.response(response(400, gate)); return true; };
  const result = await runPosteItalianeBrowser(many.options);
  assert.equal(result.capturedResponses.length, 10); assert.match(result.capturedResponses.at(-1).error, /limit/);
  const deadline = fixture(); deadline.options.maxTimeout = 15; deadline.page.goto = () => new Promise(() => {});
  assert.equal((await runPosteItalianeBrowser(deadline.options)).status, 'error'); assert.equal(deadline.state.closed, 1);
});
test('finishes a verified tracking request already sent when the widget disappears', async () => {
  const f = fixture(); let deliver;
  f.options.solveCaptcha = async () => {
    const reply = response(200, history, { captcha: 'PRIVATE' });
    f.handlers.request?.(reply.request());
    deliver = setTimeout(() => f.handlers.response?.(reply), 10);
    return false;
  };
  try {
    const result = await runPosteItalianeBrowser(f.options);
    assert.deepEqual(result.capturedResponses.map(row => row.status), [400, 200]);
    assert.equal(JSON.parse(result.capturedResponses.at(-1).body).idTracciatura, number);
  } finally { clearTimeout(deliver); }
});
test('finishes reading a response body after the native solver returns false', async () => {
  const f = fixture(); let deliver;
  f.options.solveCaptcha = async () => {
    const reply = response(200, history, { captcha: 'PRIVATE' });
    reply.body = () => new Promise(resolve => { deliver = setTimeout(() => resolve(Buffer.from(JSON.stringify(history))), 10); });
    f.handlers.response(reply);
    return false;
  };
  try {
    const result = await runPosteItalianeBrowser(f.options);
    assert.equal(JSON.parse(result.capturedResponses.at(-1).body)?.idTracciatura, number);
  } finally { clearTimeout(deliver); }
});
test('does not wait for another identifier, endpoint or request method', async () => {
  const f = fixture();
  f.options.solveCaptcha = async () => {
    const wrong = response(200, history, { codiceSpedizione: number + '0' }).request();
    f.handlers.request(wrong);
    f.handlers.request({ ...response().request(), url: () => endpoint + '?extra' });
    f.handlers.request({ ...response().request(), method: () => 'GET' });
    return false;
  };
  const result = await runPosteItalianeBrowser(f.options);
  assert.deepEqual(result.capturedResponses.map(row => row.status), [400]);
  assert.equal(f.state.diagnostics[0].waitedForRequest, false);
});
test('a later failed tracking request cannot be hidden by an earlier history', async () => {
  const f = fixture();
  f.options.solveCaptcha = async () => {
    const first = response(200, history, { captcha: 'PRIVATE' });
    const last = response(200, history, { captcha: 'PRIVATE' });
    f.handlers.request(first.request()); f.handlers.request(last.request());
    f.handlers.response(first); f.handlers.requestfailed(last.request());
    return false;
  };
  const result = await runPosteItalianeBrowser(f.options);
  assert.deepEqual(result.capturedResponses.map(row => row.status), [400, 200, 0]);
  assert.equal(result.capturedResponses.at(-1).body, null);
  assert.match(result.capturedResponses.at(-1).error, /request failed/);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});
test('pending verification requests stop at the shared deadline and close their context', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(); let submitted;
  const sent = new Promise(resolve => { submitted = resolve; });
  f.options.solveCaptcha = async () => {
    f.handlers.request(response(200, history, { captcha: 'PRIVATE' }).request());
    submitted(); return false;
  };
  const lookup = runPosteItalianeBrowser(f.options);
  await sent;
  for (let i = 0; i < 12; i++) await Promise.resolve();
  t.mock.timers.tick(6001);
  const result = await lookup;
  assert.equal(result.capturedResponses.at(-1).status, 0);
  assert.match(result.capturedResponses.at(-1).error, /unfinished/);
  assert.equal(f.state.closed, 1); assert.deepEqual(f.handlers, {});
});
test('verification diagnostics keep only fixed outcomes and cannot break cleanup', async () => {
  const f = fixture();
  f.options.solveCaptcha = async (_page, _ms, _signal, report) => {
    report('audio_started'); report('audio_refused'); report('PRIVATE'); return false;
  };
  await runPosteItalianeBrowser(f.options);
  const [diagnostic] = f.state.diagnostics;
  assert.deepEqual(Object.keys(diagnostic).sort(), ['durationMs', 'nativeOutcome', 'outcome', 'pending', 'responses', 'waitedForRequest']);
  assert.equal(diagnostic.nativeOutcome, 'audio_refused'); assert.equal(diagnostic.outcome, 'challenge');
  assert.equal(JSON.stringify(diagnostic).includes('PRIVATE'), false);
  const broken = fixture(); broken.options.onVerification = () => { throw new Error('PRIVATE'); };
  assert.equal((await runPosteItalianeBrowser(broken.options)).capturedResponses.at(-1).status, 200);
  assert.equal(broken.state.closed, 1);
});
test('cancels the solver and closes only its own context on caller cancellation', async () => {
  const f = fixture(); const controller = new AbortController(); f.options.signal = controller.signal;
  f.options.solveCaptcha = async (_page, _timeout, signal) => { f.state.signal = signal; controller.abort(); return new Promise(() => {}); };
  const result = await runPosteItalianeBrowser(f.options);
  assert.equal(result.capturedResponses[0].status, 400); assert.equal(f.state.signal.aborted, true); assert.equal(f.state.closed, 1);
});
