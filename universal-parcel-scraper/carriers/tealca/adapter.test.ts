import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TEALCA_API, TealcaTracker, tealcaLookupBody } from './adapter.js';
import { normalizeTealcaNumber, parseTealca, tealcaWording } from './parser.js';
import { statusMap, tealcaMappedStage, tealcaStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '10000001';
const IN_TRANSIT = '10000002';
const UNKNOWN = '10000003';

type Row = Record<string, unknown>;
type Shipment = Row & { tracking: Row[] };
type Reply = Row & { data: Shipment[] };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name)) as Reply;
/** A fixture with its shipment, or the whole reply, changed in place by `change`. */
const changed = (name: string, change: (shipment: Shipment, reply: Reply) => void) => {
  const payload = fixture(name);
  change(payload.data[0]!, payload);
  return payload;
};
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'application/json; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Tealca HTTP adapter', () => {
  it('posts the whole guía to the tracking form’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TealcaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1000 0002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(TEALCA_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(String(init!.body)).toBe(`numberTracking=${IN_TRANSIT}&typeTracking=0&recaptcha=`);
    expect(tealcaLookupBody(IN_TRANSIT)).toBe(String(init!.body));
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'tealca', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('lists the scans newest first as wall clocks and stages them by Tealca’s wording', () => {
    const result = parseTealca(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Guía entregada', last_update: null, last_update_local: '2026-05-12T15:47:19', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.description, event.stage])).toEqual([
      ['2026-05-12T15:47:19', 'Guía entregada', 'delivered'],
      ['2026-05-12T11:02:51', 'Recepción en tienda destino 2002 - TIENDA EJEMPLO', 'in_transit'],
      ['2026-05-12T07:10:05', 'Despacho de Plataforma Sur a tienda destino 2002 - TIENDA EJEMPLO', 'in_transit'],
      // Half past midnight; the repeated scan is kept once.
      ['2026-05-12T00:30:00', 'Recepción en Plataforma Sur', 'in_transit'],
      ['2026-05-11T20:20:44', 'Despacho de Plataforma Norte con destino Plataforma Sur', 'in_transit'],
      // Scans at one clock keep the order they were written in.
      ['2026-05-11T14:15:30', 'Recepción en Plataforma Norte', 'in_transit'],
      ['2026-05-11T14:15:30', 'En tránsito nacional', 'in_transit'],
      ['2026-05-11T12:40:03', 'Despacho de tienda origen 1001 - Ciudad Muestra a Plataforma Norte', 'in_transit'],
      ['2026-05-11T09:05:12', 'Guía creada', 'accepted'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.time === undefined && event.location === undefined))
      .toBe(true);
  });

  it('keeps no recipient, ID number, origin store or scan description', () => {
    const json = JSON.stringify(parseTealca(fixture('delivered'), DELIVERED));
    expect(json).not.toMatch(/Persona Ejemplo|00000000|Estado Muestra|En la tienda 1001|10000001/);
  });

  it('reads a parcel on its way from its scans', () => {
    const result = parseTealca(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Recepción en Plataforma Oeste', last_update_local: '2026-09-29T13:20:38' });
    expect(result.events).toHaveLength(6);
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2026-09-28T10:14:09', description: 'Guía creada', stage: 'accepted' });
  });

  it('takes the summary’s word for a delivery and the scans’ for the rest', () => {
    // A delivery the scans do not show yet.
    expect(parseTealca(changed('in-transit', (shipment) => { shipment.status = '3'; }), IN_TRANSIT))
      .toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Recepción en Plataforma Oeste' });
    // Code 1, at the store, does not step a parcel back from a platform scan.
    expect(parseTealca(changed('in-transit', (shipment) => { shipment.status = 1; }), IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit' });
    // A return Tealca words in its own way still reads through the shared rules over code 2.
    const returned = parseTealca(changed('in-transit', (shipment) => {
      shipment.tracking.push({ status: 'Guía devuelta al remitente', description: '', date: '9/30/2026 9:00:00 AM' });
    }), IN_TRANSIT);
    expect(returned).toMatchObject({ current_stage: 'returned', current_stage_source: 'wording:language', last_status_text: 'Guía devuelta al remitente' });
    // Scans with no stage leave the summary's.
    const unstaged = parseTealca(changed('in-transit', (shipment) => {
      shipment.status = '1';
      shipment.tracking = [{ status: 'Nota de muestra', description: '', date: '9/28/2026 10:14:09 AM' }];
    }), IN_TRANSIT);
    expect(unstaged).toMatchObject({ status: 'in_transit', current_stage: 'accepted', current_stage_source: 'carrier_map' });
    expect(unstaged.events![0]).not.toHaveProperty('stage');
    const unknown = parseTealca(changed('in-transit', (shipment) => {
      shipment.status = '9';
      shipment.tracking = [{ status: 'Nota de muestra', description: '', date: '9/28/2026 10:14:09 AM' }];
    }), IN_TRANSIT);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Nota de muestra' });
    expect(unknown).not.toHaveProperty('current_stage');
  });

  it('takes the guía’s own number, the person who took the parcel, ID cards and phone numbers out of the wording', () => {
    expect(tealcaWording('Guía creada con el número 10000001')).toBe('Guía creada');
    expect(tealcaWording('Guía entregada a Persona Ejemplo - 00000000')).toBe('Guía entregada');
    expect(tealcaWording('Guía entregada a: Persona Ejemplo, V-00.000.000')).toBe('Guía entregada');
    expect(tealcaWording('Paquete retirado por Persona Ejemplo')).toBe('Paquete retirado');
    expect(tealcaWording('Llamar al 0400-000.00.00 o al +00 000 0000000 en tienda 2002')).toBe('Llamar al o al en tienda 2002');
    expect(tealcaWording('Despacho de tienda origen 1001 - Ciudad Muestra a Plataforma Norte'))
      .toBe('Despacho de tienda origen 1001 - Ciudad Muestra a Plataforma Norte');
    expect(tealcaWording('  En   tránsito nacional ')).toBe('En tránsito nacional');
  });

  it('reads an unknown guía as not found, a failed lookup as inconclusive and a shipment without scans as no history', () => {
    expect(() => parseTealca(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The lookup's crash on letters, and its refusal of an empty field.
    expect(() => parseTealca({ result: false, Message: 'Wrong parameters for Exception([string $message])', data: [] }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTealca({ result: false, Message: 'Los datos para consultar el tracking son inválidos ', data: [] }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTealca({ result: true, Message: '', data: [] }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTealca(changed('delivered', (shipment) => { shipment.tracking = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseTealca(changed('delivered', (shipment) => { delete (shipment as Row).tracking; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('keeps only the shipment whose number is the whole guía asked', () => {
    expect(() => parseTealca(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Tealca answered for another shipment' }));
    // The page shows every shipment whose number contains the one typed; only the whole number counts.
    const longer = changed('in-transit', (shipment, payload) => {
      payload.data.unshift({ ...structuredClone(shipment), shipment: `9${IN_TRANSIT}`, status: '3' });
    });
    expect(parseTealca(longer, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit' });
    expect(() => parseTealca(changed('in-transit', (shipment, payload) => { payload.data.push(structuredClone(shipment)); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Tealca returned several shipments under the number' }));
    expect(parseTealca(changed('in-transit', (shipment) => { shipment.shipment = Number(IN_TRANSIT); }), IN_TRANSIT).events).toHaveLength(6);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_shipment: Shipment, body: Reply) => { delete body.result; },
      (_shipment: Shipment, body: Reply) => { body.result = 'true'; },
      (_shipment: Shipment, body: Reply) => { body.data = {} as never; },
      (_shipment: Shipment, body: Reply) => { body.data = ['shipment'] as never; },
      (_shipment: Shipment, body: Reply) => { body.data = Array.from({ length: 21 }, () => body.data[0]!); },
      (shipment: Shipment) => { delete shipment.shipment; },
      (shipment: Shipment) => { shipment.shipment = ['10000002']; },
      (shipment: Shipment) => { shipment.tracking = 'scans' as never; },
      (shipment: Shipment) => { shipment.tracking = Array.from({ length: 301 }, () => shipment.tracking[0]!); },
      (shipment: Shipment) => { shipment.tracking[0] = 'scan' as never; },
      (shipment: Shipment) => { shipment.tracking[0]!.status = ['Guía creada']; },
      (shipment: Shipment) => { shipment.tracking[0]!.status = ' '; },
      (shipment: Shipment) => { shipment.tracking[0]!.status = '00000000'; },
      (shipment: Shipment) => { shipment.tracking[0]!.date = '2026-09-28T10:14:09'; },
      (shipment: Shipment) => { shipment.tracking[0]!.date = '9/28/2026 13:14:09 PM'; },
      (shipment: Shipment) => { shipment.tracking[0]!.date = '9/28/2026 0:14:09 AM'; },
      (shipment: Shipment) => { shipment.tracking[0]!.date = '2/30/2026 10:14:09 AM'; },
      (shipment: Shipment) => { shipment.tracking[0]!.date = '9/28/2026 10:14 AM'; },
      (shipment: Shipment) => { delete shipment.tracking[0]!.date; },
    ]) {
      expect(() => parseTealca(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown guía, a moved route, a browser check, a refusal and a broken reply apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // WordPress's answer for a route it does not have, a gone route and a redirect.
    await expect(lookup('{"code":"rest_no_route","message":"No route was found","data":{"status":404}}', { status: 404 }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://www.tealca.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Attention Required! | Cloudflare</title></html>', { status: 403, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('error code: 1015', { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '10' } }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 10_000 });
    await expect(lookup('<html><title>Rastrear Envío - Tealca</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 206 })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('tries once more after a failure to reach Tealca, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TealcaTracker({ fetcher, recorder }).fetch(DELIVERED, { budgetMs: 2000 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'tealca', step: 'retry', outcome: 'ok' }));
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

  it('rejects numbers Tealca does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['10001', '1000000000001', 'TL10000001', 'SAMPLETRACKING', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTealcaNumber(' 1000-0001 ')).toBe(DELIVERED);
  });

  it('declares no recognition: bare digit runs are no evidence of Tealca', () => {
    expect(carrier(vi.fn<typeof fetch>()).recognize).toBeUndefined();
  });

  it('routes a number filed under Tealca to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'tealca' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'tealca', source: 'tealca', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === TEALCA_API)).toBe(true);
  });
});

describe('Tealca numbers', () => {
  it('claims no bare digit run, which other carriers issue too', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN, '1000001']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('tealca');
    }
  });
});

describe('Tealca status vocabulary', () => {
  it('records every summary code and scan wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string }[]) {
      const answer = statusMapAnswer({ carrier: 'tealca', providerCode: entry.code ?? null, description: entry.wording });
      expect(answer, entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
      if (!entry.code) expect(tealcaStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('leaves an unknown code and wording to the shared rules', () => {
    expect(statusMap.stage('9', 'en tienda')).toBeUndefined();
    expect(tealcaMappedStage('Guía devuelta al remitente')).toBeUndefined();
    expect(tealcaStage('Guía devuelta al remitente')).toEqual({ stage: 'returned', source: 'wording:language' });
    expect(tealcaStage('Nota de muestra')).toBeNull();
    expect(statusMapAnswer({ carrier: 'tealca', providerCode: null, description: 'Nota de muestra' })).toEqual({ kind: 'unknown' });
  });
});
