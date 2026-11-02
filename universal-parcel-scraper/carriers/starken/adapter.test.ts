import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, STARKEN_API, STARKEN_REPLY_PASSPHRASE, STARKEN_TOKEN_PASSPHRASE, StarkenTracker, starkenOpen, starkenSeal, starkenToken } from './adapter.js';
import { normalizeStarkenNumber, parseStarken } from './parser.js';
import { starkenStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '100000001';
const IN_TRANSIT = '100000002';
const CLOSED = '100000003';
const UNKNOWN = '100000009';
const KEY = starkenSeal('synthetic key', 'synthetic passphrase', Buffer.alloc(8, 1));

type Row = Record<string, unknown>;
type Scan = Row & { senfecha: string; macro_estado: string; estado_interno: string };
type Order = Row & { encargos: (Row & { encargo: (Row & { pinchazos: Scan[] })[] })[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Order;
const changed = (name: string, change: (order: Order) => void) => {
  const order = fixture(name);
  change(order);
  return order;
};
const scansOf = (order: Order) => order.encargos.flatMap((pack) => pack.encargo.flatMap((day) => day.pinchazos));
const keyReply = (key = KEY) => new Response(JSON.stringify({ statusCode: 201, payload: key }), { status: 201, headers: { 'Content-Type': 'application/json' } });
// The service sends the sealed history as text/html.
const sealed = (order: unknown) => new Response(starkenSeal(JSON.stringify(order), STARKEN_REPLY_PASSPHRASE), { headers: { 'Content-Type': 'text/html' } });
const reply = (body: unknown, status = 200, type = 'application/json') => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': type } });
const refused = () => reply({ message: 'Unauthorized', statusCode: 401 }, 401);
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** A transport that answers the key request with a key and the history request with `history`. */
const service = (...history: (() => Response)[]) => {
  let asked = 0;
  return vi.fn<typeof fetch>(async (url) => String(url).endsWith('/gettoken') ? keyReply() : history[Math.min(asked++, history.length - 1)]!());
};
const lookup = (history: () => Response, number = UNKNOWN) => carrier(service(history)).track({ number });

describe('Starken HTTP adapter', () => {
  it('asks a key for a sealed token, then reads the order under it, through the supplied transport', async () => {
    const fetcher = service(() => sealed(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new StarkenTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 100-000-001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[keyUrl, keyInit], [historyUrl, historyInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(keyUrl).toBe(`${STARKEN_API}/gettoken`);
    const token = (keyInit.headers as Record<string, string>).Apikey!;
    expect(keyInit).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/json', Origen: 'CL', Origin: 'https://www.starken.cl', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(keyInit.body))).toEqual({ token });
    // The token carries the page's source, a UTC clock, the shared key and the whole order number.
    expect(starkenOpen(token, STARKEN_TOKEN_PASSPHRASE)).toMatch(/^STARKENCL\|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\|[^|]{8,}\|100000001$/);
    expect(historyUrl).toBe(`${STARKEN_API}/historialClOfs/${DELIVERED}`);
    expect(historyInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Apikey: KEY, Origen: 'CL', Origin: 'https://www.starken.cl', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'starken', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('seals as CryptoJS does, with the UTC clock', () => {
    const salt = Buffer.from('0102030405060708', 'hex');
    expect(starkenSeal('synthetic', 'passphrase', salt)).toMatch(/^U2FsdGVkX18BAgMEBQYHC/);
    expect(starkenOpen(starkenSeal('Envío ñandú', 'passphrase', salt), 'passphrase')).toBe('Envío ñandú');
    expect(starkenOpen(starkenToken('42', new Date('2026-03-01T02:03:04.567Z')), STARKEN_TOKEN_PASSPHRASE))
      .toMatch(/^STARKENCL\|2026-03-01 02:03:04\|[^|]+\|42$/);
    expect(() => starkenOpen(starkenSeal('synthetic', 'passphrase', salt), 'another')).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps every package’s scans once, newest first, with their wall clocks and the newest of a run of waiting notes', () => {
    const result = parseStarken(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'ENTREGADO A DESTINATARIO', last_update: null, last_update_local: '2026-03-14T13:47:29', expected_delivery: null });
    expect(result).not.toHaveProperty('provider_code');
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage ?? null, event.description])).toEqual([
      ['2026-03-14T13:47:29', 'ENTREGADO', 'delivered', 'ENTREGADO A DESTINATARIO'],
      ['2026-03-14T09:02:03', 'EN REPARTO', 'out_for_delivery', 'EN REPARTO A DOMICILIO'],
      ['2026-03-14T09:01:44', 'DESTINO', 'in_transit', 'SALIENDO A REPARTO DESDE SUCURSAL EJEMPLO SUR'],
      // Four notes from two packages over two days, kept once.
      ['2026-03-13T08:11:00', 'DESTINO', null, 'El envío sigue en proceso anterior'],
      ['2026-03-11T19:20:00', 'DESTINO', 'in_transit', 'RECIBIDO PARA REPARTO EN SUCURSAL EJEMPLO SUR : SIN MORADORES'],
      ['2026-03-11T18:05:51', 'TRANSITO', 'failed_attempt', 'INTENTO DE ENTREGA : SIN MORADORES'],
      ['2026-03-11T09:30:15', 'EN REPARTO', 'out_for_delivery', 'EN REPARTO A DOMICILIO'],
      ['2026-03-11T09:30:00', 'DESTINO', 'in_transit', 'SALIENDO A REPARTO DESDE SUCURSAL EJEMPLO SUR'],
      ['2026-03-11T09:12:47', 'DESTINO', 'in_transit', 'RECIBIDO PARA REPARTO EN SUCURSAL EJEMPLO SUR'],
      ['2026-03-11T05:41:02', 'DESTINO', 'in_transit', 'EN TRANSITO HACIA SUCURSAL EJEMPLO SUR'],
      ['2026-03-11T05:40:33', 'TRANSITO', 'in_transit', 'SALIENDO DESDE SUCURSAL HUB EJEMPLO'],
      // The packages were scanned a minute apart here.
      ['2026-03-11T02:15:09', 'TRANSITO', 'in_transit', 'RECIBIDO EN SUCURSAL HUB EJEMPLO'],
      ['2026-03-11T02:14:09', 'TRANSITO', 'in_transit', 'RECIBIDO EN SUCURSAL HUB EJEMPLO'],
      ['2026-03-10T16:30:21', 'TRANSITO', 'in_transit', 'EN TRANSITO HACIA SUCURSAL HUB EJEMPLO'],
      ['2026-03-10T16:30:05', 'ORIGEN', 'accepted', 'SALIENDO DESDE SUCURSAL EJEMPLO NORTE'],
      ['2026-03-10T10:15:40', 'ORIGEN', 'accepted', 'RECIBIDO EN SUCURSAL EJEMPLO NORTE'],
      ['2026-03-09T18:02:11', 'EMITIDO', 'registered', 'EMITIDO'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.location === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PERSONA|FICTICIA|TIENDA|VILLA PRUEBA|569|example\.invalid|9000000000000|CENTRO DE PRUEBA|PAGADO/);
  });

  it('reads a parcel on its way, with the page’s estimate, and one ready to collect', () => {
    expect(parseStarken(fixture('in-transit'), IN_TRANSIT)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'EN TRANSITO HACIA SUCURSAL AGENCIA EJEMPLO', last_update_local: '2026-04-03T06:25:57', expected_delivery: '2026-04-06' });
    const ready = parseStarken(changed('in-transit', (order) => {
      order.encargos[0]!.encargo[1]!.pinchazos.push({ ...scansOf(order).at(-1)!, senfecha: '03-04-2026 10:52:11', macro_estado: 'DESTINO',
        estado: 'PENDIENTE ENTREGA', estado_interno: 'LISTO PARA RETIRO EN AGENCIA EJEMPLO' });
    }), IN_TRANSIT);
    expect(ready).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map',
      last_status_text: 'LISTO PARA RETIRO EN AGENCIA EJEMPLO', expected_delivery: '2026-04-06' });
    // A missing or placeholder estimate gives none.
    expect(parseStarken(changed('in-transit', (order) => { order.fechaEntEstimada = null; }), IN_TRANSIT).expected_delivery).toBeNull();
    expect(parseStarken(changed('in-transit', (order) => { order.fechaEntEstimada = 'sin fecha'; }), IN_TRANSIT).expected_delivery).toBeNull();
  });

  it('reads an order closed without a delivery as an exception under its closing code', () => {
    expect(parseStarken(fixture('closed'), CLOSED)).toMatchObject({ status: 'exception', current_stage: 'exception',
      current_stage_source: 'carrier_map', provider_code: 'EXTRAVIADO', last_status_text: 'PROCESANDO ENVIO', expected_delivery: null });
    expect(parseStarken(fixture('closed'), CLOSED).events![0]).toMatchObject({ provider_code: 'CONTACTO/TERMINO', stage: 'exception' });
    // The page names a closure without a code by its open claim.
    expect(parseStarken(changed('closed', (order) => { order.tipoTermino = ''; }), CLOSED)).toMatchObject({ provider_code: 'RECLAMO' });
    expect(parseStarken(changed('in-transit', (order) => { order.cerradoExc = true; }), IN_TRANSIT))
      .toMatchObject({ current_stage: 'exception', provider_code: 'CERRADO CON EXCEPCION', expected_delivery: null });
    const closed = parseStarken(changed('in-transit', (order) => { order.isTermino = true; }), IN_TRANSIT);
    expect(closed).toMatchObject({ current_stage: 'exception', expected_delivery: null });
    expect(closed).not.toHaveProperty('provider_code');
    // A claim on a parcel still moving closes nothing, and a delivery stands over a closure.
    expect(parseStarken(changed('in-transit', (order) => { order.reclamos = [{ ESTADO_RECLAMO: 'Ingresado' }]; }), IN_TRANSIT))
      .toMatchObject({ current_stage: 'in_transit', expected_delivery: '2026-04-06' });
    expect(parseStarken(changed('delivered', (order) => { order.isTermino = true; order.tipoTermino = 'REZAGO'; }), DELIVERED))
      .toMatchObject({ current_stage: 'delivered' });
  });

  it('counts an order only when it names the number asked', () => {
    expect(() => parseStarken(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Starken answered for another order' }));
    expect(() => parseStarken(changed('in-transit', (order) => { order.odflCodigo = 100000004; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseStarken(changed('in-transit', (order) => { order.ofConsultada = '0100000002'; }), IN_TRANSIT).events).toHaveLength(6);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (order: Order) => { delete order.ofConsultada; },
      (order: Order) => { order.ofConsultada = 100000002.5; },
      (order: Order) => { order.odflCodigo = { of: 100000002 }; },
      (order: Order) => { order.encargos = 'encargos' as never; },
      (order: Order) => { order.encargos[0]!.encargo = null as never; },
      (order: Order) => { order.encargos[0]!.encargo[0]!.pinchazos = ['scan'] as never; },
      (order: Order) => { scansOf(order)[0]!.senfecha = '2026-04-02 11:19:34'; },
      (order: Order) => { scansOf(order)[0]!.senfecha = '31-02-2026 11:19:34'; },
      (order: Order) => { scansOf(order)[0]!.senfecha = '02-04-2026 24:00:00'; },
      (order: Order) => { scansOf(order)[0]!.estado_interno = ['RECIBIDO'] as never; },
      (order: Order) => { scansOf(order)[0]!.estado_interno = ''; scansOf(order)[0]!.estado = ''; },
      (order: Order) => { scansOf(order)[0]!.macro_estado = 7 as never; },
      (order: Order) => { order.isTermino = true; order.tipoTermino = 11; },
    ]) {
      expect(() => parseStarken(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseStarken('order', IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseStarken([], IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseStarken(changed('in-transit', (order) => { order.encargos = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    // The process state stands in for an empty scan wording.
    expect(parseStarken(changed('in-transit', (order) => { scansOf(order).at(-1)!.estado_interno = ''; }), IN_TRANSIT).last_status_text)
      .toBe('EN TRANSITO');
  });

  it('keeps an unknown number, an invalid one, a moved route, a browser check and a broken reply apart', async () => {
    await expect(lookup(() => reply(fixture('not-found'), 404))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(() => reply({ status: 404, message: 'Orden de flete invalida' }, 404))).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(lookup(() => reply({ status: 404, message: 'Cannot GET /statusOf' }, 404))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => reply('<html>Not Found</html>', 404, 'text/html'))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => new Response('', { status: 302, headers: { Location: 'https://www.starken.cl/' } })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('<html><title>Just a moment...</title><script>_cf_chl_opt={}</script></html>', 200, 'text/html')))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply('<html><title>Starken</title></html>', 200, 'text/html'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => reply(starkenSeal('{}', 'another passphrase'), 200, 'text/html'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => reply(starkenSeal('not json', STARKEN_REPLY_PASSPHRASE), 200, 'text/html'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => sealed(fixture('delivered')))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('asks again with the same key, then a new one, when the service refuses a key, and stops after that', async () => {
    const recovered = service(refused, () => sealed(fixture('in-transit')));
    await expect(carrier(recovered).track({ number: IN_TRANSIT })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(recovered.mock.calls.map(([url]) => String(url).split('/').at(-1))).toEqual(['gettoken', IN_TRANSIT, IN_TRANSIT]);
    const renewed = service(refused, refused, () => sealed(fixture('in-transit')));
    await expect(carrier(renewed).track({ number: IN_TRANSIT })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(renewed.mock.calls.map(([url]) => String(url).split('/').at(-1))).toEqual(['gettoken', IN_TRANSIT, IN_TRANSIT, 'gettoken', IN_TRANSIT]);
    const refusing = service(refused);
    await expect(carrier(refusing).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    expect(refusing).toHaveBeenCalledTimes(6);
    // A refused token is the answer: the page's key or seal changed.
    const token = vi.fn<typeof fetch>().mockImplementation(async () => refused());
    await expect(carrier(token).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    expect(token).toHaveBeenCalledTimes(1);
  });

  it('rejects a key reply that is not one', async () => {
    const keyed = (body: string, type = 'application/json') => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, 201, type)))
      .track({ number: IN_TRANSIT });
    await expect(keyed(JSON.stringify({ statusCode: 201 }))).rejects.toMatchObject({ kind: 'schema' });
    await expect(keyed(JSON.stringify({ statusCode: 201, payload: 'plain' }))).rejects.toMatchObject({ kind: 'schema' });
    await expect(keyed('<html><script src="https://sample.awswaf.com/x.js"></script>AwsWafIntegration</html>', 'text/html'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(keyed('<html>Starken</html>', 'text/html')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s for the key and for the history', async (status, kind) => {
      const key = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(key).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(key).toHaveBeenCalledTimes(1);
      const history = service(() => new Response('', { status }));
      await expect(carrier(history).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(history).toHaveBeenCalledTimes(2);
    });

  it('rejects numbers Starken does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['1000000001', 'SAMPLE123', '000000000', `1${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeStarkenNumber('0100 000 002')).toBe(IN_TRANSIT);
    expect(normalizeStarkenNumber('12345')).toBe('12345');
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a number filed under Starken to the adapter, and asks no recognition', async () => {
    const fetcher = service(() => sealed(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'starken' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'starken', source: 'starken', result: { current_stage: 'delivered' } });
    expect(carrier(fetcher).recognize).toBeUndefined();
  });
});

describe('Starken status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      if (!entry.code) continue;
      const wording = entry.wording.toLowerCase();
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, wording), entry.wording).toBeUndefined();
        expect(starkenStage(entry.code, entry.wording), entry.wording).toBeNull();
        expect(statusMapAnswer({ carrier: 'starken', providerCode: entry.code, description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, wording), `${entry.code} ${entry.wording}`).toBe(entry.stage);
      expect(starkenStage(entry.code, entry.wording)?.stage, `${entry.code} ${entry.wording}`).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'starken', providerCode: 'DESTINO', description: 'LISTO PARA RETIRO EN AGENCIA EJEMPLO' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    expect(statusMapAnswer({ carrier: 'starken', providerCode: 'ZZ', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to the shared wording rules.
    expect(starkenStage('ZZ', 'Entregado')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(starkenStage('ZZ', 'Synthetic note')).toBeNull();
    expect(starkenStage('entregado', 'ENTREGADO A DESTINATARIO')).toEqual({ stage: 'delivered', source: 'carrier_map' });
  });
});
