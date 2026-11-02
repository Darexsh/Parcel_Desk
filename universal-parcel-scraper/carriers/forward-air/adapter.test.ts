import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, FORWARD_AIR_API, forwardAirLookupUrl, ForwardAirTracker } from './adapter.js';
import { normalizeForwardAirNumber, parseForwardAir } from './parser.js';
import { forwardAirStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '12345679';
const IN_TRANSIT = '87654321';
const UNKNOWN = '11111111';

type Row = Record<string, unknown>;
type Shipment = Row & { Statuses: Row[] };
type Reply = { errors: unknown[]; results: Shipment[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (body: Reply) => void) => {
  const body = fixture(name);
  change(body);
  return body;
};
// The in-transit reply with its one shipment changed.
const transit = (change: (shipment: Shipment) => void) => changed('in-transit', (body) => change(body.results[0]!));
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The service's answer to a request that does not name the site as its referrer.
const REFUSAL = { error: 'I\'m a teapot' };
// Cloudflare's managed challenge, as a CDN could put it in place of the reply.
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:"managed"};</script></body></html>';
const scan = (code: string, description: string, date: string, station: string, zone: string | null): Row => ({
  statusCode: code, StatusDescription: description, RecordDate: date, AirportCode: station, TimeZoneCode: zone,
  RecordedBy: 'SAMPLE CLERK', ManifestNumber: '', ActualWeight: 10, Pieces: 1, WeightType: 'L',
});

describe('Forward Air HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole waybill once, naming the site, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ForwardAirTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 8765 4321 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${FORWARD_AIR_API}?numbers=${IN_TRANSIT}`);
    expect(forwardAirLookupUrl('8765-4321')).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', Origin: 'https://www.forwardair.com', Referer: 'https://www.forwardair.com/', 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'forward-air', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the newest shipment under a reused waybill, each station clock in the zone it names, without people or references', () => {
    const result = parseForwardAir(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Invoiced', last_update: '2026-03-20T10:05:00-04:00', expected_delivery: null,
      delivered_at: '2026-03-17T14:20:00-05:00', weight_kg: 113.398 });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage ?? null, event.location, event.description]))
      .toEqual([
        // Billing after the delivery moves nothing.
        ['2026-03-20T10:05:00-04:00', 'INVC', null, 'GCY', 'Invoiced'],
        ['2026-03-17T14:20:00-05:00', 'DLV', 'delivered', 'DFW', 'Delivered'],
        ['2026-03-17T14:12:00-05:00', 'DARR', 'out_for_delivery', 'DFW', 'Arrived at delivery location'],
        ['2026-03-17T07:40:00-05:00', 'OUTDV', 'out_for_delivery', 'DFW', 'Out for delivery'],
        // The repeated arrival is kept once.
        ['2026-03-16T05:55:00-05:00', 'ARRD', 'in_transit', 'DFW', 'Arrived: Destination Facility'],
        ['2026-03-15T19:30:00-04:00', 'DEP', 'in_transit', 'ATL', 'Departed: Transit Facility'],
        ['2026-03-15T16:02:00-04:00', 'TND', 'accepted', 'ATL', 'Tendered'],
        ['2026-03-15T13:45:00-04:00', 'PUP', 'accepted', 'ATL', 'Picked Up'],
        ['2026-03-15T13:30:00-04:00', 'PARR', 'registered', 'ATL', 'Arrived at pickup location'],
        ['2026-03-15T11:10:00-04:00', 'DPUP', 'registered', 'ATL', 'Dispatched for Pickup'],
      ]);
    expect(result.events!.every((event) => event.local_time === undefined)).toBe(true);
    // The older shipment and the one found by its reference are not read, nor is anyone named.
    expect(JSON.stringify(result)).not.toMatch(/2023|SEA|J SAMPLE|SAMPLE (?:CLERK|DRIVER|DISPATCH)|OLDSAMPLE|PO-SAMPLE|9000001|000200002|1000002|GabsKey|SrOid/);
  });

  it('keeps a Mountain or unlabelled clock as the station’s wall clock, and reads a repeated hour as its first occurrence', () => {
    const result = parseForwardAir(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Arrived: Destination Facility', last_update: null, last_update_local: '2026-11-02T04:10:00',
      expected_delivery: '2026-11-02', weight_kg: 544.538 });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time ?? null, event.local_time ?? null, event.provider_code, event.stage, event.location]))
      .toEqual([
        [null, '2026-11-02T04:10:00', 'ARRD', 'in_transit', 'DEN'],
        ['2026-11-01T01:30:00-05:00', null, 'DEP', 'in_transit', 'DFW'],
        ['2026-10-31T22:15:00-05:00', null, 'ARR', 'in_transit', 'DFW'],
        ['2026-10-31T13:05:00-07:00', null, 'DEP', 'in_transit', 'SEA'],
        ['2026-10-31T09:40:00-07:00', null, 'TND', 'accepted', 'SEA'],
        ['2026-10-31T08:55:00-07:00', null, 'RCV', 'accepted', 'SEA'],
        [null, '2026-10-31T08:55:00', 'ACK', 'registered', 'SEA'],
      ]);
    // Another label, a station that is not a code and a label in lower case.
    const other = parseForwardAir(transit((shipment) => {
      shipment.Statuses[1] = { ...shipment.Statuses[1]!, TimeZoneCode: 'HT', AirportCode: 'Dallas, TX' };
      shipment.Statuses[2] = { ...shipment.Statuses[2]!, TimeZoneCode: 'pt' };
    }), IN_TRANSIT);
    expect(other.events!.slice(1, 3).map((event) => [event.time ?? null, event.local_time ?? null, event.location ?? null])).toEqual([
      [null, '2026-11-01T01:30:00', null],
      ['2026-10-31T22:15:00-07:00', null, 'DFW'],
    ]);
    // An hour Eastern clocks skip names no instant.
    const skipped = parseForwardAir(transit((shipment) => {
      shipment.Statuses = [scan('RCV', 'Received: Origin Facility', '03/08/2026 02:30', 'ATL', 'ET')];
    }), IN_TRANSIT);
    expect(skipped.events).toEqual([{ local_time: '2026-03-08T02:30:00', location: 'ATL', description: 'Received: Origin Facility',
      provider_code: 'RCV', stage: 'accepted', stage_source: 'carrier_map' }]);
  });

  it('turns an oldest-first history round, and keeps a delivery when a scan is recorded after it', () => {
    const reversed = parseForwardAir(transit((shipment) => { shipment.Statuses.reverse(); }), IN_TRANSIT);
    expect(reversed.events!.map((event) => event.provider_code)).toEqual(['ARRD', 'DEP', 'ARR', 'DEP', 'TND', 'RCV', 'ACK']);
    // A station-to-station shipment recovered at the destination before its arrival scan was entered.
    const recovered = parseForwardAir(transit((shipment) => {
      shipment.Statuses.splice(1, 0, scan('COMP', 'Recovered', '11/01/2026 01:30', 'DEN', 'MT'));
      shipment.Statuses[0]!.RecordDate = '11/02/2026 09:00';
    }), IN_TRANSIT);
    expect(recovered).toMatchObject({ status: 'delivered', current_stage: 'delivered', expected_delivery: null,
      last_status_text: 'Arrived: Destination Facility' });
    // The delivery's clock has no verified offset, so there is no delivery instant.
    expect(recovered).not.toHaveProperty('delivered_at');
    const cancelled = parseForwardAir(transit((shipment) => {
      shipment.Statuses.unshift(scan('CAN', 'Cancelled', '11/02/2026 10:00', 'DEN', null));
    }), IN_TRANSIT);
    expect(cancelled).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Cancelled' });
  });

  it('reads the estimate the page shows, and a weight only in pounds', () => {
    const estimate = (window: unknown, available: unknown = '11/02/2026 09:00') => parseForwardAir(transit((shipment) => {
      shipment.EstimatedDeliveryRange = window;
      shipment.EstimatedAvailableDate = available;
    }), IN_TRANSIT).expected_delivery;
    expect(estimate('11/03/2026 08:00-11/04/2026 17:00')).toBe('2026-11-04');
    expect(estimate(null)).toBe('2026-11-02');
    expect(estimate('11/03/2026 08:00')).toBe('2026-11-02');
    expect(estimate('', '')).toBeNull();
    expect(estimate('', '02/30/2026 09:00')).toBeNull();
    const weight = (value: unknown, unit: unknown) => parseForwardAir(transit((shipment) => {
      shipment.Weight = value;
      shipment.WeightType = unit;
    }), IN_TRANSIT).weight_kg;
    expect(weight(1, 'L')).toBe(0.454);
    expect(weight(50, 'K')).toBeUndefined();
    expect(weight(0, 'L')).toBeUndefined();
    expect(weight('50', 'L')).toBeUndefined();
  });

  it('reads the unknown-waybill answer as not found, and any other empty answer as inconclusive', () => {
    expect(() => parseForwardAir(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The answer must echo the waybill asked.
    expect(() => parseForwardAir(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseForwardAir({ errors: ['Something went wrong'], results: [] }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseForwardAir({ errors: [], results: [] }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseForwardAir({ results: [] }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseForwardAir(transit((shipment) => { shipment.Statuses = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseForwardAir(transit((shipment) => { delete (shipment as Row).Statuses; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    // A newer shipment without scans under the waybill is not answered with an older one's history.
    expect(() => parseForwardAir(changed('delivered', (body) => {
      body.results.push({ ...body.results[1]!, RecordDate: '09/01/2026 08:00', Statuses: [] });
    }), DELIVERED)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a shipment only when its waybill is the number asked', () => {
    // A shipment the tracker found by its reference, and nothing under the waybill.
    expect(() => parseForwardAir(changed('delivered', (body) => { body.results = [body.results[2]!]; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Forward Air answered for another shipment' }));
    expect(() => parseForwardAir(fixture('in-transit'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseForwardAir(transit((shipment) => { shipment.AirbillNumber = '087654321'; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseForwardAir(transit((shipment) => { shipment.AirbillNumber = ' 87654321 '; }), IN_TRANSIT).events).toHaveLength(7);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (shipment: Shipment) => { delete shipment.AirbillNumber; },
      (shipment: Shipment) => { shipment.AirbillNumber = 87654321; },
      (shipment: Shipment) => { shipment.Statuses = 'scans' as never; },
      (shipment: Shipment) => { shipment.Statuses = Array.from({ length: 501 }, () => shipment.Statuses[0]!); },
      (shipment: Shipment) => { shipment.Statuses[0] = 'scan' as never; },
      (shipment: Shipment) => { delete shipment.Statuses[0]!.statusCode; },
      (shipment: Shipment) => { shipment.Statuses[0]!.statusCode = 'ARR D'; },
      (shipment: Shipment) => { shipment.Statuses[0]!.statusCode = ['ARRD']; },
      (shipment: Shipment) => { shipment.Statuses[0]!.StatusDescription = ''; },
      (shipment: Shipment) => { shipment.Statuses[0]!.StatusDescription = { text: 'Arrived' }; },
      (shipment: Shipment) => { shipment.Statuses[0]!.AirportCode = ['DEN']; },
      (shipment: Shipment) => { shipment.Statuses[0]!.TimeZoneCode = 7; },
      (shipment: Shipment) => { shipment.Statuses[0]!.RecordDate = null; },
      (shipment: Shipment) => { shipment.Statuses[0]!.RecordDate = '2026-11-02T04:10:00'; },
      (shipment: Shipment) => { shipment.Statuses[0]!.RecordDate = '11/02/2026 24:00'; },
      (shipment: Shipment) => { shipment.Statuses[0]!.RecordDate = '02/30/2026 04:10'; },
      (shipment: Shipment) => { shipment.Statuses[0]!.RecordDate = 1_793_600_000_000; },
      (shipment: Shipment) => { shipment.EstimatedDeliveryRange = ['11/02/2026']; },
      (shipment: Shipment) => { shipment.RecordDate = 20261102; },
    ]) {
      expect(() => parseForwardAir(transit(change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of ['reply', null, { errors: [], results: 'none' }, { errors: 'none', results: [] }, { errors: [7], results: [] },
      { errors: [], results: ['shipment'] }, { errors: [], results: Array.from({ length: 51 }, () => fixture('in-transit').results[0]) }]) {
      expect(() => parseForwardAir(body, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown waybill, a refusal, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(REFUSAL, { status: 418 })).rejects.toMatchObject({ kind: 'challenge', status: 418 });
    await expect(lookup({ message: 'Not Found' }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.forwardair.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(CHALLENGE, { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHALLENGE, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Tracking | Forward Air</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ results: null })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known waybill and the unknown-waybill answer, and asks nothing for a number Forward Air does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')))
      .mockResolvedValueOnce(reply(REFUSAL, { status: 418 }));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-20T14:05:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(fetcher).recognize!('1234567')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers Forward Air does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['1234567', '123456789', 'ABCDEFGH', '1234567X', `1234567${'8'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeForwardAirNumber('8765 4321')).toBe(IN_TRANSIT);
  });

  it('tries a read that hangs once more, and ends inside the budget', async () => {
    fakeBudgetClock();
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: 50, reply: () => reply(fixture('in-transit')) }]);
    const answered = carrier(recovered.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answered).resolves.toMatchObject({ current_stage: 'in_transit' });
    // Half of the budget, then the retry within the rest.
    expect(recovered.ended).toEqual([200, 250]);
    const started = performance.now();
    const hanging = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(hanging.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(hanging.fetcher).toHaveBeenCalledTimes(2);
    expect(hanging.ended.map((at) => at - started)).toEqual([60, 120]);
  });

  it('routes a waybill filed under Forward Air to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'forward-air' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'forward-air', source: 'forward-air', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === forwardAirLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('Forward Air numbers', () => {
  it('leaves eight digits unclaimed', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN]) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('forward-air');
    }
  });
});

describe('Forward Air status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      // The help page's wordings come without a code.
      if (!entry.code) continue;
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(forwardAirStage(entry.code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'forward-air', providerCode: 'COMP', description: 'Recovered' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'forward-air', providerCode: 'INVC', description: 'Invoiced' }))
      .toEqual({ kind: 'intentional_gap', note: expect.any(String) });
    expect(statusMapAnswer({ carrier: 'forward-air', providerCode: 'ZZZ', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(statusMap.stage(null, 'delivered')).toBeUndefined();
    // A code the map does not know falls to the shared wording rules.
    expect(forwardAirStage('ZZZ', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(forwardAirStage('ZZZ', 'Synthetic note')).toBeNull();
    expect(forwardAirStage('dlv', 'Delivered')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(forwardAirStage('INVC', 'Delivered')).toBeNull();
  });
});
