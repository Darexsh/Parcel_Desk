import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ENVIA_API, EnviaTracker } from './adapter.js';
import { normalizeEnviaNumber, parseEnvia, readEnviaShipment } from './parser.js';
import { enviaStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '014000000017';
const IN_TRANSIT = '034000000025';
const UNKNOWN = '999000000001';

type Row = Record<string, unknown>;
type Reply = Row & { data: Row & Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const parse = (name: 'delivered' | 'in-transit', number: string, history: unknown = fixture(`${name}-history`), record: unknown = fixture(`${name}-record`)) =>
  parseEnvia(readEnviaShipment(record, number), history, number);
// The record, then the milestones, as the page asks them.
const answers = (name: 'delivered' | 'in-transit') => vi.fn<typeof fetch>()
  .mockResolvedValueOnce(reply(fixture(`${name}-record`))).mockResolvedValueOnce(reply(fixture(`${name}-history`)));

describe('Envía HTTP adapter', () => {
  it('posts the whole guía for its record, then asks its milestones, through the supplied transport', async () => {
    const fetcher = answers('in-transit');
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new EnviaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 034 000 000 025 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[recordUrl, recordInit], [historyUrl, historyInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(String(recordUrl)).toBe(`${ENVIA_API}/individual`);
    expect(recordInit).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: JSON.stringify({ guiaNumber: IN_TRANSIT }),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(String(historyUrl)).toBe(`${ENVIA_API}/history/${IN_TRANSIT}`);
    expect(historyInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(historyInit).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'envia-colombia', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered guía in Bogotá time, newest first, without the people, phones, addresses or proof image', () => {
    const result = parse('delivered', DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregado', last_update: '2026-05-14T15:42:00-05:00', delivered_at: '2026-05-14T15:42:00-05:00',
      expected_delivery: null, service_name: 'PAQUETE EXPRESS' });
    // The record's current state shares the delivery's clock, so the milestone tells it.
    expect(result.events).toEqual([
      { time: '2026-05-14T15:42:00-05:00', description: 'Entregado', location: 'PUEBLO MUESTRA-ANTIOQUIA', stage: 'delivered', stage_source: 'carrier_map' },
      { time: '2026-05-14T08:10:00-05:00', description: '¡Prepárate para recibirlo!', location: 'PUEBLO MUESTRA-ANTIOQUIA',
        stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { time: '2026-05-12T18:05:00-05:00', description: 'Tu envío está en movimiento.', location: 'MEDELLIN', stage: 'in_transit', stage_source: 'carrier_map' },
      // Midnight is a date without its time of day.
      { local_time: '2026-05-12', description: 'Tu guía fue generada', location: 'MEDELLIN', stage: 'registered', stage_source: 'carrier_map' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE (?:SENDER|RECIPIENT)|300000000|CL 1 2 3|KR 4|\.jpg|0\.0000|recorriendo/);
  });

  it('adds a later current state to the milestones, with its code, and keeps the estimate of a guía on its way', () => {
    const result = parse('in-transit', IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'EN TRANSITO A VILLA MUESTRA',
      last_update: '2026-10-07T22:15:00-05:00', expected_delivery: '2026-10-09', service_name: 'PAQUETE EXPRESS' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events).toEqual([
      { time: '2026-10-07T22:15:00-05:00', description: 'EN TRANSITO A VILLA MUESTRA', location: 'BOGOTA', provider_code: '5',
        stage: 'in_transit', stage_source: expect.stringMatching(/^wording:/) },
      // Milestones on one date keep the reply's order, newest first.
      { local_time: '2026-10-07', description: 'Tu envío está en movimiento.', location: 'BOGOTA', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-10-07', description: 'Tu guía fue generada', location: 'BOGOTA', stage: 'registered', stage_source: 'carrier_map' },
    ]);
  });

  it('keeps the sentence under a title the map does not know, and the newest staged scan sets the stage', () => {
    const result = parse('in-transit', IN_TRANSIT, changed('in-transit-history', (body) => {
      body.data.unshift({ ...body.data[0], eventCode: 'Sample notice', description: 'Sample note on the guía.', date: '2026-10-08T09:30:00' },
        { ...body.data[0], eventCode: 'Tu envío está en movimiento.', date: '2026-10-08T09:00:00' });
    }));
    expect(result.events!.slice(0, 2)).toEqual([
      { time: '2026-10-08T09:30:00-05:00', description: 'Sample notice: Sample note on the guía.', location: 'BOGOTA' },
      { time: '2026-10-08T09:00:00-05:00', description: 'Tu envío está en movimiento.', location: 'BOGOTA', stage: 'in_transit', stage_source: 'carrier_map' },
    ]);
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Sample notice: Sample note on the guía.',
      last_update: '2026-10-08T09:30:00-05:00' });
    // A milestone listed twice is kept once.
    const twice = parse('delivered', DELIVERED, changed('delivered-history', (body) => { body.data.push(body.data[0]!); }));
    expect(twice.events).toHaveLength(4);
  });

  it('answers with the current state alone when the record is undated and there are no milestones', () => {
    const empty = { success: true, message: null, errors: null, data: [] };
    const undated = changed('in-transit-record', (body) => { body.data.date = ''; });
    expect(parse('in-transit', IN_TRANSIT, empty, undated)).toEqual({ status: 'in_transit', current_stage: 'in_transit',
      current_stage_source: expect.stringMatching(/^wording:/), last_status_text: 'EN TRANSITO A VILLA MUESTRA', provider_code: '5',
      last_update: null, expected_delivery: '2026-10-09', service_name: 'PAQUETE EXPRESS', summary_only: true, events: [] });
    // A dated record without milestones is one scan.
    expect(parse('in-transit', IN_TRANSIT, empty).events).toHaveLength(1);
    const blank = changed('in-transit-record', (body) => { Object.assign(body.data, { date: null, estadoActual: null, eventCode: '', description: '' }); });
    expect(() => parse('in-transit', IN_TRANSIT, empty, blank)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('reads Envía’s not-found answer as not found, and nothing else', () => {
    expect(() => readEnviaShipment(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const body of [
      { success: false, message: 'Error interno.', errors: [], data: null },
      { success: false, message: 'No se encontró información para la guía especificada.', errors: [], data: {} },
      { success: 'false', message: 'No se encontró información para la guía especificada.', data: null },
    ]) expect(() => readEnviaShipment(body, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete body.success; },
      (body: Reply) => { body.data = 'data' as never; },
      (body: Reply) => { body.data = null as never; },
      (body: Reply) => { delete (body.data as Row).guiaNumber; },
      (body: Reply) => { body.data.guiaNumber = 14000000017; },
      (body: Reply) => { body.data.codEstado = { code: '13' }; },
      (body: Reply) => { body.data.estadoActual = ['ENTREGADA']; },
      (body: Reply) => { body.data.date = '14/05/2026 15:42'; },
      (body: Reply) => { body.data.date = '2026-05-14T15:42:00Z'; },
    ]) {
      expect(() => parse('delivered', DELIVERED, undefined, changed('delivered-record', change))).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const change of [
      (body: Reply) => { delete body.success; },
      (body: Reply) => { body.data = { rows: [] } as never; },
      (body: Reply) => { body.data = Array.from({ length: 201 }, () => body.data[0]) as never; },
      (body: Reply) => { body.data[0] = 'Entregado' as never; },
      (body: Reply) => { delete body.data[0]!.guiaNumber; },
      (body: Reply) => { body.data[0]!.eventCode = 13; },
      (body: Reply) => { delete body.data[0]!.date; },
      (body: Reply) => { body.data[0]!.date = '2026-05-14T15:42:00-05:00'; },
      (body: Reply) => { body.data[0]!.date = '2026-02-30T10:00:00'; },
      (body: Reply) => { body.data[0]!.date = '2026-05-14T24:00:00'; },
    ]) {
      expect(() => parse('delivered', DELIVERED, changed('delivered-history', change))).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A history the service refuses after finding the record is no answer either way.
    expect(() => parse('delivered', DELIVERED, { success: false, message: null, errors: [], data: null }))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // An estimate in another form is left out; fractions of a second are read.
    expect(parse('in-transit', IN_TRANSIT, undefined, changed('in-transit-record', (body) => { body.data.eta = '2026-10-09'; })))
      .toMatchObject({ expected_delivery: null });
    expect(parse('delivered', DELIVERED, changed('delivered-history', (body) => { body.data[0]!.date = '2026-05-14T15:42:00.000'; })).events![0])
      .toMatchObject({ time: '2026-05-14T15:42:00-05:00' });
  });

  it('binds the record and every milestone to the guía asked for', () => {
    expect(() => parse('delivered', DELIVERED, undefined, changed('delivered-record', (body) => { body.data.guiaNumber = '014000000018'; })))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse('delivered', DELIVERED, changed('delivered-history', (body) => { body.data[3]!.guiaNumber = '14000000017'; })))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps an unknown guía, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // A 404 without the service's own answer, a 405 or a redirect is a moved route, never a missing guía.
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ success: false, message: 'Not Found', data: null }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>404 - File or directory not found.</title></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>405 - HTTP verb not allowed</title></html>', { status: 405, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://envia.co/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head></html>',
      { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<!doctype html><html lang="es"><title>Envía</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
    // The milestones of a guía just found: a moved route is no answer about the guía.
    const history = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered-record'))).mockResolvedValueOnce(reply('', { status: 404 }));
    await expect(carrier(history).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'transport' });
  });

  it.each([[400, 'transport'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s for the record, the milestones and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
      const history = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('in-transit-record'))).mockResolvedValueOnce(new Response('', { status }));
      await expect(carrier(history).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
    });

  it('recognizes a known guía and the unknown-guía answer, and asks nothing for a number Envía does not issue', async () => {
    const fetcher = answers('delivered').mockResolvedValueOnce(reply(fixture('not-found'), { status: 404 }));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-05-14T20:42:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('01400000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers Envía does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['01400000001', '0140000000170', 'A14000000017', '014000000O17', `0${'1'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeEnviaNumber('014-000-000-017')).toBe(DELIVERED);
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('in-transit-record'))).mockResolvedValueOnce(reply(fixture('in-transit-history')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a guía filed under Envía to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      reply(fixture(String(url).endsWith('/individual') ? 'delivered-record' : 'delivered-history')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'envia-colombia' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'envia-colombia', source: 'envia-colombia', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${ENVIA_API}/history/${DELIVERED}`)).toBe(true);
  });
});

describe('Envía status vocabulary', () => {
  it('stages every milestone and code seen with the stage its record gives', () => {
    const seen = (statuses.entries as { code?: string; wording: string; stage?: string; confirmedBy: string }[])
      .filter((entry) => entry.confirmedBy === 'live' && entry.stage);
    expect(seen.length).toBeGreaterThan(4);
    for (const entry of seen) {
      expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(enviaStage(entry.code ?? '', entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'envia-colombia', providerCode: entry.code, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    // A code or title the map does not know falls to the shared wording rules.
    expect(enviaStage('99', 'Sample note')).toBeNull();
    expect(enviaStage('', 'Sample note')).toBeNull();
    expect(statusMap.stage('99', 'entregado')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'envia-colombia', providerCode: '99', description: 'Sample note' })).toEqual({ kind: 'unknown' });
  });
});
