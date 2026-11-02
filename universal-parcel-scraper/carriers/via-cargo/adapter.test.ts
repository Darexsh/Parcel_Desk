import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, VIA_CARGO_API, ViaCargoTracker } from './adapter.js';
import { normalizeViaCargoNumber, parseViaCargo } from './parser.js';
import { statusMap, viaCargoStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '999000000000';
const OTHER = '999999999999';

type Row = Record<string, unknown>;
type Shipment = Row & { listaEventos: Row[] };
type Reply = Row & { ok: { objeto: Shipment }[]; errores: unknown[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (shipment: Shipment, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.ok[0]!.objeto, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Via Cargo HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number with the page’s key and an empty token, once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ViaCargoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 999 000 000 000 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${VIA_CARGO_API}?NumeroEnvio=${NUMBER}&tokenRecaptcha=`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'PUBLIC-KEY': expect.any(String), 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'via-cargo', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history in Buenos Aires time, newest first, without the people, addresses or customer requests', () => {
    const result = parseViaCargo(fixture('delivered'), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'ENTREGADA', last_update: '2026-03-07T11:45:00-03:00', delivered_at: '2026-03-07T11:45:00-03:00',
      expected_delivery: null, weight_kg: 5, service_name: 'VIA CARGO ESTANDAR' });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.location])).toEqual([
      ['2026-03-07T11:45:00-03:00', 'ENTR', 'delivered', 'PUEBLO EJEMPLO'],
      ['2026-03-05T14:20:00-03:00', 'RCPV', 'in_transit', 'PUEBLO EJEMPLO'],
      // The repeated departure is kept once.
      ['2026-03-03T21:05:00-03:00', 'CPCE', 'in_transit', 'CENTRO DE DISTRIBUCION EJEMPLO'],
      // The receipt keeps the time it happened, not the time it was entered.
      ['2026-03-02T18:30:00-03:00', 'RECD', 'in_transit', 'CENTRO DE DISTRIBUCION EJEMPLO'],
      ['2026-03-02T13:40:00-03:00', 'MANI', 'in_transit', 'SUCURSAL EJEMPLO - CALLE 0'],
      ['2026-03-02T09:10:00-03:00', 'ALTA', 'accepted', 'SUCURSAL EJEMPLO - CALLE 0'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.local_time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE|EJEMPLO 0|PROVINCIA|00000000|0000000000|SOLICITUD|IMPROCEDENTE|EFECTUADA|02:20/);
  });

  it('reads a shipment on its way to the destination branch', () => {
    const result = parseViaCargo(fixture('in-transit'), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'EN VIAJE', last_update: '2026-04-16T06:38:00-03:00', expected_delivery: null,
      weight_kg: 1.5, service_name: 'VIA CARGO PLUS ED' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.provider_code, event.location])).toEqual([
      ['CPCE', 'CENTRO DE DISTRIBUCION EJEMPLO'], ['CPCE', 'TERMINAL EJEMPLO'], ['MANI', 'TERMINAL EJEMPLO'], ['ALTA', 'TERMINAL EJEMPLO'],
    ]);
  });

  it('orders scans by their clocks, takes the entry time when the event time is missing and stages an unknown type by its wording', () => {
    const result = parseViaCargo(changed('in-transit', (shipment) => {
      shipment.listaEventos.reverse();
      delete shipment.listaEventos[3]!.fechaEvento;
      shipment.listaEventos.push({ descripcion: 'EN REPARTO', tipoEvento: 'SYNT', deleNombre: 'CIUDAD EJEMPLO', fechaEvento: '17/04/2026 08:00' });
      shipment.listaEventos.push({ descripcion: 'NOTA DE EJEMPLO', tipoEvento: '', deleNombre: '', fechaEvento: '17/04/2026 08:00' });
    }), NUMBER);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'NOTA DE EJEMPLO' });
    expect(result.events!.slice(0, 2)).toEqual([
      // Equal clocks of a reply listed oldest first come out reversed; a scan without a type or a place keeps its wording.
      { time: '2026-04-17T08:00:00-03:00', description: 'NOTA DE EJEMPLO' },
      { time: '2026-04-17T08:00:00-03:00', location: 'CIUDAD EJEMPLO', description: 'EN REPARTO', provider_code: 'SYNT',
        stage: 'out_for_delivery', stage_source: 'wording:language' },
    ]);
    // The departure without its event time takes the minute it was entered.
    expect(result.events![2]).toMatchObject({ provider_code: 'CPCE', time: '2026-04-16T06:39:00-03:00' });
    expect(result.events!.at(-1)).toMatchObject({ provider_code: 'ALTA', time: '2026-04-14T16:05:00-03:00' });
  });

  it('dates a delivery by the first delivered scan the history ends with', () => {
    const result = parseViaCargo(changed('delivered', (shipment) => {
      shipment.listaEventos.unshift({ ...shipment.listaEventos[0]!, fechaEvento: '08/03/2026 09:00' });
    }), NUMBER);
    expect(result).toMatchObject({ last_update: '2026-03-08T09:00:00-03:00', delivered_at: '2026-03-07T11:45:00-03:00' });
  });

  it('leaves out a weight the reply does not have', () => {
    for (const kilos of [0, null, '']) {
      expect(parseViaCargo(changed('in-transit', (shipment) => { shipment.kilos = kilos; }), NUMBER), String(kilos)).not.toHaveProperty('weight_kg');
    }
    expect(parseViaCargo(changed('in-transit', (shipment) => { shipment.kilos = '2.5'; }), NUMBER)).toMatchObject({ weight_kg: 2.5 });
    expect(parseViaCargo(changed('in-transit', (shipment) => { shipment.descripcionServicio = null; }), NUMBER)).not.toHaveProperty('service_name');
  });

  it('reads an unknown number as not found, a failed lookup as inconclusive and a shipment without scans as no history', () => {
    expect(() => parseViaCargo(fixture('not-found'), OTHER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseViaCargo({ ok: [], errores: ['Error de ejemplo'], score: null }, OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseViaCargo({ ...fixture('delivered'), errores: [{ mensaje: 'Error de ejemplo' }] }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The service leaves the reCAPTCHA score null; an empty reply with one may be a refused token.
    expect(() => parseViaCargo({ ok: [], errores: [], score: 0.1 }, OTHER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseViaCargo({ ok: [], errores: [] }, OTHER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseViaCargo(changed('delivered', (shipment) => { shipment.listaEventos = []; }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseViaCargo(changed('delivered', (shipment) => { delete (shipment as Row).listaEventos; }), NUMBER))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a shipment only when its own number is the one asked', () => {
    expect(() => parseViaCargo(fixture('delivered'), OTHER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Via Cargo answered for another shipment' }));
    const both = fixture('delivered');
    both.ok.push(changed('in-transit', (shipment) => { shipment.numeroEnvio = OTHER; }).ok[0]!);
    expect(parseViaCargo(both, OTHER)).toMatchObject({ service_name: 'VIA CARGO PLUS ED' });
    expect(parseViaCargo(both, NUMBER)).toMatchObject({ service_name: 'VIA CARGO ESTANDAR' });
    both.ok.push(fixture('in-transit').ok[0]!);
    expect(() => parseViaCargo(both, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_shipment: Shipment, body: Reply) => { delete (body as Row).ok; },
      (_shipment: Shipment, body: Reply) => { delete (body as Row).errores; },
      (_shipment: Shipment, body: Reply) => { body.ok = { objeto: true } as never; },
      (_shipment: Shipment, body: Reply) => { body.ok = Array.from({ length: 21 }, () => body.ok[0]!); },
      (_shipment: Shipment, body: Reply) => { body.ok[0] = 'shipment' as never; },
      (_shipment: Shipment, body: Reply) => { body.ok[0] = { objeto: null } as never; },
      (shipment: Shipment) => { delete shipment.numeroEnvio; },
      (shipment: Shipment) => { shipment.numeroEnvio = 999000000000; },
      (shipment: Shipment) => { shipment.listaEventos = 'scans' as never; },
      (shipment: Shipment) => { shipment.listaEventos = Array.from({ length: 301 }, () => shipment.listaEventos[0]!); },
      (shipment: Shipment) => { shipment.listaEventos[0] = 'scan' as never; },
      (shipment: Shipment) => { shipment.listaEventos[0]!.descripcion = ''; },
      (shipment: Shipment) => { shipment.listaEventos[0]!.descripcion = ['EN VIAJE']; },
      (shipment: Shipment) => { shipment.listaEventos[0]!.tipoEvento = 7; },
      (shipment: Shipment) => { shipment.listaEventos[0]!.deleNombre = { nombre: 'EJEMPLO' }; },
      (shipment: Shipment) => { shipment.listaEventos[0]!.fechaEvento = '2026-04-16 06:38'; },
      (shipment: Shipment) => { shipment.listaEventos[0]!.fechaEvento = '16/04/2026 6:38'; },
      (shipment: Shipment) => { shipment.listaEventos[0]!.fechaEvento = '31/04/2026 06:38'; },
      (shipment: Shipment) => { shipment.listaEventos[0]!.fechaEvento = '16/04/2026 24:00'; },
      (shipment: Shipment) => { delete shipment.listaEventos[0]!.fechaEvento; delete shipment.listaEventos[0]!.fechaAlta; },
      (shipment: Shipment) => { shipment.descripcionServicio = { nombre: 'ESTANDAR' }; },
      (shipment: Shipment) => { shipment.kilos = -1; },
      (shipment: Shipment) => { shipment.kilos = '5 kg'; },
      (shipment: Shipment) => { shipment.kilos = true; },
    ]) {
      expect(() => parseViaCargo(changed('in-transit', change), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a refused key, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: NUMBER });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(fixture('access-denied'), { status: 403 })).rejects.toMatchObject({ kind: 'challenge', message: 'Via Cargo refused the lookup' });
    // The service answers an unknown number with HTTP 200; a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://example.invalid/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Via Cargo</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ status: false, message: 'Error de ejemplo' })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(NUMBER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number Via Cargo does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-07T14:45:00.000Z' });
    await expect(carrier(fetcher).recognize!(OTHER)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('998000000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Via Cargo does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['99900000000', '9990000000000', '998000000000', '000000000000', 'SAMPLE000000', `999${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: NUMBER }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeViaCargoNumber('999-000-000-000')).toBe(NUMBER);
  });

  it('sends a read that failed to reach the service once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: NUMBER }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: NUMBER }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a number filed under Via Cargo to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('in-transit')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: NUMBER, carrier: 'via-cargo' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'via-cargo', source: 'via-cargo', result: { current_stage: 'in_transit' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(`${VIA_CARGO_API}?`))).toBe(true);
  });
});

describe('Via Cargo numbers', () => {
  it('leaves the twelve digits starting with 999 to other carriers’ rules and the user', () => {
    expect(detectCarrierMatch(NUMBER).carrier).not.toBe('via-cargo');
  });
});

describe('Via Cargo status vocabulary', () => {
  it('stages every event type seen with the stage its record gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string }[]) {
      expect(statusMap.stage(entry.code!, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(viaCargoStage(entry.code!, entry.wording)).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'via-cargo', providerCode: entry.code!, description: entry.wording }))
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    // A type the map does not know falls to the shared wording rules.
    expect(viaCargoStage('SYNT', 'DEVUELTO AL REMITENTE')).toMatchObject({ stage: 'returned' });
    expect(viaCargoStage('SYNT', 'NOTA DE EJEMPLO')).toBeNull();
    expect(statusMap.stage(null, 'entregada')).toBeUndefined();
  });
});
