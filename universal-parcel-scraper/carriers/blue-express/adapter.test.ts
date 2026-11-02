import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, BLUE_EXPRESS_API, BlueExpressTracker } from './adapter.js';
import { normalizeBlueExpressNumber, parseBlueExpress } from './parser.js';
import { blueExpressMappedStage, blueExpressStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '9000000010';
const IN_TRANSIT = '9000000020';
const UNKNOWN = '9000000090';

type Row = Record<string, unknown>;
type Day = Row & { rawDate: string; events: Row[] };
type Reply = Row & { data: { traceMicrostates: Row & { orderId: unknown; microstates: Day[] } } };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply, days: Day[]) => void) => {
  const body = fixture(name);
  change(body, body.data.traceMicrostates.microstates);
  return body;
};
const scan = (rawDate: string, eventCode: string, time: string, title?: string, place = 'Ciudad Central'): Day => ({
  formattedDate: 'día de ejemplo', rawDate, events: [{ name: `${eventCode}_TAG`, time, ...(title ? { title } : {}), locationName: 'RCEN1-2-CEN7C',
    displayLocationName: place, displayLocationAddress: place, type: 'check', eventCode }],
});
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Blue Express HTTP adapter', () => {
  it('asks the tracking page’s scan lookup once for the whole number, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new BlueExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 90000-00020 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(BLUE_EXPRESS_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: JSON.stringify({ os: IN_TRANSIT }),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'blue-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('lists the scans the page shows, newest first, with local clocks, the town or point and the code', () => {
    const result = parseBlueExpress(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregado', last_update: null, last_update_local: '2026-03-12T14:07:23', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.location ?? null, event.description, event.provider_code, event.stage])).toEqual([
      ['2026-03-12T14:07:23', 'Ciudad Destino', 'Entregado', 'DL', 'delivered'],
      ['2026-03-12T09:27:06', 'Ciudad Destino', 'En reparto', 'LD', 'out_for_delivery'],
      ['2026-03-12T08:12:09', 'Ciudad Destino', 'Paquete en centro de distribución', 'DA', 'in_transit'],
      ['2026-03-11T21:34:13', 'Ciudad Origen', 'Traslado interregional', 'IC', 'in_transit'],
      ['2026-03-11T18:14:10', 'Ciudad Origen', 'Centro de distribución de Blue Express', 'PUH', 'in_transit'],
      ['2026-03-11T15:02:28', 'Punto Blue Express Tienda Ejemplo', 'Retirado', 'ASO', 'accepted'],
      ['2026-03-10T10:47:56', 'Punto Blue Express Tienda Ejemplo', 'Admitido en Punto Blue Express', 'PUO', 'accepted'],
      // The page names no place for the sender's announcement.
      ['2026-03-10T09:38:15', null, 'Aviso de envío recibido', 'GE', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !('time' in event))).toBe(true);
    // Scans without a title, internal place codes and the point's street address are not kept.
    expect(JSON.stringify(result)).not.toMatch(/"(?:TR|CS|RH|FI)"|RDES|PBB0001|Calle Ejemplo|Web/);
  });

  it('reads a parcel out again after a failed round, past a notice and new delivery details that move nothing', () => {
    const result = parseBlueExpress(fixture('in-transit'), IN_TRANSIT);
    expect(result).toEqual({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'En reparto', last_update: null, last_update_local: '2026-04-18T09:41:00', expected_delivery: null, events: expect.any(Array) });
    expect(result.events!.map((event) => [event.provider_code, event.stage ?? null])).toEqual([
      ['LD', 'out_for_delivery'], ['CE', null], ['SQ', null], ['TS', 'failed_attempt'], ['DI', 'failed_attempt'], ['LD', 'out_for_delivery'],
      ['DA', 'in_transit'], ['IC', 'in_transit'], ['PUH', 'in_transit'], ['PU', 'accepted'], ['GE', 'registered'],
    ]);
    // With the new address the newest scan, the failed round is the parcel's stage.
    const waiting = parseBlueExpress(changed('in-transit', (_body, days) => { days.splice(0, 2); }), IN_TRANSIT);
    expect(waiting).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: 'Nueva dirección de entrega' });
  });

  it('keeps a parcel on its way back to the sender until the sender has it', () => {
    const returning = parseBlueExpress(changed('in-transit', (_body, days) => {
      days.unshift(scan('19-04-2026', 'LD', '10:13:00', 'En reparto', 'Ciudad Origen'), scan('18-04-2026', 'IC', '20:00:00', 'Traslado interregional'),
        { ...scan('18-04-2026', 'SQ', '14:52:00', 'En proceso devolución al remitente'), subEventCode: 'DR' });
    }), IN_TRANSIT);
    expect(returning).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map', last_status_text: 'En reparto' });
    expect(returning.events!.slice(0, 3).map((event) => event.stage)).toEqual(['out_for_delivery', 'in_transit', 'exception']);
    const back = parseBlueExpress(changed('in-transit', (_body, days) => {
      days.unshift(scan('19-04-2026', 'DLV', '17:25:20', 'Pedido entregado al remitente', 'Ciudad Origen'),
        scan('18-04-2026', 'SQ', '14:52:00', 'En proceso devolución al remitente'));
    }), IN_TRANSIT);
    expect(back).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Pedido entregado al remitente' });
    // A delivery after a return that was called off ends the journey.
    const delivered = parseBlueExpress(changed('in-transit', (_body, days) => {
      days.unshift(scan('19-04-2026', 'DL', '12:00:00', 'Entregado', 'Ciudad Destino'), scan('18-04-2026', 'SQ', '14:52:00', 'En proceso devolución al remitente'));
    }), IN_TRANSIT);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
  });

  it('lets an administrative incident after the delivery stand without undoing it, and new codes fall to the wording rules', () => {
    const after = parseBlueExpress(changed('delivered', (_body, days) => {
      days.unshift(scan('20-03-2026', 'FZP', '18:41:02', 'Incidencia administrativa resuelta'), scan('19-03-2026', 'FW', '10:21:23', 'Incidencia administrativa'));
    }), DELIVERED);
    expect(after).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Incidencia administrativa resuelta' });
    expect(after.events!.slice(0, 2).every((event) => event.stage === undefined && event.provider_code)).toBe(true);
    const worded = parseBlueExpress(changed('in-transit', (_body, days) => { days.unshift(scan('19-04-2026', 'ZZ', '09:00:00', 'Nadie en casa')); }), IN_TRANSIT);
    expect(worded).toMatchObject({ current_stage: 'failed_attempt', current_stage_source: expect.stringMatching(/^wording:/) });
    const unknown = parseBlueExpress(changed('in-transit', (_body, days) => { days.splice(0, days.length, scan('15-04-2026', 'ZZ', '09:00:00', 'Línea de ejemplo')); }), IN_TRANSIT);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Línea de ejemplo' });
    expect(unknown).not.toHaveProperty('current_stage');
  });

  it('keeps a scan whose day the lookup lost without a clock, and turns an oldest-first reply round', () => {
    const lost = parseBlueExpress(changed('delivered', (_body, days) => { days[0]!.rawDate = 'NaN-NaN-NaN'; days[0]!.events[0]!.time = '00:00:00'; }), DELIVERED);
    expect(lost).toMatchObject({ current_stage: 'delivered', last_status_text: 'Entregado', last_update_local: '2026-03-12T09:27:06' });
    expect(lost.events![0]).toEqual({ location: 'Ciudad Destino', description: 'Entregado', provider_code: 'DL', stage: 'delivered', stage_source: 'carrier_map' });
    const reversed = parseBlueExpress(changed('delivered', (_body, days) => { days.reverse(); }), DELIVERED);
    expect(reversed).toMatchObject({ current_stage: 'delivered', last_update_local: '2026-03-12T14:07:23' });
    expect(reversed.events!.map((event) => event.local_time)).toEqual(parseBlueExpress(fixture('delivered'), DELIVERED).events!.map((event) => event.local_time));
  });

  it('keeps a scan listed twice once', () => {
    const result = parseBlueExpress(changed('in-transit', (_body, days) => { days.splice(1, 0, structuredClone(days[0]!)); }), IN_TRANSIT);
    expect(result.events).toHaveLength(11);
  });

  it('counts a reply only when it names the number asked', () => {
    expect(() => parseBlueExpress(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Blue Express answered for another shipment' }));
  });

  it('reads the lookup’s answer for an unknown number as not found, and a history without titled scans as no history', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('not-found'), 404));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(() => parseBlueExpress(changed('in-transit', (_body, days) => { days.splice(0, days.length, scan('15-04-2026', 'FI', '10:00:11')); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseBlueExpress(changed('in-transit', (body) => { body.data.traceMicrostates.microstates = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { body.status = 'error'; },
      (body: Reply) => { body.data = null as never; },
      (body: Reply) => { delete body.data.traceMicrostates.orderId; },
      (body: Reply) => { body.data.traceMicrostates.orderId = 9000000020; },
      (body: Reply) => { body.data.traceMicrostates.microstates = 'days' as never; },
      (body: Reply) => { body.data.traceMicrostates.microstates = Array.from({ length: 1001 }, () => scan('15-04-2026', 'TR', '10:00:00')); },
      (_body: Reply, days: Day[]) => { days[0]!.events = Array.from({ length: 1001 }, () => days[1]!.events[0]!); },
      (_body: Reply, days: Day[]) => { days[0] = 'day' as never; },
      (_body: Reply, days: Day[]) => { days[0]!.rawDate = 18 as never; },
      (_body: Reply, days: Day[]) => { days[0]!.events = 'scans' as never; },
      (_body: Reply, days: Day[]) => { days[0]!.events[0] = 'scan' as never; },
      (_body: Reply, days: Day[]) => { delete days[0]!.events[0]!.eventCode; },
      (_body: Reply, days: Day[]) => { days[0]!.events[0]!.title = 7; },
      (_body: Reply, days: Day[]) => { days[0]!.events[0]!.displayLocationName = { name: 'Ciudad' }; },
      (_body: Reply, days: Day[]) => { days[0]!.rawDate = '2026-04-18'; },
      (_body: Reply, days: Day[]) => { days[0]!.rawDate = '30-02-2026'; },
      (_body: Reply, days: Day[]) => { days[0]!.events[0]!.time = '09:41'; },
      (_body: Reply, days: Day[]) => { days[0]!.events[0]!.time = '24:00:00'; },
    ]) {
      expect(() => parseBlueExpress(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of [[], null, 7, 'Envío', { status: 'ok' }]) expect(() => parseBlueExpress(body, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps a firewall refusal, a browser check, a moved route and a broken reply apart from missing parcels', async () => {
    const lookup = (body: string, status = 200, headers: Record<string, string> = {}) =>
      carrier(vi.fn<typeof fetch>().mockImplementation(async () => reply(body, status, headers))).track({ number: UNKNOWN });
    // Cloudflare's refusal outside a browser, as the page's summary lookup gets it.
    await expect(lookup('Not found', 404)).rejects.toMatchObject({ kind: 'challenge', status: 404 });
    await expect(lookup(CLOUDFLARE, 403, { 'Content-Type': 'text/html' })).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(CLOUDFLARE, 200, { 'Content-Type': 'text/html' })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<!DOCTYPE html><html><title>404</title></html>', 404, { 'Content-Type': 'text/html' })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', 410)).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Blue Express</title></html>', 200, { 'Content-Type': 'text/html' })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', 200)).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('{"status":"error"}', 404)).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', 307, { Location: 'https://www.blue.cl/' })).rejects.toMatchObject({ kind: 'indeterminate' });
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it.each([[400, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply({ status: 'error', message: 'Sample', error: 'Sample' }, status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number, and asks nothing for one Blue Express does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toMatchObject({ known: true });
    await expect(carrier(fetcher).recognize!('900000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects numbers Blue Express does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['900000001', '90000000100', 'OS90000000', 'PKG0000000001', `9${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeBlueExpressNumber(' 9000 000 010 ')).toBe(DELIVERED);
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const started = Date.now();
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 60.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a number filed under Blue Express to the adapter, and leaves its plain digit run unclaimed', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'blue-express' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'blue-express', source: 'blue-express', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === BLUE_EXPRESS_API)).toBe(true);
    expect(detectCarrierMatch(DELIVERED).carrier).not.toBe('blue-express');
  });
});

describe('Blue Express status vocabulary', () => {
  it('records every code and title seen live with the stage the map gives it', () => {
    const entries = (statuses.entries as { code?: string; wording: string; stage?: string; confirmedBy: string }[])
      .filter((entry) => entry.confirmedBy === 'live');
    expect(entries.length).toBeGreaterThan(30);
    for (const entry of entries) {
      const stage = blueExpressStage(entry.code!, entry.wording)?.stage;
      expect(stage, `${entry.code} ${entry.wording}`).toBe(entry.stage);
      expect(blueExpressMappedStage(entry.code!, entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(entry.code!, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'blue-express', providerCode: entry.code!, description: entry.wording }), entry.wording)
        .toEqual(entry.stage ? { kind: 'mapped', stage: entry.stage } : { kind: 'intentional_gap', note: expect.any(String) });
    }
    expect(statusMapAnswer({ carrier: 'blue-express', providerCode: 'ZZ', description: 'Línea de ejemplo' })).toEqual({ kind: 'unknown' });
  });
});
