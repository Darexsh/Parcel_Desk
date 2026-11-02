import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CHILEXPRESS_PAGE, CHILEXPRESS_TOKEN_URL, CHILEXPRESS_TRACKING_URL, ChilexpressTracker } from './adapter.js';
import { parseChilexpress } from './parser.js';
import { chilexpressStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '990000000101';
const MOVING = '99000000102';
const RETURNED = '990000000303';
const UNKNOWN = '990000000909';
const TOKEN = 'synthetic-session-token-0001';
// The sign-in values the synthetic help centre script carries.
const KEY = 'synthetic-key';
const CLIENT = 'synthetic-client';
const SECRET = 'synthetic-secret';
const SCRIPT_URL = 'https://centrodeayuda.chilexpress.cl/main.0000000000000004.js';
const HOUR = 60 * 60_000;
const read = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const text = (name: string) => read(`${name}.json`);
type Row = Record<string, unknown>;
type Reply = { DatosOT: Row | null; ListTracking: Row[] | null; Respuesta: Row };
const fixture = (name: string): Reply => JSON.parse(text(name)) as Reply;
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const grant = (token = TOKEN) => json(JSON.stringify({ token_type: 'Bearer', expires_in: 3599, ext_expires_in: 3599, access_token: token }));
const refusal = (status = 401) => json('{ "error": "invalid_client" }', status);
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const trackingUrl = (number: string) => `${CHILEXPRESS_TRACKING_URL}?ot=${number}`;
const urls = (fetcher: { mock: { calls: Parameters<typeof fetch>[] } }) => fetcher.mock.calls.map(([url]) => String(url));
type Details = { request?: unknown; diagnostics?: unknown };
type Answer = () => Response | Promise<Response>;

/** The next of the given replies, the last one standing for every later request. */
const inTurn = (replies: Answer[]) => (replies.length > 1 ? replies.shift()! : replies[0]!)();

/**
 * A help centre that serves its page and script, answers the sign-in with the
 * given replies in turn, and the tracking service with the others in turn.
 */
function site(signIns: Answer[], replies: Answer[], page: Answer = () => new Response(read('help-centre.html')),
  script: Answer = () => new Response(read('help-centre-main.js'))) {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    if (url === CHILEXPRESS_PAGE) return page();
    if (url === SCRIPT_URL) return script();
    if (url === CHILEXPRESS_TOKEN_URL) return inTurn(signIns);
    return inTurn(replies);
  });
}

/** A help centre that signs every visitor in and answers the tracking service with the given replies in turn. */
const chilexpress = (...replies: Answer[]) => site([() => grant()], replies);

describe('Chilexpress HTTP adapter', () => {
  it("reads the help centre's sign-in values once, signs in as its page and asks for the whole number with its token", async () => {
    const fetcher = chilexpress(() => json(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const tracker = new ChilexpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' });
    await expect(tracker.fetch(' 9900 0000 0101 ', { budgetMs: 1000.5 })).resolves.toMatchObject({ status: 'delivered' });
    await expect(tracker.fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
    expect(urls(fetcher)).toEqual([CHILEXPRESS_PAGE, SCRIPT_URL, CHILEXPRESS_TOKEN_URL, trackingUrl(DELIVERED), trackingUrl(DELIVERED)]);
    for (const [, request] of fetcher.mock.calls.slice(0, 2)) {
      expect(request).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    }
    const [, signIn] = fetcher.mock.calls[2]!;
    expect(signIn).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal), headers: { Origin: 'https://centrodeayuda.chilexpress.cl',
      'Ocp-Apim-Subscription-Key': KEY, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SyntheticHost/1.0' } });
    // The help centre's values, not those the same script holds for another of Chilexpress's sites.
    expect(Object.fromEntries(new URLSearchParams(String(signIn!.body)))).toEqual({ grant_type: 'client_credentials',
      client_id: CLIENT, scope: `api://${CLIENT}/.default`, client_secret: SECRET });
    const [, track] = fetcher.mock.calls[3]!;
    expect(track).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal), headers: { Accept: 'application/json',
      Origin: 'https://centrodeayuda.chilexpress.cl', 'Ocp-Apim-Subscription-Key': KEY, Authorization: `Bearer ${TOKEN}`,
      'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'chilexpress', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(2);
  });

  it('keeps the values it read when a session ends, and reads them again only when a sign-in with old ones is refused', async () => {
    let now = 0;
    const fetcher = site([() => grant(), () => grant(), () => refusal(), () => grant()], [() => json(text('delivered'))]);
    const tracker = new ChilexpressTracker({ fetcher, now: () => now });
    await tracker.fetch(DELIVERED);
    // The token has ended; the values still stand.
    now = HOUR + 1;
    await tracker.fetch(DELIVERED);
    // An hour later the gateway refuses them: the page is read again, once.
    now = 3 * HOUR;
    await expect(tracker.fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
    expect(urls(fetcher)).toEqual([CHILEXPRESS_PAGE, SCRIPT_URL, CHILEXPRESS_TOKEN_URL, trackingUrl(DELIVERED),
      CHILEXPRESS_TOKEN_URL, trackingUrl(DELIVERED),
      CHILEXPRESS_TOKEN_URL, CHILEXPRESS_PAGE, SCRIPT_URL, CHILEXPRESS_TOKEN_URL, trackingUrl(DELIVERED)]);
  });

  it('reports a refused sign-in as a block, reading the page again at most once', async () => {
    for (const status of [400, 401, 403]) {
      // Values just read are not read again.
      const fresh = site([() => refusal(status)], [() => json(text('delivered'))]);
      const error = await carrier(fresh).track({ number: DELIVERED }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ kind: 'challenge' });
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(SECRET);
      expect(urls(fresh)).toEqual([CHILEXPRESS_PAGE, SCRIPT_URL, CHILEXPRESS_TOKEN_URL]);
    }
    let now = 0;
    const refused = site([() => grant(), () => refusal(403)], [() => json(text('delivered'))]);
    const tracker = new ChilexpressTracker({ fetcher: refused, now: () => now });
    await tracker.fetch(DELIVERED);
    now = 2 * HOUR;
    await expect(tracker.fetch(DELIVERED)).rejects.toMatchObject({ kind: 'challenge' });
    expect(urls(refused).slice(4)).toEqual([CHILEXPRESS_TOKEN_URL, CHILEXPRESS_PAGE, SCRIPT_URL, CHILEXPRESS_TOKEN_URL]);
  });

  it('treats a help centre page without its script or sign-in values as a changed page', async () => {
    const script = read('help-centre-main.js');
    const page = read('help-centre.html');
    for (const changed of [script.replace('tokenCdaClient_secret', 'tokenCdaSecret'), script.replace(/ocpApimSubscriptionKeyCDA:"[^"]*",/, ''),
      script.replace('tokenCdaClient_id', 'clientId'), '']) {
      const fetcher = site([() => grant()], [() => json(text('delivered'))], undefined, () => new Response(changed));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'schema' });
      expect(urls(fetcher)).toEqual([CHILEXPRESS_PAGE, SCRIPT_URL]);
    }
    const unnamed = site([() => grant()], [() => json(text('delivered'))], () => new Response(page.replace('main.0000000000000004.js', 'app.js')));
    await expect(carrier(unnamed).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'schema' });
    expect(urls(unnamed)).toEqual([CHILEXPRESS_PAGE]);
    const blocked = '<html><head><title>Just a moment...</title></head><body>cf-turnstile</body></html>';
    await expect(carrier(site([() => grant()], [], () => new Response(blocked))).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(site([() => grant()], [], undefined, () => new Response(blocked))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'challenge' });
    for (const status of [404, 410, 302]) {
      const moved = site([() => grant()], [], () => new Response(null, { status, headers: status === 302 ? { Location: '/home' } : {} }));
      await expect(carrier(moved).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'transport' });
    }
  });

  it('reads a delivered order newest first on local clocks, without the receiver, references or route notes', () => {
    const result = parseChilexpress(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Envío entregado al destinatario', last_update: null, last_update_local: '2026-03-05T13:47:59',
      expected_delivery: null, service_name: 'EXPRESS', weight_kg: 1.6, dimensions_text: '41 × 28 × 11 cm' });
    expect(result.events!.map(event => [event.local_time, event.provider_code, event.stage ?? null, event.description, event.location ?? null])).toEqual([
      ['2026-03-05T13:47:59', '14', 'delivered', 'Envío entregado al destinatario', 'CD EJEMPLO SUR'],
      ['2026-03-05T08:02:31', '13', 'out_for_delivery', 'Envío en despacho al destinatario', 'CD EJEMPLO SUR'],
      ['2026-03-05T05:11:00', '5', 'in_transit', 'Envío en VILLA EJEMPLO', 'CD EJEMPLO SUR'],
      ['2026-03-04T19:40:00', '8', 'in_transit', 'Envío en tránsito hacia VILLA EJEMPLO', 'CENTRO DE DISTRIBUCIÓN EJEMPLO'],
      ['2026-03-04T19:39:00', '5', 'in_transit', 'Envío en PUEBLO MODELO', 'CENTRO DE DISTRIBUCIÓN EJEMPLO'],
      ['2026-03-03T10:15:00', '4', 'accepted', 'Envío recepcionado por Chilexpress', 'SUCURSAL MODELO'],
      ['2026-03-02T21:05:12', '0', 'registered', 'Orden de Transporte creada', 'SUCURSAL MODELO'],
    ]);
    expect(result.events!.every(event => !('time' in event))).toBe(true);
    const kept = JSON.stringify(result);
    for (const dropped of ['SYNTHETIC RECEIVER', '11111111', 'Folio', 'CA****', 'RUTA', 'LOCAL', '990000000100']) {
      expect(kept).not.toContain(dropped);
    }
  });

  it('keeps the promised day before delivery and reads an order still on its way', () => {
    const result = parseChilexpress(fixture('in-transit'), MOVING);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Envío en tránsito hacia PUEBLO MODELO',
      last_update_local: '2026-04-14T18:09:00', expected_delivery: '2026-04-15', weight_kg: 0.5, dimensions_text: '20 × 15 × 10 cm' });
    expect(result.events!.map(event => [event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['8', 'in_transit', 'CIUDAD EJEMPLO EXPRESS'], ['5', 'in_transit', 'CIUDAD EJEMPLO EXPRESS'],
      ['4', 'accepted', 'CIUDAD EJEMPLO CENTRO'], ['-3', 'registered', null],
    ]);
    const bare = fixture('in-transit');
    Object.assign(bare.DatosOT!, { gls_tiempo_estimado: '', gls_servicio: null, peso: 0, largo: 0 });
    const summary = parseChilexpress(bare, MOVING);
    for (const field of ['service_name', 'weight_kg', 'dimensions_text']) expect(summary).not.toHaveProperty(field);
    expect(summary.expected_delivery).toBeNull();
    const ascending = fixture('in-transit');
    ascending.ListTracking!.reverse();
    expect(parseChilexpress(ascending, MOVING).events![0]).toMatchObject({ provider_code: '8' });
  });

  it('reads the leg back to the sender as returned, and the branch that held the parcel', () => {
    const result = parseChilexpress(fixture('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Envío entregado al remitente',
      expected_delivery: null });
    expect(result.events!.map(event => [event.provider_code, event.stage])).toEqual([
      ['14', 'returned'], ['13', 'returned'], ['12', 'returned'], ['-1', 'accepted'], ['15', 'exception'],
      ['51', 'ready_for_pickup'], ['16', 'failed_attempt'], ['13', 'out_for_delivery'], ['4', 'accepted'], ['0', 'registered'],
    ]);
    expect(result.events![5]).toMatchObject({ description: 'Envío disponible para retiro en sucursal', location: 'CALLE EJEMPLO 100, VILLA EJEMPLO' });
    expect(JSON.stringify(result)).not.toContain('PLAZO CUMPLIDO');
  });

  it('binds the reply to the whole requested number and rejects malformed replies', () => {
    expect(() => parseChilexpress(fixture('delivered'), '990000000102')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const mixed = fixture('delivered');
    mixed.ListTracking![3]!.nro_ot = 990000000100;
    expect(() => parseChilexpress(mixed, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const unnumbered = fixture('delivered');
    delete unnumbered.ListTracking![0]!.nro_ot;
    expect(() => parseChilexpress(unnumbered, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const undated = fixture('delivered');
    undated.ListTracking![1]!.fec_track = '05/03/2026 08:02';
    expect(() => parseChilexpress(undated, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const untyped = fixture('delivered');
    untyped.ListTracking![1]!.cod_tipo_evento = '13';
    expect(() => parseChilexpress(untyped, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const payload of [{ error: 'Bad Request' }, [], { Respuesta: { resultado: 'true' } }, { ...fixture('delivered'), ListTracking: {} }]) {
      expect(() => parseChilexpress(payload, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseChilexpress(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const failing = fixture('not-found');
    failing.Respuesta.respuesta = 'Object reference not set to an instance of an object.';
    expect(() => parseChilexpress(failing, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const empty = fixture('delivered');
    empty.ListTracking = [];
    expect(() => parseChilexpress(empty, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('recognizes a known order and an unknown one, and leaves a failing lookup open', async () => {
    const failing = fixture('not-found');
    failing.Respuesta.respuesta = 'Error';
    const fetcher = chilexpress(() => json(text('delivered')), () => json(text('not-found')), () => json(JSON.stringify(failing)));
    const direct = carrier(fetcher);
    await expect(direct.recognize!(DELIVERED)).resolves.toMatchObject({ known: true });
    await expect(direct.recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(direct.recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(direct.recognize!('990000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(6);
    await expect(carrier(chilexpress(() => json(text('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('signs in again once when the tracking service rejects the token', async () => {
    const fetcher = chilexpress(() => json('{ "statusCode": 401, "message": "Unauthorized. Access token is missing or invalid." }', 401),
      () => json(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new ChilexpressTracker({ fetcher, recorder }).fetch(DELIVERED)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(urls(fetcher)).toEqual([CHILEXPRESS_PAGE, SCRIPT_URL, CHILEXPRESS_TOKEN_URL, trackingUrl(DELIVERED),
      CHILEXPRESS_TOKEN_URL, trackingUrl(DELIVERED)]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'refresh', outcome: 'ok' }));
    const refused = chilexpress(() => json('{ "statusCode": 401 }', 401));
    await expect(carrier(refused).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(refused).toHaveBeenCalledTimes(6);
  });

  it('reads the page and opens one session for lookups that start together', async () => {
    const fetcher = chilexpress(() => json(text('delivered')));
    const tracker = new ChilexpressTracker({ fetcher });
    await Promise.all([tracker.fetch(DELIVERED), tracker.fetch(DELIVERED)]);
    expect(urls(fetcher).filter(url => url !== trackingUrl(DELIVERED))).toEqual([CHILEXPRESS_PAGE, SCRIPT_URL, CHILEXPRESS_TOKEN_URL]);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s from the tracking service as %s, without the key or token in the error', async (status, kind) => {
      const fetcher = chilexpress(() => json('{ "statusCode": 0, "message": "synthetic" }', status));
      const error = await carrier(fetcher).track({ number: DELIVERED }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ kind });
      const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
      for (const secret of [TOKEN, KEY]) expect(serialized).not.toContain(secret);
      expect([(error as Details).request, (error as Details).diagnostics]).toEqual([undefined, undefined]);
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
    });

  it('keeps a broken session reply, a browser check and a malformed answer apart from a missing order', async () => {
    const tokenless = site([() => json('{"token_type":"Bearer"}')], [() => json(text('delivered'))]);
    await expect(carrier(tokenless).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'schema' });
    const blocked = '<html><head><title>Just a moment...</title></head><body>cf-turnstile</body></html>';
    await expect(carrier(chilexpress(() => new Response(blocked))).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
    for (const body of ['<html>Service Unavailable</html>', '[]', '{"error":"Bad Request"}']) {
      await expect(carrier(chilexpress(() => new Response(body))).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'schema' });
    }
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    let failures = 0;
    const fetcher = chilexpress(() => {
      if (failures++ === 0) throw new TypeError('fetch failed');
      return json(text('delivered'));
    });
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new ChilexpressTracker({ fetcher, recorder }).fetch(DELIVERED, { budgetMs: 2000 })).resolves.toMatchObject({ status: 'delivered' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
  });

  it('rejects numbers Chilexpress does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['990000001', '9900000001011', 'CX9900000001', '']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes an order filed under Chilexpress to the adapter', async () => {
    const fetcher = chilexpress(() => json(text('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'chilexpress' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'chilexpress', source: 'chilexpress', result: { current_stage: 'delivered' } });
    expect(urls(fetcher).every(url => [CHILEXPRESS_PAGE, SCRIPT_URL, CHILEXPRESS_TOKEN_URL, trackingUrl(DELIVERED)].includes(url))).toBe(true);
  });
});

describe('Chilexpress status vocabulary', () => {
  it('records every code and wording with the stage the adapter gives it', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      expect(chilexpressStage(entry.code ?? null, entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(entry.code ?? null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    }
    expect(chilexpressStage(null, 'Envío entregado al remitente')).toBe('returned');
    expect(chilexpressStage('999', 'Envío en CIUDAD EJEMPLO')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'chilexpress', providerCode: '14', description: 'Envío entregado al destinatario' }))
      .toEqual({ kind: 'mapped', stage: 'delivered' });
  });
});
