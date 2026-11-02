import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, FEDEX_PL_API, FedexPlTracker } from './adapter.js';
import { normalizeFedexPlNumber, parseFedexPl } from './parser.js';
import { fedexPlStage, fedexPlSummaryStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '6230000000029';
const IN_TRANSIT = '6230000000012';
const UNKNOWN = '6230000000036';

type Row = Record<string, unknown>;
type Shipment = Row & { events: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Shipment;
const changed = (name: string, change: (shipment: Shipment) => void) => {
  const shipment = fixture(name);
  change(shipment);
  return shipment;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json;charset=UTF-8', ...init.headers } });
// The service's answer for a number it does not know: HTTP 204 without a body.
const unknown = () => new Response(null, { status: 204 });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The courier's scan that gives the parcel a delivery window, newest.
const outForDelivery = (shipment: Shipment) => {
  shipment.status = 'WYDANA DO DORĘCZENIA';
  shipment.events.unshift({ depot: 'PRZYKŁADOWO', euid: null, eventDate: '2026-07-08T07:40:12+0200',
    eventName: 'Przesyłka wydana do doręczenia kurierowi FedEx.', eventExId: -1000000106, bitMark: null, eventCode: 'WK', act: 1,
    argsExtra: 'Planowane doręczenie w przedziale godzinowym 12:00-15:00.', signature: null });
};

describe('FedEx Poland HTTP adapter', () => {
  it('asks the tracking app’s lookup for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new FedexPlTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 623 0000-000 012 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${FEDEX_PL_API}?trackingKey=${IN_TRANSIT}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init?.method ?? 'GET').toBe('GET');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'fedex-pl', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each scan’s instant with the offset the service gives, and stages it by its code', () => {
    const result = parseFedexPl(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Przesyłka w oddziale FedEx.', last_update: '2026-07-08T01:32:08+02:00', expected_delivery: null, weight_kg: 0.75 });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('expected_delivery_from');
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.location])).toEqual([
      ['2026-07-08T01:32:08+02:00', 'WE', 'in_transit', 'PRZYKŁADOWO'],
      ['2026-07-08T01:32:07+02:00', 'WG.S', 'in_transit', 'PRZYKŁADOWO'],
      ['2026-07-07T17:57:43+02:00', 'SR.P', 'in_transit', 'HUB WZORCOWY'],
      ['2026-07-07T17:41:57+02:00', 'WG.S', 'in_transit', 'HUB WZORCOWY'],
      ['2026-07-07T13:15:35+02:00', 'PKL', 'accepted', 'NADAWCZOWO'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.stage_source === 'carrier_map')).toBe(true);
  });

  it('keeps the delivery without the signature, the sender’s reference or the repeated scan', () => {
    const result = parseFedexPl(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Przesyłka doręczona do odbiorcy.', last_update: '2026-01-14T13:05:10+01:00',
      delivered_at: '2026-01-14T13:05:10+01:00', expected_delivery: null, weight_kg: 3.2 });
    // The courier's window is over once the parcel is delivered.
    expect(result).not.toHaveProperty('expected_delivery_from');
    expect(result.events).toHaveLength(10);
    expect(result.events!.map((event) => [event.provider_code ?? null, event.stage])).toEqual([
      ['DS', 'delivered'], ['AV', 'failed_attempt'], ['WK', 'out_for_delivery'], ['WE', 'in_transit'], ['WG.S', 'in_transit'],
      ['SR.P', 'in_transit'], ['WG.O', 'in_transit'], ['PK', 'in_transit'], ['PKL', 'accepted'],
      // A scan without a code is staged by its wording.
      [null, 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE|DS-SIG|Planowane/);
  });

  it('gives the courier’s delivery window while the parcel is out for delivery', () => {
    const result = parseFedexPl(changed('in-transit', outForDelivery), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery',
      last_status_text: 'Przesyłka wydana do doręczenia kurierowi FedEx.',
      expected_delivery_from: '2026-07-08T12:00:00+02:00', expected_delivery: '2026-07-08T15:00:00+02:00' });
    expect(result.events![0]).toEqual({ time: '2026-07-08T07:40:12+02:00', location: 'PRZYKŁADOWO',
      description: 'Przesyłka wydana do doręczenia kurierowi FedEx.', provider_code: 'WK', stage: 'out_for_delivery', stage_source: 'carrier_map' });
    // A window that ended before the scan, or wording the map does not know, gives none.
    for (const extra of ['Planowane doręczenie w przedziale godzinowym 05:00-07:00.', 'Synthetic note', null]) {
      const other = parseFedexPl(changed('in-transit', (shipment) => {
        outForDelivery(shipment);
        shipment.events[0]!.argsExtra = extra;
      }), IN_TRANSIT);
      expect(other.expected_delivery, String(extra)).toBeNull();
      expect(other).not.toHaveProperty('expected_delivery_from');
    }
  });

  it('takes the overall status’s word for a delivery the scans do not stage', () => {
    const result = parseFedexPl(changed('delivered', (shipment) => {
      Object.assign(shipment.events[0]!, { eventCode: 'ZZ', eventName: 'Synthetic note' });
    }), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      delivered_at: '2026-01-14T13:05:10+01:00', last_status_text: 'Synthetic note' });
    expect(result.events![0]).not.toHaveProperty('stage');
    // Without the delivery's own time, the delivery scan's is used.
    expect(parseFedexPl(changed('delivered', (shipment) => { shipment.deliveryDate = null; }), DELIVERED))
      .toMatchObject({ delivered_at: '2026-01-14T13:05:10+01:00' });
    // A return to the sender is not read as a delivery.
    expect(parseFedexPl(changed('delivered', (shipment) => {
      Object.assign(shipment.events[0]!, { eventCode: 'ZZ', eventName: 'Zwrot przesyłki do nadawcy.' });
    }), DELIVERED)).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map' });
    // An overall status the map does not know leaves the scans to decide.
    expect(parseFedexPl(changed('in-transit', (shipment) => { shipment.status = 'SYNTHETIC'; }), IN_TRANSIT))
      .toMatchObject({ current_stage: 'in_transit' });
  });

  it('reads a history listed oldest first newest first, as the page shows it', () => {
    const result = parseFedexPl(changed('in-transit', (shipment) => { shipment.events.reverse(); }), IN_TRANSIT);
    expect(result).toMatchObject({ last_update: '2026-07-08T01:32:08+02:00', current_stage: 'in_transit' });
    expect(result.events!.at(-1)).toMatchObject({ provider_code: 'PKL' });
  });

  it('keeps scans of one second in the order of a history listed oldest first', () => {
    const result = parseFedexPl(changed('in-transit', (shipment) => {
      shipment.events.reverse();
      shipment.events[4]!.eventDate = shipment.events[3]!.eventDate;
    }), IN_TRANSIT);
    expect(result.events!.slice(0, 2).map((event) => event.provider_code)).toEqual(['WE', 'WG.S']);
  });

  it('reads a record without scans as no history', () => {
    expect(() => parseFedexPl(changed('in-transit', (shipment) => { shipment.events = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseFedexPl(changed('in-transit', (shipment) => { shipment.events = null as never; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a shipment only when it is the number asked', () => {
    expect(() => parseFedexPl(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'FedEx Poland answered for another number' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (shipment: Shipment) => { delete (shipment as Row).events; },
      (shipment: Shipment) => { delete shipment.trackingKey; },
      (shipment: Shipment) => { shipment.trackingKey = Number(IN_TRANSIT); },
      (shipment: Shipment) => { shipment.shipmentNo = null; },
      (shipment: Shipment) => { shipment.shipmentNo = 'SAMPLE'; },
      (shipment: Shipment) => { shipment.events = 'events' as never; },
      (shipment: Shipment) => { shipment.events = Array.from({ length: 501 }, () => shipment.events[0]!); },
      (shipment: Shipment) => { shipment.events[0] = 'scan' as never; },
      (shipment: Shipment) => { shipment.events[0]!.eventDate = '2026-07-08 01:32:08'; },
      (shipment: Shipment) => { shipment.events[0]!.eventDate = '2026-07-08T01:32:08'; },
      (shipment: Shipment) => { shipment.events[0]!.eventDate = '2026-02-30T01:32:08+0100'; },
      (shipment: Shipment) => { delete shipment.events[0]!.eventDate; },
      (shipment: Shipment) => { shipment.events[0]!.eventName = ['Przesyłka w oddziale FedEx.']; },
      (shipment: Shipment) => { shipment.events[0]!.eventName = ''; },
      (shipment: Shipment) => { shipment.events[0]!.depot = 7; },
      (shipment: Shipment) => { shipment.status = 7; },
    ]) {
      expect(() => parseFedexPl(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseFedexPl(null, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFedexPl(changed('delivered', (shipment) => { shipment.deliveryDate = '2026-01-14'; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a withheld one, a refused one, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response())).track({ number: UNKNOWN });
    await expect(lookup(unknown)).rejects.toMatchObject({ kind: 'not_found' });
    // The page sends the visitor to customer service for this answer: the number may exist.
    await expect(lookup(() => new Response(null, { status: 240 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(() => reply(fixture('invalid-number'), { status: 400 }))).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(lookup(() => reply('<html>Bad Request</html>', { status: 400 }))).rejects.toMatchObject({ kind: 'transport' });
    // The page reads an unknown number from an empty 204: a 404 or a redirect is a moved route.
    await expect(lookup(() => reply('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 302, headers: { Location: 'https://poland.fedex.com/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('<html><head><title>Access Denied</title></head><body>Reference #18.0</body></html>',
      { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply('<html><title>FedEx Tracking</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => reply(''))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => reply({ trackingKey: UNKNOWN }, { status: 201 }))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number FedEx Poland does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered'))).mockResolvedValueOnce(unknown());
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-01-14T12:05:10.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('623000000002')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    // A reply for another number is no recognition.
    const other = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    await expect(carrier(other).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('rejects numbers FedEx Poland does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['623000000002', '62300000000290', 'A230000000029', '794600000000', `6${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeFedexPlNumber('623 000-000.0029')).toBe(DELIVERED);
  });

  it('sends a read that failed to reach the service once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
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

  it('routes a number filed under FedEx Poland to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'fedex-pl' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'fedex-pl', source: 'fedex-pl', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${FEDEX_PL_API}?trackingKey=${DELIVERED}`)).toBe(true);
  });
});

describe('FedEx Poland status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean; note?: string }[]) {
      if (entry.note?.includes('overall status')) {
        expect(fedexPlSummaryStage(entry.wording), entry.wording).toBe(entry.stage);
        continue;
      }
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBeUndefined();
        expect(fedexPlStage(entry.code ?? '', entry.wording), entry.wording).toBeNull();
        expect(statusMapAnswer({ carrier: 'fedex-pl', providerCode: entry.code ?? null, description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(fedexPlStage(entry.code ?? '', entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'fedex-pl', providerCode: 'AV', description: 'Nieudana próba doręczenia. Przesyłka awizowana.' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'fedex-pl', providerCode: 'ZZ', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A code the map does not know is staged by the service's wording, then by the shared rules.
    expect(fedexPlStage('ZZ', 'Zwrot przesyłki do nadawcy.')).toEqual({ stage: 'returned', source: 'carrier_map' });
    expect(fedexPlStage('ZZ', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(fedexPlStage('ZZ', 'Synthetic note')).toBeNull();
    expect(fedexPlStage('wk', 'Synthetic note')).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
  });
});
