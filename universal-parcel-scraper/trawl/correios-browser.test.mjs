import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correiosBrowserNumber, runCorreiosBrowser } from './correios-browser.mjs';

const number = 'AA000000005BR';
const endpoint = 'https://rastreamento.correios.com.br/app/resultado.php';
const url = `https://rastreamento.correios.com.br/app/index.php?objetos=${number}`;
const capture = { captureResponses: [endpoint] };
const body = JSON.stringify({ codObjeto: number, situacao: 'T', dtPrevista: '02/01/2026', atrasado: false, arImagem: 'PRIVATE',
  tipoPostal: { categoria: 'SEDEX', descricao: 'PRIVATE' }, urlFaleComOsCorreios: 'PRIVATE',
  eventos: [{ codigo: 'BDE', tipo: '01', descricao: 'Objeto entregue ao destinatário', token: 'PRIVATE', tokenBase64: 'PRIVATE',
    destinatario: { nome: 'PRIVATE' }, dtHrCriado: { date: '2026-01-01 10:00:00.000000', timezone_type: 3, timezone: 'America/Sao_Paulo' },
    unidade: { nome: 'PRIVATE', endereco: { cidade: 'Sampletown', uf: 'SP', logradouro: 'PRIVATE' } } }] });
const form = (objeto = number) => new URLSearchParams({ objeto, csrf_token: 'PRIVATE', website: '', 'cf-turnstile-response': 'PRIVATE', mqs: 'S' }).toString();
const response = (status = 200, value = body, sent = form()) => ({ url: () => endpoint, status: () => status,
  request: () => ({ method: () => 'POST', postData: () => sent }),
  headers: () => ({ 'content-type': 'application/json', 'set-cookie': 'PRIVATE' }), body: async () => Buffer.from(value) });
function fixture() {
  const handlers = {}, state = { closed: 0, clicked: 0, filled: [], policy: 0, token: 'PRIVATE', field: number, widget: 1, diagnostics: [] };
  const page = { on: (name, fn) => { handlers[name] = fn; }, off: name => { delete handlers[name]; },
    goto: async () => ({ status: () => 200 }),
    locator: selector => ({
      count: async () => selector.includes('cf-turnstile') ? state.widget : 1,
      inputValue: async () => selector === '#objeto' ? state.field : state.token,
      fill: async value => { state.filled.push(value); state.field = value; },
      click: async () => { state.clicked++; handlers.response(response()); },
    }),
    frames: () => [], waitForTimeout: async () => {},
  };
  const options = { url, capture, tier: 3, maxTimeout: 1000, onVerification: fields => state.diagnostics.push(fields),
    handle: { browser: { newContext: async () => ({ newPage: async () => page, close: async () => { state.closed++; } }) } },
    installPolicy: async () => { state.policy++; },
  };
  return { options, handlers, state, page };
}

test('accepts only the tracker\'s share link for one whole S10 number and its exact reply', () => {
  assert.equal(correiosBrowserNumber(url, capture), number);
  for (const candidate of [url + '&extra=1', url + '#extra', url.replace(number, 'AA00000000BR'), url.replace(number, number.toLowerCase()),
    url.replace('index.php', 'other.php'), url.replace('rastreamento.correios.com.br', 'example.test'),
    url.replace('rastreamento.correios.com.br', 'user@rastreamento.correios.com.br'), url.replace('objetos', 'objeto'),
    `${url}&objetos=${number}`, 'not a url']) {
    assert.equal(correiosBrowserNumber(candidate, capture), null, candidate);
  }
  assert.equal(correiosBrowserNumber(url, { captureResponses: [endpoint + '?x=1'] }), null);
  assert.equal(correiosBrowserNumber(url, { captureResponses: [endpoint, endpoint] }), null);
});

test('searches once the token is there, binds the request and keeps only the fields the adapter reads', async () => {
  const active = fixture();
  const result = await runCorreiosBrowser(active.options);
  assert.equal(result.status, 'success');
  assert.equal(result.capturedResponses.length, 1);
  assert.equal(result.capturedResponses[0].trackingNumberSubmitted, number);
  assert.deepEqual(JSON.parse(result.capturedResponses[0].body), { codObjeto: number, situacao: 'T', atrasado: false, dtPrevista: '02/01/2026',
    tipoPostal: { categoria: 'SEDEX' }, eventos: [{ codigo: 'BDE', tipo: '01', descricao: 'Objeto entregue ao destinatário',
      dtHrCriado: { date: '2026-01-01 10:00:00.000000', timezone_type: 3, timezone: 'America/Sao_Paulo' },
      unidade: { endereco: { cidade: 'Sampletown', uf: 'SP' } } }] });
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(result.html, ''); assert.equal(result.cookies.length, 0);
  assert.equal(active.state.clicked, 1); assert.deepEqual(active.state.filled, []);
  assert.equal(active.state.closed, 1); assert.equal(active.state.policy, 1);
  assert.deepEqual(active.handlers, {});
  assert.equal(active.state.diagnostics.length, 1);
  assert.deepEqual({ ...active.state.diagnostics[0], durationMs: 0 }, { nativeOutcome: 'token_received', searched: true,
    responses: 1, pending: 0, pageStatus: 200, apiStatus: 200, outcome: 'http_response', durationMs: 0 });
});

test('fills the field when the page did not, and ignores replies for another number', async () => {
  const active = fixture();
  active.state.field = '';
  active.page.locator = (locator => selector => ({ ...locator(selector), click: async () => {
    active.state.clicked++;
    active.handlers.response(response(200, body, form('BB000000005BR')));
    active.handlers.response(response(200, body, `${form()}&objeto=BB000000005BR`));
    active.handlers.response(response());
  } }))(active.page.locator);
  const result = await runCorreiosBrowser(active.options);
  assert.deepEqual(active.state.filled, [number]);
  assert.equal(result.capturedResponses.length, 1);
  assert.equal(JSON.parse(result.capturedResponses[0].body).codObjeto, number);
});

test('keeps a refused check as its status and never searches without a token', async () => {
  const refused = fixture();
  refused.page.locator = (locator => selector => ({ ...locator(selector), click: async () => {
    refused.handlers.response(response(403, '{"erro":true,"mensagem":"PRIVATE"}'));
  } }))(refused.page.locator);
  const result = await runCorreiosBrowser(refused.options);
  assert.deepEqual(result.capturedResponses.map(row => [row.status, row.body]), [[403, null]]);
  assert.equal(refused.state.diagnostics[0].outcome, 'challenge');
  assert.equal(refused.state.diagnostics[0].apiStatus, 403);

  const waiting = fixture();
  waiting.state.token = ''; waiting.options.maxTimeout = 20;
  waiting.page.waitForTimeout = ms => new Promise(resolve => setTimeout(resolve, ms));
  const unresolved = await runCorreiosBrowser(waiting.options);
  assert.equal(unresolved.status, 'success'); assert.deepEqual(unresolved.capturedResponses, []);
  assert.equal(waiting.state.clicked, 0); assert.equal(waiting.state.closed, 1);
  assert.equal(waiting.state.diagnostics[0].nativeOutcome, 'waiting');
  assert.equal(waiting.state.diagnostics[0].searched, false);
  assert.equal(waiting.state.diagnostics[0].outcome, 'timeout');
});

test('returns a refused page at once and fails without a widget', async () => {
  const blocked = fixture();
  blocked.page.goto = async () => ({ status: () => 403 });
  const result = await runCorreiosBrowser(blocked.options);
  assert.equal(result.statusCode, 403); assert.equal(blocked.state.clicked, 0);

  const changed = fixture();
  changed.state.widget = 0; changed.options.maxTimeout = 20;
  changed.page.waitForTimeout = ms => new Promise(resolve => setTimeout(resolve, ms));
  assert.equal((await runCorreiosBrowser(changed.options)).status, 'error');
  assert.equal(changed.state.clicked, 0);
});

test('bounds bodies, malformed JSON and repeated requests', async () => {
  for (const [value, truncated, kept] of [['x'.repeat(1_000_001), true, null], ['invalid json PRIVATE', false, 'null']]) {
    const active = fixture();
    active.page.locator = (locator => selector => ({ ...locator(selector), click: async () => {
      active.handlers.response(response(200, value));
    } }))(active.page.locator);
    const result = await runCorreiosBrowser(active.options);
    assert.equal(result.capturedResponses[0].truncated, truncated);
    assert.equal(result.capturedResponses[0].body, kept);
  }
  const many = fixture();
  many.page.locator = (locator => selector => ({ ...locator(selector), click: async () => {
    for (let i = 0; i < 12; i++) many.handlers.response(response(403));
  } }))(many.page.locator);
  const result = await runCorreiosBrowser(many.options);
  assert.equal(result.capturedResponses.length, 10); assert.match(result.capturedResponses.at(-1).error, /limit/);
});

test('ignores other URLs and lookups it does not own', async () => {
  const active = fixture();
  assert.equal(await runCorreiosBrowser({ ...active.options, url: url.replace(number, 'AA00000000BR') }), undefined);
  assert.equal(active.state.diagnostics.length, 0);
});

test('reports throttles and unreadable captures without claiming a verified history', async () => {
  for (const [status, value, outcome] of [[429, body, 'rate_limited'], [200, 'not JSON PRIVATE', 'incomplete']]) {
    const active = fixture();
    active.page.locator = (locator => selector => ({ ...locator(selector), click: async () => {
      active.handlers.response(response(status, value));
    } }))(active.page.locator);
    await runCorreiosBrowser(active.options);
    assert.equal(active.state.diagnostics[0].outcome, outcome);
    assert.equal(active.state.diagnostics[0].apiStatus, status);
  }
});

test('default diagnostics contain only fixed labels, counts and statuses', async t => {
  const logs = [];
  t.mock.method(console, 'warn', text => logs.push(text));
  const active = fixture();
  delete active.options.onVerification;
  await runCorreiosBrowser(active.options);
  assert.equal(logs.length, 1);
  const diagnostic = JSON.parse(logs[0]);
  assert.equal(diagnostic.event, 'correios.verification');
  assert.equal(diagnostic.level, 'warn');
  assert.equal(diagnostic.outcome, 'http_response');
  assert.equal(typeof diagnostic.durationMs, 'number');
  for (const privateValue of [number, 'PRIVATE', 'Sampletown', endpoint]) assert.equal(logs[0].includes(privateValue), false);
});

test('a failed diagnostic sink cannot change the answer or cleanup', async () => {
  const active = fixture();
  active.options.onVerification = () => { throw new Error('PRIVATE'); };
  const result = await runCorreiosBrowser(active.options);
  assert.equal(result.capturedResponses.length, 1);
  assert.equal(active.state.closed, 1);
  assert.deepEqual(active.handlers, {});
});
