import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CBL_API, CblTracker, cblLookupUrl } from './adapter.js';
import { cblWording, normalizeCblNumber, parseCbl } from './parser.js';
import { cblMappedStage, cblSituation, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '99900000017';
const IN_TRANSIT = '99900000024';
const UNKNOWN = '99900000031';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
interface Data { datos_expedicion: Record<string, unknown>; eventos: Record<string, unknown>[]; incidencias: Record<string, unknown>[] }
const fixture = (name: string): { success: boolean; data: Data } => JSON.parse(text(name));
/** A fixture with its `data` changed in place by `change`. */
const changed = (name: string, change: (data: Data) => void) => {
  const payload = fixture(name);
  change(payload.data);
  return payload;
};
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('CBL Logística HTTP adapter', () => {
  it('asks the locator page\'s lookup for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CblTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 999 0000 0024 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${CBL_API}${IN_TRANSIT}`);
    expect(cblLookupUrl(IN_TRANSIT)).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'cbl-logistica', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('merges scans and incidents newest first, as wall clocks, and settles a delivery from the situation', () => {
    const result = parseCbl(fixture('delivered'), DELIVERED);
    // The incident flag stays from the failed attempt; a delivery is final.
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'ENTREGADA', last_update: null, last_update_local: '2026-03-25T12:41:00', expected_delivery: null });
    expect(result).not.toHaveProperty('summary_only');
    expect(result.events!.map((event) => [event.local_time, event.stage ?? null, event.description])).toEqual([
      ['2026-03-25T12:41:00', 'delivered', 'ENTREGADA'],
      // The reply's fraction of a second is dropped.
      ['2026-03-25T08:20:00', 'out_for_delivery', 'EN REPARTO'],
      ['2026-03-24T13:05:00', 'failed_attempt', 'AUSENTE'],
      ['2026-03-24T08:30:00', 'out_for_delivery', 'EN REPARTO'],
      // The repeated row is kept once.
      ['2026-03-24T06:15:00', 'in_transit', 'LLEGADA A DELEGACION DESTINO'],
      ['2026-03-23T21:40:00', 'in_transit', 'SALIDA DE PLATAFORMA'],
      ['2026-03-23T18:02:00', null, 'DOCUMENTADA'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.location === undefined)).toBe(true);
  });

  it('keeps no sender, recipient, address, comment, contact, reference or proof of delivery', () => {
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', IN_TRANSIT]] as const) {
      const result = JSON.stringify(parseCbl(fixture(name), number));
      expect(result, name).not.toMatch(/MUESTRA|EJEMPLO|example|REPARTIDOR|DNI|AVISADO|PEDIDO|00000000T|000 000|00 00 00|https?:|Albar|LLAMAR|0000-4000/);
    }
  });

  it('reads the page\'s own clock form, a numeric shipment number and a scan without wording', () => {
    const result = parseCbl(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'LLEGADA A DELEGACION DESTINO', last_update_local: '2026-11-03T06:05:00' });
    expect(result.events!.map((event) => [event.local_time, event.stage ?? null, event.description])).toEqual([
      // Rows of one clock keep the reply's order; a phone and an email address are dropped.
      ['2026-11-03T06:05:00', 'in_transit', 'LLEGADA A DELEGACION DESTINO'],
      ['2026-11-03T06:05:00', null, 'PENDIENTE DE CONCERTAR ENTREGA'],
      ['2026-11-02T20:47:00', 'in_transit', 'SALIDA DE PLATAFORMA'],
      ['2026-11-02T09:12:00', null, 'DOCUMENTADA'],
    ]);
  });

  it('keeps scans of one clock in the reply’s order, whichever way it lists them', () => {
    const descriptions = (payload: ReturnType<typeof fixture>) => parseCbl(payload, IN_TRANSIT).events!.map((event) => event.description);
    expect(descriptions(changed('in-transit', (data) => { data.eventos.reverse(); }))).toEqual(descriptions(fixture('in-transit')));
  });

  it('reads the incident flag as the page does, over every situation but a delivery', () => {
    const flagged = changed('in-transit', (data) => { data.datos_expedicion.HAY_INCIDENCIA = 1; });
    expect(parseCbl(flagged, IN_TRANSIT)).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map' });
    expect(cblSituation('REPA', true)).toEqual({ stage: 'exception', label: 'INCIDENCIA' });
    expect(cblSituation('', true)).toEqual({ stage: 'exception', label: 'INCIDENCIA' });
    expect(cblSituation('EFEC', true)).toEqual({ stage: 'delivered', label: 'ENTREGADA' });
    expect(cblSituation('XYZ', false)).toBeUndefined();
  });

  it('falls back on the newest scan with a stage when the situation is one the page has no label for', () => {
    const payload = changed('delivered', (data) => {
      data.datos_expedicion.SITUACION_LOCALIZADOR = 'NUEVA';
      data.datos_expedicion.HAY_INCIDENCIA = '0';
    });
    expect(parseCbl(payload, DELIVERED)).toMatchObject({ current_stage: 'delivered', current_stage_source: 'wording:language' });
    // An incident the wording rules do not read is still a problem with the shipment.
    const incident = changed('in-transit', (data) => {
      data.datos_expedicion.SITUACION_LOCALIZADOR = null;
      data.incidencias = [{ Fecha: '04/11/2026 10:00:00', Descripcion: 'MERCANCIA RETENIDA', Ampliacion: '' }];
    });
    expect(parseCbl(incident, IN_TRANSIT)).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map',
      last_status_text: 'MERCANCIA RETENIDA', last_update_local: '2026-11-04T10:00:00' });
  });

  it('reads a documented shipment without scans as a summary of its situation', () => {
    const payload = changed('in-transit', (data) => {
      data.eventos = [];
      data.datos_expedicion.SITUACION_LOCALIZADOR = 'doc';
    });
    expect(parseCbl(payload, IN_TRANSIT)).toEqual({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'DOCUMENTADA', provider_code: 'DOC', summary_only: true, last_update: null, expected_delivery: null, events: [] });
    const nothing = changed('in-transit', (data) => {
      data.eventos = [];
      data.datos_expedicion.SITUACION_LOCALIZADOR = '';
    });
    expect(() => parseCbl(nothing, IN_TRANSIT)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('takes phone numbers, email addresses and IDs out of the wording', () => {
    expect(cblWording('LLAMAR AL +34 600 000 000 O AL 910.000.000')).toBe('LLAMAR AL O AL');
    expect(cblWording('ENTREGADA, DNI: 00000000T')).toBe('ENTREGADA');
    expect(cblWording('AVISO ENVIADO A muestra@example.com')).toBe('AVISO ENVIADO A');
    // A shipment or expedition number is no phone.
    expect(cblWording(`REEXPEDIDA CON ${DELIVERED}`)).toBe(`REEXPEDIDA CON ${DELIVERED}`);
    expect(cblWording('  EN   REPARTO ')).toBe('EN REPARTO');
  });

  it('counts a shipment only when its number is the whole number asked', () => {
    expect(() => parseCbl(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'CBL answered for another shipment' }));
    for (const own of [`${DELIVERED}1`, DELIVERED.slice(3), `${DELIVERED}${' '.repeat(60)}9`, 99900000017.5, -99900000017]) {
      expect(() => parseCbl(changed('delivered', (data) => { data.datos_expedicion.NENVIO = own; }), DELIVERED), String(own))
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(parseCbl(changed('delivered', (data) => { data.datos_expedicion.NENVIO = ` ${DELIVERED} `; }), DELIVERED)).toMatchObject({ status: 'delivered' });
  });

  it('rejects a changed reply', () => {
    for (const payload of [
      {},
      [],
      { success: 'true' },
      { success: true, data: null },
      { success: true, data: { datos_expedicion: null, eventos: [], incidencias: [] } },
      { success: false, ServerErrors: 'No hay datos' },
      { success: false, ServerErrors: ['No hay datos'] },
      changed('delivered', (data) => { delete data.datos_expedicion.NENVIO; }),
      changed('delivered', (data) => { data.datos_expedicion.NENVIO = ''; }),
      changed('delivered', (data) => { data.datos_expedicion.NENVIO = [DELIVERED]; }),
      changed('delivered', (data) => { Object.assign(data, { eventos: null }); }),
      changed('delivered', (data) => { Object.assign(data, { incidencias: 'none' }); }),
      changed('delivered', (data) => { Object.assign(data.eventos, { 1: 'ENTREGADA' }); }),
      changed('delivered', (data) => { data.eventos[1]!.Descripcion = 5; }),
      changed('delivered', (data) => { data.eventos[1]!.Fecha = '2026-03-23T21:40:00+01:00'; }),
      changed('delivered', (data) => { data.eventos[1]!.Fecha = '2026-03-23'; }),
      changed('delivered', (data) => { data.eventos[1]!.Fecha = '23/03/2026'; }),
      changed('delivered', (data) => { data.eventos[1]!.Fecha = '2026-02-30T21:40:00'; }),
      changed('delivered', (data) => { data.eventos[1]!.Fecha = '23/03/2026 24:00:00'; }),
      changed('delivered', (data) => { data.eventos[1]!.Fecha = '/Date(1774298400000)/'; }),
      changed('delivered', (data) => { data.eventos[1]!.Fecha = null; }),
      changed('delivered', (data) => { data.eventos = Array.from({ length: 301 }, () => data.eventos[0]!); }),
    ]) {
      expect(() => parseCbl(payload, DELIVERED), JSON.stringify(payload).slice(0, 120)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a refusal of its length, another error, a moved route, a browser check and a rate limit apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    // The page reads a missing parcel from its only server error.
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(text('too-short'))).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(lookup('{"success":false,"ServerErrors":[{"Number":1,"Description":"Error interno"}],"data":null}')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('{"success":false,"ServerErrors":null,"ClientErrors":null,"data":null}')).rejects.toMatchObject({ kind: 'indeterminate' });
    // ASP.NET's answer for a route it does not have, a gone route and a redirect.
    await expect(lookup('{"Message":"No HTTP resource was found that matches the request URI."}', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://clientes.cbl-logistica.com/login.aspx' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('Forbidden', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('Too Many Requests', { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '10' } }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 10_000 });
    await expect(lookup('<html><title>Acceso Intranet</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 206 })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failure to reach CBL, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CblTracker({ fetcher, recorder }).fetch(DELIVERED, { budgetMs: 2000 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'cbl-logistica', step: 'retry', outcome: 'ok' }));
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('recognizes a known shipment and the not-found reply, and asks nothing for a number CBL does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('delivered')))
      .mockResolvedValueOnce(reply(text('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-25T12:41:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('CBL00000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers CBL does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['9990001', '999000000000000000001', 'CBL00000000', 'SAMPLETRACKING', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeCblNumber(' 999-0000-0017 ')).toBe(DELIVERED);
  });

  it('routes a number filed under CBL to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'cbl-logistica' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'cbl-logistica', source: 'cbl-logistica', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === cblLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('CBL Logística numbers', () => {
  it('claims no bare digit run, which other carriers issue too', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN]) {
      const detected = detectCarrierMatch(number);
      expect(detected.carrier === 'cbl-logistica' && detected.confidence === 'high', number).toBe(false);
    }
  });
});

describe('CBL Logística status vocabulary', () => {
  it('records every situation and label the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string }[]) {
      const answer = statusMapAnswer({ carrier: 'cbl-logistica', providerCode: entry.code ?? null, description: entry.wording });
      expect(answer, entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
      if (entry.code) expect(cblMappedStage(entry.code), entry.code).toBe(entry.stage);
    }
  });

  it('leaves an unknown code and scan wording to the shared rules', () => {
    expect(statusMap.stage('XYZ', 'documentada')).toBeUndefined();
    expect(statusMap.stage(null, 'en reparto')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'cbl-logistica', providerCode: null, description: 'Synthetic scan' })).toEqual({ kind: 'unknown' });
  });
});
