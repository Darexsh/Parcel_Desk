import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PYLE_API, pyleLookupUrl, PyleTracker } from './adapter.js';
import { normalizePyleNumber, parsePyle } from './parser.js';
import { pyleStage, pyleWordingStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '123456780';
const IN_TRANSIT = '987654321';
const UNKNOWN = '111111111';

type Row = Record<string, unknown>;
type Shipment = Row & { statusHistory: Row[]; shipmentDetails: Row };
type Reply = { response: { shipmentStatus: { result: Shipment[] } } };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
// A fixture with its one shipment changed.
const changed = (name: string, change: (shipment: Shipment) => void) => {
  const body = fixture(name);
  change(body.response.shipmentStatus.result[0]!);
  return body;
};
const delivered = (change: (shipment: Shipment) => void) => changed('delivered', change);
const transit = (change: (shipment: Shipment) => void) => changed('in-transit', change);
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// Cloudflare's managed challenge, as it could stand in place of the reply.
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:"managed"};</script></body></html>';
const row = (description: string, location: string, state: string, start: string, offset = '-05:00', end = start): Row => ({
  description, location, city: location.split(',')[0] ?? '', state, start, startUTC: offset, end, endUTC: offset,
});

describe('A. Duie Pyle HTTP adapter', () => {
  it('asks the shipment status page’s lookup for the whole PRO once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PyleTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 987-654-321 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${PYLE_API}?type=0&value=${IN_TRANSIT}`);
    expect(pyleLookupUrl('987 654 321')).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'a-duie-pyle', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history newest first, with the offsets its places keep, without parties or references', () => {
    const result = parsePyle(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'DELIVERED', last_update: '2026-01-23T11:20:00-05:00', expected_delivery: null,
      delivered_at: '2026-01-23T11:42:00-05:00', weight_kg: 226.796 });
    expect(result.events!.map((event) => [event.time ?? null, event.local_time ?? null, event.stage ?? null, event.location ?? null,
      event.description])).toEqual([
      // The page dates the delivery with the end of its row; the scan keeps its start.
      ['2026-01-23T11:20:00-05:00', null, 'delivered', 'SAMPLETOWN, NJ', 'DELIVERED'],
      // A row without a place has no zone to check its offset against.
      [null, '2026-01-23T07:05:00', 'out_for_delivery', null, 'OUT FOR DELIVERY'],
      ['2026-01-22T01:30:44-05:00', null, 'in_transit', 'EXAMPLE JUNCTION, NJ', 'ARRIVED AT TERMINAL'],
      ['2026-01-21T20:15:00-05:00', null, 'in_transit', 'SAMPLE GAP, PA', 'DEPARTED TERMINAL'],
      // The arrival listed twice is kept once.
      ['2026-01-21T04:02:55-05:00', null, 'in_transit', 'SAMPLE GAP, PA', 'ARRIVED AT TERMINAL'],
      ['2026-01-20T21:40:12-05:00', null, 'in_transit', 'Sampleburg, OH', 'DEPARTED TERMINAL'],
      // Eastern time's offset on a clock in Illinois is not the place's, so the wall clock stays.
      [null, '2026-01-20T14:10:00', 'accepted', 'EXAMPLEVILLE, IL', 'PICKED UP'],
    ]);
    // The windows are not scans, and the billing status moves nothing.
    expect(JSON.stringify(result)).not.toMatch(/WINDOW|INVOICED/);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE (?:RECEIVING|MILLS|LOGISTICS)|SAMPLE AVE|EXAMPLE RD|INVENTED|MADEUP CITY|0999|6999|SAMPLEBOL|PO-SAMPLE|DOOR|J SAMPLE/);
  });

  it('reads a midnight pickup as its day, a repeated hour by the offset the reply gives, and a hand-off to a partner', () => {
    const result = parsePyle(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'ARRIVED AT TERMINAL', last_update: '2026-11-02T03:15:00-05:00',
      expected_delivery_from: '2026-11-04T08:00:00-05:00', expected_delivery: '2026-11-04T12:00:00-05:00',
      delivery_carrier: 'southeastern-freight-lines', delivery_tracking_number: '1234567890', weight_kg: 544.311 });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events!.map((event) => [event.time ?? null, event.local_time ?? null, event.stage])).toEqual([
      ['2026-11-02T03:15:00-05:00', null, 'in_transit'],
      // The second 01:30 of the night Eastern clocks go back.
      ['2026-11-01T01:30:00-05:00', null, 'in_transit'],
      ['2026-10-31T02:10:00-04:00', null, 'in_transit'],
      ['2026-10-30T19:45:00-04:00', null, 'in_transit'],
      [null, '2026-10-30', 'accepted'],
    ]);
    // The first 01:30 that night reads as its own instant.
    const first = parsePyle(transit((shipment) => { shipment.statusHistory[3]!.startUTC = '-04:00'; }), IN_TRANSIT);
    expect(first.events![1]!.time).toBe('2026-11-01T01:30:00-04:00');
  });

  it('keeps a wall clock whose offset its place does not keep, or whose place keeps several zones', () => {
    const clocks = (state: string, offset: string) => parsePyle(transit((shipment) => {
      shipment.statusHistory = [row('ARRIVED AT TERMINAL', `SAMPLEPORT, ${state}`, state, '2026-07-10T09:30:00', offset)];
    }), IN_TRANSIT).events![0]!;
    expect(clocks('NY', '-04:00')).toMatchObject({ time: '2026-07-10T09:30:00-04:00' });
    expect(clocks('NY', '-05:00')).toMatchObject({ local_time: '2026-07-10T09:30:00' });
    expect(clocks('IL', '-05:00')).toMatchObject({ time: '2026-07-10T09:30:00-05:00' });
    expect(clocks('KY', '-04:00')).toMatchObject({ local_time: '2026-07-10T09:30:00' });
    expect(clocks('ON', '-04:00')).toMatchObject({ local_time: '2026-07-10T09:30:00' });
    expect(clocks('NY', '')).toMatchObject({ local_time: '2026-07-10T09:30:00' });
    // The place comes from the row's state, whatever its location reads.
    expect(parsePyle(transit((shipment) => {
      shipment.statusHistory = [{ ...row('DEPARTED TERMINAL', '', 'pa', '2026-07-10T09:30:00', '-04:00'), city: 'SAMPLE GAP' }];
    }), IN_TRANSIT).events).toEqual([{ time: '2026-07-10T09:30:00-04:00', location: 'SAMPLE GAP, PA', description: 'DEPARTED TERMINAL',
      stage: 'in_transit', stage_source: 'carrier_map' }]);
    const local = parsePyle(transit((shipment) => { shipment.statusHistory.forEach((scan) => { scan.state = 'ON'; }); }), IN_TRANSIT);
    expect(local).toMatchObject({ last_update: null, last_update_local: '2026-11-02T03:15:00',
      expected_delivery: '2026-11-04' });
    expect(local).not.toHaveProperty('expected_delivery_from');
  });

  it('reads the estimate the page shows until the delivery', () => {
    const estimate = (change: (shipment: Shipment) => void) => {
      const { expected_delivery, expected_delivery_from } = parsePyle(transit(change), IN_TRANSIT);
      return [expected_delivery_from ?? null, expected_delivery];
    };
    const eta = (start: string, end: string, offset = '-05:00') => row('ETA WINDOW', 'SAMPLE CITY, NC', 'NC', start, offset, end);
    // The latest ETA window comes before the appointment.
    expect(estimate((shipment) => {
      shipment.statusHistory.push(eta('2026-11-03T09:00:00', '2026-11-03T10:00:00'), eta('2026-11-03T13:00:00', '2026-11-03T14:30:00'));
    })).toEqual(['2026-11-03T13:00:00-05:00', '2026-11-03T14:30:00-05:00']);
    // A window without checked offsets gives its days.
    expect(estimate((shipment) => { shipment.statusHistory.push(eta('2026-11-03T09:00:00', '2026-11-04T10:00:00', '')); }))
      .toEqual(['2026-11-03', '2026-11-04']);
    expect(estimate((shipment) => { shipment.statusHistory.push(eta('2026-11-03T09:00:00', '2026-11-03T10:00:00', '-04:00')); }))
      .toEqual([null, '2026-11-03']);
    // Without a window, the day the shipment is due.
    expect(estimate((shipment) => { shipment.statusHistory.pop(); })).toEqual([null, '2026-11-05']);
    expect(estimate((shipment) => { shipment.statusHistory.pop(); shipment.estimatedDeliveryTime = ''; })).toEqual([null, null]);
    // A pickup window is no estimate.
    expect(estimate((shipment) => {
      shipment.statusHistory.pop();
      shipment.estimatedDeliveryTime = '';
      shipment.statusHistory.push(row('PICKUP WINDOW', 'EXAMPLEVILLE, OH', 'OH', '2026-10-30T08:00:00', '-04:00', '2026-10-30T12:00:00'));
    })).toEqual([null, null]);
  });

  it('names only the partners the page links, with their PRO', () => {
    const partner = (scac: unknown, pro: unknown) => {
      const { delivery_carrier, delivery_tracking_number } = parsePyle(transit((shipment) => {
        shipment.interlineTo = scac;
        shipment.interlineToPro = pro;
      }), IN_TRANSIT);
      return [delivery_carrier ?? null, delivery_tracking_number ?? null];
    };
    expect(partner('DAFG', '0123-4567')).toEqual(['dayton-freight', '01234567']);
    expect(partner('oakh', '12345678')).toEqual(['oak-harbor', '12345678']);
    expect(partner('SZTG', '12345678')).toEqual([null, null]);
    expect(partner('SEFL', '')).toEqual([null, null]);
    expect(partner('', '')).toEqual([null, null]);
    expect(partner('SEFL', '12#45678')).toEqual([null, null]);
  });

  it('keeps a delivery as the end, and takes the shipment’s delivered status over a history without it', () => {
    const late = parsePyle(delivered((shipment) => {
      shipment.statusHistory.push(row('ARRIVED AT TERMINAL', 'EXAMPLE JUNCTION, NJ', 'NJ', '2026-01-24T02:00:00'));
    }), DELIVERED);
    expect(late).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'ARRIVED AT TERMINAL',
      delivered_at: '2026-01-23T11:42:00-05:00', expected_delivery: null });
    const summary = parsePyle(transit((shipment) => { shipment.status = 'DELIVERED'; }), IN_TRANSIT);
    expect(summary).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', expected_delivery: null });
    expect(summary).not.toHaveProperty('delivered_at');
    // A delivery row whose end has no checked offset is dated by its start.
    const start = parsePyle(delivered((shipment) => { shipment.statusHistory[8]!.endUTC = ''; }), DELIVERED);
    expect(start.delivered_at).toBe('2026-01-23T11:20:00-05:00');
    // Wording the map does not know falls to the shared rules, else stays without a stage.
    const worded = parsePyle(transit((shipment) => {
      shipment.statusHistory.push(row('SAMPLE NOTE', 'SAMPLE HARBOR, VA', 'VA', '2026-11-02T09:00:00'));
    }), IN_TRANSIT);
    expect(worded).toMatchObject({ current_stage: 'in_transit', last_status_text: 'SAMPLE NOTE' });
    expect(worded.events![0]).not.toHaveProperty('stage');
  });

  it('weighs the freight in pounds the page shows', () => {
    const weight = (value: unknown) => parsePyle(transit((shipment) => { shipment.shipmentDetails.weight = value; }), IN_TRANSIT).weight_kg;
    expect(weight('1')).toBe(0.454);
    expect(weight(10)).toBe(4.536);
    expect(weight('0')).toBeUndefined();
    expect(weight('')).toBeUndefined();
    expect(weight('1,200')).toBeUndefined();
  });

  it('reads the unknown-PRO answer as not found, and any other empty answer as inconclusive', () => {
    expect(() => parsePyle(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The answer must echo the PRO asked.
    expect(() => parsePyle(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const answer = (result: unknown[]) => () => parsePyle({ response: { shipmentStatus: { result } } }, UNKNOWN);
    expect(answer([{ pro: UNKNOWN, errorMessage: 'Something went wrong' }])).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(answer([])).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePyle(transit((shipment) => { shipment.statusHistory = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parsePyle(transit((shipment) => { delete (shipment as Row).statusHistory; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    // Windows alone are no history.
    expect(() => parsePyle(transit((shipment) => { shipment.statusHistory = shipment.statusHistory.slice(-1); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a shipment only when its PRO is the number asked', () => {
    expect(() => parsePyle(fixture('in-transit'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate',
      message: 'A. Duie Pyle answered for another shipment' }));
    expect(() => parsePyle(transit((shipment) => { shipment.pro = `0${IN_TRANSIT}`; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parsePyle(transit((shipment) => { shipment.pro = ` ${IN_TRANSIT} `; }), IN_TRANSIT).events).toHaveLength(5);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (shipment: Shipment) => { delete shipment.pro; },
      (shipment: Shipment) => { shipment.pro = 987654321; },
      (shipment: Shipment) => { shipment.errorMessage = { text: 'none' }; },
      (shipment: Shipment) => { shipment.statusHistory = 'rows' as never; },
      (shipment: Shipment) => { shipment.statusHistory = Array.from({ length: 501 }, () => shipment.statusHistory[0]!); },
      (shipment: Shipment) => { shipment.statusHistory[0] = 'row' as never; },
      (shipment: Shipment) => { shipment.statusHistory[0]!.description = ''; },
      (shipment: Shipment) => { shipment.statusHistory[0]!.description = ['PICKED UP']; },
      (shipment: Shipment) => { shipment.statusHistory[0]!.location = 7; },
      (shipment: Shipment) => { shipment.statusHistory[0]!.start = ''; },
      (shipment: Shipment) => { shipment.statusHistory[0]!.start = '2026-10-30 19:45'; },
      (shipment: Shipment) => { shipment.statusHistory[0]!.start = '2026-10-30T24:00:00'; },
      (shipment: Shipment) => { shipment.statusHistory[0]!.start = '2026-02-30T08:00:00'; },
      (shipment: Shipment) => { shipment.statusHistory[0]!.start = '2026-10-30T19:45:00-04:00'; },
      (shipment: Shipment) => { shipment.statusHistory[0]!.startUTC = 'EDT'; },
      (shipment: Shipment) => { shipment.statusHistory[0]!.end = 1_793_600_000_000; },
      (shipment: Shipment) => { shipment.shipmentDetails = 'none' as never; },
      (shipment: Shipment) => { shipment.statusHistory.pop(); shipment.estimatedDeliveryTime = '11/05/2026'; },
      (shipment: Shipment) => { shipment.interlineTo = ['SEFL']; },
    ]) {
      expect(() => parsePyle(transit(change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of ['reply', null, {}, { response: [] }, { response: { shipmentStatus: { result: 'none' } } },
      { response: { shipmentStatus: { result: ['shipment'] } } },
      { response: { shipmentStatus: { result: Array.from({ length: 26 }, () => fixture('in-transit').response.shipmentStatus.result[0]) } } }]) {
      expect(() => parsePyle(body, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown PRO, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup({ code: 'rest_no_route', message: 'No route was found matching the URL and request method.', data: { status: 404 } },
      { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://aduiepyle.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(CHALLENGE, { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHALLENGE, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Track Your Freight Shipment | A. Duie Pyle</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ response: null })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply({ code: 'error', message: 'Synthetic failure', data: null }, { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known PRO and the unknown-PRO answer, and asks nothing for a number Pyle does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')))
      .mockResolvedValueOnce(reply(CHALLENGE, { headers: { 'Content-Type': 'text/html' } }));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-01-23T16:20:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(fetcher).recognize!('1234567')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers Pyle does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['1234567', '1234567890', 'ABCDEFGHI', '12345678X', `12345678${'9'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    // The service takes eight digits too.
    expect(normalizePyleNumber('1234 5678')).toBe('12345678');
    expect(pyleLookupUrl('12345678')).toBe(`${PYLE_API}?type=0&value=12345678`);
  });

  it('tries a read that hangs once more, and ends inside the budget', async () => {
    fakeBudgetClock();
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: 50, reply: () => reply(fixture('in-transit')) }]);
    const answered = carrier(recovered.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answered).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(recovered.fetcher).toHaveBeenCalledTimes(2);
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

  it('routes a PRO the caller names Pyle’s to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'a-duie-pyle' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'a-duie-pyle', source: 'a-duie-pyle', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === pyleLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('A. Duie Pyle numbers', () => {
  it('leaves eight and nine digits to the caller’s choice, and reads shipment status page links', () => {
    // Many carriers issue eight or nine digits, so neither detection nor recognition offers Pyle.
    for (const number of [DELIVERED, IN_TRANSIT, '12345678']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('a-duie-pyle');
      expect(recognitionAskedCarriers(number), number).not.toContain('a-duie-pyle');
    }
    for (const link of [`https://aduiepyle.com/resources/shipment-status/?tracking=${DELIVERED}`,
      `https://www.aduiepyle.com/resources/shipment-status?tracking=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'a-duie-pyle', source: 'link' });
    }
  });
});

describe('A. Duie Pyle status vocabulary', () => {
  it('records every wording the map knows with the stage it gives, and leaves the billing and windows out', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string }[]) {
      expect(pyleWordingStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      if (entry.stage) expect(pyleStage(entry.wording.toLowerCase()), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'a-duie-pyle', providerCode: null, description: 'DELIVERED' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'a-duie-pyle', providerCode: null, description: 'INVOICED' }))
      .toEqual({ kind: 'intentional_gap', note: expect.any(String) });
    expect(statusMapAnswer({ carrier: 'a-duie-pyle', providerCode: null, description: 'SAMPLE NOTE' })).toEqual({ kind: 'unknown' });
    expect(statusMap.stage('X1', 'delivered')).toBeUndefined();
    expect(pyleStage('INVOICED')).toBeNull();
    // Wording the map does not know falls to the shared rules.
    expect(pyleStage('Shipment delivered to consignee')).toMatchObject({ stage: 'delivered' });
    expect(pyleStage('SAMPLE NOTE')).toBeNull();
  });
});
