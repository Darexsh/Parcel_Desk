import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, OLVA_TRACKER, OlvaCourierTracker } from './adapter.js';
import { olvaQueries, parseOlvaPage, type OlvaQuery } from './parser.js';
import { olvaStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NOW = Date.UTC(2026, 9, 17, 12);
const DELIVERED = '26-09999901';
const GUIDE = 'ALIOLVA99000001';
const UNKNOWN = '26-09999900';

type Row = Record<string, unknown>;
type Group = Row & { events: Row[] };
type Data = Row & { trackingData: (Row & { tracking: Row; groups: Group[] }) | null };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Data;
const changed = (name: string, change: (data: Data) => void) => {
  const data = fixture(name);
  change(data);
  return data;
};
/** The page as WordPress writes it: the data on one line, its non-ASCII characters escaped. */
const page = (data: unknown) => [
  '<!DOCTYPE html>', '<html lang="es">', '<head>', '    <title>Olva Tracking</title>', '</head>',
  '<body class="home blog wp-theme-tracking-olva">', '<main class="trk-page" id="tracking-page"></main>',
  '<script id="main-js-js-extra">',
  `var OlvaTracking = ${JSON.stringify(data).replace(/[\u007f-￿]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)};`,
  '//# sourceURL=main-js-js-extra', '</script>',
  '<script id="main-js-js" src="https://tracking.olvacourier.com/wp-content/themes/tracking-olva/public/js/main.min.js?ver=1.2.22"></script>',
  '</body>', '</html>', '',
].join('\n');
const reply = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) => new Response(typeof body === 'string' ? body : page(body),
  { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const queryOf = (number: string): OlvaQuery => olvaQueries(number, NOW)[0]!;
const parse = (data: unknown, number: string) => parseOlvaPage(page(data), queryOf(number), number);
const tracker = (fetcher: typeof fetch) => new OlvaCourierTracker({ fetcher, recorder: NOOP_RECORDER, now: () => NOW });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const asked = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>) => fetcher.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('q'));

describe('Olva Courier HTTP adapter', () => {
  it('asks the tracking page for the number as it reads it, once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new OlvaCourierTracker({ fetcher, recorder, now: () => NOW }).fetch(' 26-0999 9901 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${OLVA_TRACKER}?q=26-09999901`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': expect.stringMatching(/^Mozilla\/5\.0 \((?!compatible;)/) } });
    expect(init).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'olva-courier', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history newest first on Peru’s wall clocks, without the recipient', () => {
    const result = parse(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '¡Entregado exitosamente!', last_update: null, last_update_local: '2026-10-07T11:02:18',
      expected_delivery: null, weight_kg: 2.5 });
    expect(result).not.toHaveProperty('canonical_tracking_number');
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage, event.description, event.location])).toEqual([
      ['2026-10-07T11:02:18', 'ENTREGADO', 'delivered', '¡Entregado exitosamente!', 'SAN MUESTRA'],
      ['2026-10-07T09:15:40', 'REPARTO', 'out_for_delivery', 'En camino a tu domicilio', 'SAN MUESTRA'],
      ['2026-10-06T13:30:02', 'INCIDENCIA', 'failed_attempt', 'Entrega fallida por motivo: ausente', 'SAN MUESTRA'],
      // The run two milestones list is kept once.
      ['2026-10-06T08:44:57', 'REPARTO', 'out_for_delivery', 'En camino a tu domicilio', 'SAN MUESTRA'],
      ['2026-10-06T07:05:12', 'EN_RUTA', 'in_transit', 'En almacén de SAN MUESTRA', 'SAN MUESTRA'],
      ['2026-10-05T00:20:31', 'REPARTO', 'in_transit', 'En camino a SAN MUESTRA', 'VILLA EJEMPLO'],
      ['2026-10-04T22:41:09', 'ALMACEN', 'in_transit', 'En almacén de VILLA EJEMPLO', 'VILLA EJEMPLO'],
      // A scan at 00:00:00 kept only its day, which comes before that day's clocks.
      ['2026-10-04', 'ALMACEN', 'in_transit', 'En almacén de VILLA EJEMPLO', 'VILLA EJEMPLO'],
      ['2026-10-03T01:12:40', 'REGISTRADO', 'registered', '¡Envío Registrado!', 'VILLA EJEMPLO'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/DESTINATARIA|SAN MUESTRA, EJEMPLO|\*{5}|DNI|MUESTRAS|\+00:00/);
  });

  it('reads an AliExpress guide on its way, and names Olva’s own number for it', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const result = await carrier(fetcher).track({ number: GUIDE });
    expect(asked(fetcher)).toEqual(['ALI-OLVA99000001']);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'En almacén de PUERTO PRUEBA',
      last_update_local: '2026-10-15T15:50:47', weight_kg: 0.75, canonical_tracking_number: '26-49900001' });
    expect(result.events!.map((event) => event.provider_code)).toEqual(['EN_RUTA', 'REPARTO', 'ALMACEN', 'ALMACEN', 'REGISTRADO']);
  });

  it('asks a guide written without ALI- as its external code', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply({ ...fixture('in-transit'), queryType: 'cod_externo', display: 'OLVA99000001' }));
    await expect(carrier(fetcher).track({ number: 'OLVA99000001' })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(asked(fetcher)).toEqual(['OLVA99000001']);
  });

  it('stages a store’s intake, the way to a store and the wait there by their wording', () => {
    const result = parse(changed('delivered', (data) => {
      data.trackingData!.groups = [{ code: 'ORIGEN', events: [
        { statusCode: 'REGISTRADO', title: 'Envío registrado', description: 'Aún no tenemos tu envío. ¡Te esperamos en Olva!',
          date: '08/10/2026', time: '07:51:37', location: 'VILLA EJEMPLO', color: 'green' },
        { statusCode: 'REPARTO', title: 'En camino a tu domicilio', description: 'Recepcionado por TIENDA : OLVA MUESTRA',
          date: '08/10/2026', time: '11:06:00', location: 'VILLA EJEMPLO', color: 'green' },
        { statusCode: 'REPARTO', title: 'En camino a tu domicilio', description: 'En camino a la TIENDA: OLVA EJEMPLO',
          date: '08/10/2026', time: '11:06:41', location: 'VILLA EJEMPLO', color: 'yellow' },
        { statusCode: 'REPARTO', title: 'En camino a tu domicilio', description: 'Ya puedes recoger tu envío en TIENDA OLVA EJEMPLO',
          date: '08/10/2026', time: '11:06:47', location: 'VILLA EJEMPLO', color: 'green' },
        // A code the map does not know falls to the wording rules, and without a description the title is the wording.
        { statusCode: 'SAMPLE_CODE', title: 'Envío de muestra', description: '', date: '09/10/2026', time: '10:00:00', location: '', color: 'green' },
      ] }];
    }), DELIVERED);
    expect(result.events!.map((event) => [event.provider_code, event.stage ?? null, event.description])).toEqual([
      ['SAMPLE_CODE', null, 'Envío de muestra'],
      ['REPARTO', 'ready_for_pickup', 'Ya puedes recoger tu envío en TIENDA OLVA EJEMPLO'],
      ['REPARTO', 'in_transit', 'En camino a la TIENDA: OLVA EJEMPLO'],
      ['REPARTO', 'accepted', 'Recepcionado por TIENDA : OLVA MUESTRA'],
      ['REGISTRADO', 'registered', 'Aún no tenemos tu envío. ¡Te esperamos en Olva!'],
    ]);
    expect(result).toMatchObject({ current_stage: 'ready_for_pickup', last_status_text: 'Envío de muestra' });
    expect(result.events![0]).not.toHaveProperty('location');
  });

  it('reads a number without its hyphen both ways, the later year first, and keeps the tracker’s years', () => {
    expect(olvaQueries('26-1000021', NOW).map((query) => query.q)).toEqual(['26-01000021', '21-02610000']);
    expect(olvaQueries('01000021-26', NOW).map((query) => query.q)).toEqual(['26-01000021']);
    expect(olvaQueries('2412345626', NOW).map((query) => query.q)).toEqual(['26-24123456', '24-12345626']);
    // The same year both ways: the year-first reading, the tracker's own form, first.
    expect(olvaQueries('2612345626', NOW).map((query) => query.q)).toEqual(['26-12345626', '26-26123456']);
    expect(olvaQueries('2601000021', Date.UTC(2031, 0, 1)).map((query) => query.q)).toEqual(['26-01000021']);
    expect(olvaQueries(' ali-olva 9900 0001 ', NOW)).toEqual([{ q: 'ALI-OLVA99000001', kind: 'guia_cliente', externalCode: 'OLVA99000001' }]);
    for (const number of ['20-1000029', '27-1000029', '2001000099', '26-100002', '26-100002100', 'ALIOLVA9900000', 'OLVA990000011',
      'ALI-99000001', '1Z9999999999999999', `26${'0'.repeat(70)}`]) {
      expect(() => olvaQueries(number, NOW), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('asks the other reading only when the tracker has no shipment for the first', async () => {
    const other = { ...fixture('delivered'), tracking: '02610000', emision: '21', display: '21-02610000' };
    other.trackingData!.tracking.number = '21-02610000';
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply({ ...fixture('not-found'), tracking: '01000021', display: '26-01000021' }))
      .mockResolvedValueOnce(reply(other));
    await expect(tracker(fetcher).fetch('261000021')).resolves.toMatchObject({ current_stage: 'delivered', canonical_tracking_number: '21-02610000' });
    expect(asked(fetcher)).toEqual(['26-01000021', '21-02610000']);

    // A shipment, or any failure but not-found, ends the lookup at the first reading.
    for (const response of [() => reply({ ...fixture('delivered'), tracking: '01000021', display: '26-01000021',
      trackingData: { ...fixture('delivered').trackingData!, tracking: { ...fixture('delivered').trackingData!.tracking, number: '26-01000021' } } }),
    () => new Response('', { status: 429 }), () => reply('<html><title>403 - Forbidden</title></html>', { status: 403 })]) {
      const once = vi.fn<typeof fetch>().mockImplementation(async () => response());
      await tracker(once).fetch('261000021').catch(() => undefined);
      expect(asked(once)).toEqual(['26-01000021']);
    }
    const unknown = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const q = new URL(String(url)).searchParams.get('q')!;
      return reply({ ...fixture('not-found'), tracking: q.slice(3), emision: q.slice(0, 2), display: q });
    });
    await expect(tracker(unknown).fetch('261000021')).rejects.toMatchObject({ kind: 'not_found' });
    expect(unknown).toHaveBeenCalledTimes(2);
  });

  it('reads the tracker’s no-shipment answer as not found, and nothing else', () => {
    expect(() => parse(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parse({ ...fixture('not-found'), errorMsg: 'Ocurrió un error al consultar el servicio.' }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse({ ...fixture('not-found'), errorMsg: '' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(changed('delivered', (data) => { for (const group of data.trackingData!.groups) group.events = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects an answer about another number or another reading of it', () => {
    for (const change of [
      (data: Data) => { data.display = '26-09999902'; },
      (data: Data) => { data.hasQuery = ''; },
      (data: Data) => { data.queryType = 'cod_externo'; },
      (data: Data) => { data.trackingData!.tracking.number = '26-09999902'; },
      (data: Data) => { data.trackingData!.tracking.number = '25-09999901'; },
      (data: Data) => { data.trackingData!.tracking.number = '26-9999901'; },
    ]) {
      expect(() => parse(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const change of [
      (data: Data) => { data.trackingData!.tracking.externalCode = 'OLVA99000002'; },
      (data: Data) => { data.trackingData!.tracking.externalCode = null; },
      (data: Data) => { data.queryType = 'cod_externo'; },
    ]) {
      expect(() => parse(changed('in-transit', change), GUIDE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (data: Data) => { data.trackingData = 'shipment' as never; },
      (data: Data) => { delete (data.trackingData as Row).tracking; },
      (data: Data) => { delete (data.trackingData as Row).groups; },
      (data: Data) => { data.trackingData!.groups[0] = 'group' as never; },
      (data: Data) => { delete (data.trackingData!.groups[0] as Row).events; },
      (data: Data) => { data.trackingData!.groups[0]!.events[0] = 'scan' as never; },
      (data: Data) => { data.trackingData!.groups[0]!.events[0]!.description = ['¡Envío Registrado!']; },
      (data: Data) => { Object.assign(data.trackingData!.groups[0]!.events[0]!, { description: '', title: '' }); },
      (data: Data) => { data.trackingData!.groups[0]!.events[0]!.date = '2026-10-03'; },
      (data: Data) => { data.trackingData!.groups[0]!.events[0]!.date = '31/02/2026'; },
      (data: Data) => { data.trackingData!.groups[0]!.events[0]!.time = '24:00:00'; },
      (data: Data) => { data.trackingData!.groups[0]!.events[0]!.time = '01:12'; },
      (data: Data) => { data.trackingData!.groups[0]!.events[0]!.statusCode = 7; },
      (data: Data) => { data.trackingData!.groups[0]!.events = Array.from({ length: 501 }, () => data.trackingData!.groups[0]!.events[0]!); },
      (data: Data) => { delete data.queryType; },
    ]) {
      expect(() => parse(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A weight in another unit, or none, is left out.
    expect(parse(changed('delivered', (data) => { data.trackingData!.tracking.unitOfWeight = 'LB'; }), DELIVERED)).not.toHaveProperty('weight_kg');
    expect(parse(changed('delivered', (data) => { data.trackingData!.tracking.weight = null; }), DELIVERED)).not.toHaveProperty('weight_kg');
  });

  it('keeps a missing number, a moved page, a refusal, a browser check and a broken page apart', async () => {
    const lookup = (body: unknown, init?: Parameters<typeof reply>[1]) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => reply(body, init)))
      .track({ number: GUIDE });
    const unknown = { ...fixture('not-found'), queryType: 'guia_cliente', tracking: '', emision: '', display: 'ALI-OLVA99000001' };
    await expect(lookup(unknown)).rejects.toMatchObject({ kind: 'not_found' });
    // A 404 or a redirect is a moved page, never a missing parcel.
    await expect(lookup(unknown, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://www.olvacourier.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: '/.well-known/sgcaptcha/?r=%2F%3Fq%3DALI-OLVA99000001' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<!DOCTYPE html><html><head><title>403 - Forbidden</title></head></html>', { status: 403 }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2F"></head></html>', { status: 202 }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Olva Tracking</title><body>Mantenimiento</body></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(page(unknown).replace('"hasQuery"', 'hasQuery'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[400, 'transport'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: GUIDE })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(GUIDE)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known guide and the no-shipment answer, and asks nothing for a number Olva does not issue', async () => {
    const unknown = { ...fixture('not-found'), queryType: 'guia_cliente', tracking: '', emision: '', display: 'ALI-OLVA99000001' };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('in-transit'))).mockResolvedValueOnce(reply(unknown));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(GUIDE)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-10-15T15:50:47' });
    await expect(carrier(fetcher).recognize!(GUIDE)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('ALIOLVA9900000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Olva does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ALIOLVA9900000', 'XYZOLVA99000001', '1Z9999999999999999', '12345678', '20-1000029']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: GUIDE }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: GUIDE }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: GUIDE }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a guide filed under Olva Courier, or detected as one, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('in-transit')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: 'ALI-OLVA99000001', carrier: 'olva-courier' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'olva-courier', source: 'olva-courier', result: { current_stage: 'in_transit' } });
    await expect(tracker.track({ number: 'ALI-OLVA99000001' }, { budgetMs: 3000 })).resolves.toMatchObject({ carrier: 'olva-courier', source: 'olva-courier' });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${OLVA_TRACKER}?q=ALI-OLVA99000001`)).toBe(true);
  });
});

describe('Olva Courier numbers', () => {
  it('claims AliExpress guides with high confidence, written with or without the hyphen', () => {
    for (const number of [GUIDE, 'ALI-OLVA99000001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'olva-courier', confidence: 'high' });
    }
  });
});

describe('Olva Courier status vocabulary', () => {
  it('stages every code and wording seen with the stage its record gives', () => {
    const seen = (statuses.entries as { code?: string; wording: string; stage?: string; confirmedBy: string }[])
      .filter((entry) => entry.code && entry.confirmedBy === 'live');
    expect(seen.length).toBeGreaterThan(10);
    for (const entry of seen) {
      expect(statusMap.stage(entry.code!, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(olvaStage(entry.code!, entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'olva-courier', providerCode: entry.code!, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    // Any other incident is a problem; a delivery wording the map does not know falls to the shared rules.
    expect(olvaStage('INCIDENCIA', 'Envío retenido')).toEqual({ stage: 'exception', source: 'carrier_map' });
    expect(olvaStage('REPARTO', 'Sample note')).toBeNull();
    expect(statusMap.stage(null, 'en camino a tu domicilio')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'olva-courier', providerCode: 'SAMPLE_CODE', description: 'Sample note' })).toEqual({ kind: 'unknown' });
  });
});
