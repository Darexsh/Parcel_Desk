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
import { adapter, DAYLIGHT_API, daylightLookupUrls, DaylightTracker } from './adapter.js';
import { isDaylightUnknown, normalizeDaylightNumber, parseDaylight } from './parser.js';
import { daylightStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '61234567';
const IN_TRANSIT = '62345678';
const UNKNOWN = '69999999';

type Row = Record<string, unknown>;
type Details = { success: boolean; item: Row & { delivery: Row } };
type History = { success: boolean; item: Row[] };

const fixture = <T>(name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as T;
const details = (name: string, change: (shipment: Details['item']) => void = () => {}) => {
  const body = fixture<Details>(`${name}.details`);
  change(body.item);
  return { status: 200, body };
};
const history = (name: string, change: (rows: Row[]) => void = () => {}) => {
  const body = fixture<History>(`${name}.history`);
  change(body.item);
  return body;
};
const unknownDetails = () => ({ status: 404, body: fixture<unknown>('not-found.details') });
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
/** A transport answering the details and the history lookups of one shipment. */
const replies = (detailsReply: () => Response, historyReply: () => Response) => vi.fn<typeof fetch>().mockImplementation(
  async (url) => (String(url).includes('/history/') ? historyReply() : detailsReply()));
const shipment = (name: string) => replies(() => reply(fixture(`${name}.details`)), () => reply(fixture(`${name}.history`)));
const missing = () => replies(() => reply(fixture('not-found.details'), { status: 404 }), () => reply(fixture('not-found.history')));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// Cloudflare's managed challenge, as it could stand in place of a reply.
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:"managed"};</script></body></html>';
const events = (result: ReturnType<typeof parseDaylight>) => result.events!.map((event) => [event.local_time, event.description,
  event.stage ?? null, event.location ?? null]);

describe('Daylight Transport HTTP adapter', () => {
  it('asks both of the shipment page’s lookups for the whole probill, through the supplied transport', async () => {
    const fetcher = shipment('in-transit');
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new DaylightTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 6234-5678 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([url]) => String(url)).sort()).toEqual([
      `${DAYLIGHT_API}/history/public?probill=${IN_TRANSIT}`, `${DAYLIGHT_API}/public?probill=${IN_TRANSIT}`]);
    expect(daylightLookupUrls('6234 5678')).toEqual({ details: `${DAYLIGHT_API}/public?probill=${IN_TRANSIT}`,
      history: `${DAYLIGHT_API}/history/public?probill=${IN_TRANSIT}` });
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
        headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': 'SyntheticHost/1.0' } });
      expect(init!.body).toBeUndefined();
    }
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'daylight-transport', step: 'direct', outcome: 'ok' }));
  });

  it('reads a delivered history as wall clocks in the reply’s order, at towns, without the parties or references', () => {
    const result = parseDaylight(details('delivered'), history('delivered'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-03-12T10:41:00', expected_delivery: null,
    });
    expect(result).not.toHaveProperty('summary_only');
    expect(result).not.toHaveProperty('delivered_at');
    expect(events(result)).toEqual([
      ['2026-03-12T10:41:00', 'Delivered', 'delivered', 'EXAMPLEVILLE, NJ'],
      ['2026-03-12T10:12:44', 'Arrived At Consignee', 'out_for_delivery', 'EXAMPLEVILLE, NJ'],
      ['2026-03-12T07:02:18', 'Out For Delivery', 'out_for_delivery', 'SAMPLE CITY'],
      // The appointment row comes out of clock order, as the page lists it.
      ['2026-03-12T08:15:03', 'Appointment Made', null, 'EXAMPLEVILLE, NJ'],
      ['2026-03-11T22:40:00', 'Arrived At Destination', 'in_transit', 'SAMPLE CITY'],
      // The repeated row is kept once.
      ['2026-03-10T05:20:00', 'Enroute To Destination', 'in_transit', 'SAMPLE PORT'],
      ['2026-03-09T18:05:31', 'Docked At Origin', 'accepted', 'SAMPLE PORT'],
      ['2026-03-09T16:47:12', 'Appointment Required', null, 'EXAMPLEVILLE, NJ'],
      ['2026-03-09T14:31:09', 'Picked Up', 'accepted', 'SAMPLETON, CA'],
      ['2026-03-09T14:02:55', 'Arrived At Shipper', 'registered', 'SAMPLETON, CA'],
      ['2026-03-09T09:12:40', 'Freight Bill Entered', 'registered', 'SAMPLETON, CA'],
      ['2026-03-09T08:58:21', 'Pickup Requested', 'registered', 'SAMPLETON, CA'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source !== 'none')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE SUPPLY|EXAMPLE OUTFITTERS|JANE|JOHN|EXAMPLE AVE|SAMPLE RD|90000|07000|555 010|example\.com|BOL-SAMPLE|PO-SAMPLE|900001|SAMPLE CRATES|CALL|EXA-DYLT|DYLT/);
  });

  it('reads an in-transit history, its newest staged row and the delivery window’s day', () => {
    const result = parseDaylight(details('in-transit'), history('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      // The appointment row is the newest and moves nothing.
      last_status_text: 'Appointment Required', last_update: null, last_update_local: '2026-10-17T06:09:28',
      expected_delivery: '2026-10-21',
    });
    expect(events(result)).toEqual([
      ['2026-10-17T06:09:28', 'Appointment Required', null, 'SAMPLEBURG, OH'],
      ['2026-10-16T21:01:00', 'Enroute To Destination', 'in_transit', 'SAMPLE VALLEY, CA'],
      ['2026-10-16T09:20:00', 'Enroute To Destination', 'in_transit', 'SAMPLE VALLEY'],
      ['2026-10-15T18:52:33', 'Docked At Origin', 'accepted', 'SAMPLE VALLEY'],
      ['2026-10-15T13:42:00', 'Picked Up', 'accepted', 'SAMPLE VALLEY, CA'],
      ['2026-10-15T13:30:46', 'Arrived At Shipper', 'registered', 'SAMPLE VALLEY, CA'],
      ['2026-10-15T06:06:29', 'Freight Bill Entered', 'registered', 'SAMPLEBURG'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/PAT EXAMPLE|EXAMPLE PARTS|ALEX|EXAMPLE LN|SAMPLE BLVD|43000|91000|SBG|SVL|PRTR|Residential/);
  });

  it('settles a delivery the history does not record from the details, dated by their delivery time', () => {
    const rows = (all: Row[]) => all.splice(0, 3);
    const result = parseDaylight(details('delivered'), history('delivered', rows), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      last_update_local: '2026-03-12T10:41:00', expected_delivery: null });
    expect(events(result).slice(0, 2)).toEqual([
      ['2026-03-12T10:41:00', 'Delivered', 'delivered', null],
      ['2026-03-12T08:15:03', 'Appointment Made', null, 'EXAMPLEVILLE, NJ'],
    ]);
    // A window rather than an instant gives the day.
    const window = parseDaylight(details('delivered', (item) => { item.delivery.endDate = '2026-03-12T17:00:00'; }), history('delivered', rows), DELIVERED);
    expect(window.events![0]).toMatchObject({ local_time: '2026-03-12', description: 'Delivered' });
    // Without a delivery time the status still settles it, without a clock.
    const unclocked = parseDaylight(details('delivered', (item) => { item.delivery = null as never; }), history('delivered', rows), DELIVERED);
    expect(unclocked).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered' });
    expect(unclocked).not.toHaveProperty('last_update_local');
    expect(unclocked.events![0]).toMatchObject({ description: 'Appointment Made' });
  });

  it('reads details without a history as a summary from their status', () => {
    const empty = (rows: Row[]) => { rows.length = 0; };
    const transit = parseDaylight(details('in-transit'), history('in-transit', empty), IN_TRANSIT);
    expect(transit).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'In Transit', last_update: null, expected_delivery: '2026-10-21', summary_only: true, events: [] });
    expect(parseDaylight(details('in-transit', (item) => { item.status = 'Requested'; }), history('in-transit', empty), IN_TRANSIT))
      .toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'Requested' });
    expect(parseDaylight(details('delivered'), history('delivered', empty), DELIVERED)).toMatchObject({ status: 'delivered',
      last_update_local: '2026-03-12T10:41:00', summary_only: true, events: [{ description: 'Delivered', stage: 'delivered' }] });
    // A status the map does not know goes to the shared rules; a cancellation outranks the rows.
    expect(parseDaylight(details('in-transit', (item) => { item.status = 'Cancelled'; }), history('in-transit'), IN_TRANSIT))
      .toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Cancelled' });
    const other = parseDaylight(details('in-transit', (item) => { item.status = 'Completed'; }), history('in-transit', empty), IN_TRANSIT);
    expect(other).toMatchObject({ status: 'unknown', last_status_text: 'Completed' });
    expect(other).not.toHaveProperty('current_stage');
    expect(() => parseDaylight(details('in-transit', (item) => { item.status = null; }), history('in-transit', empty), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('places a row at a customer’s town and state, a terminal’s town, or what is left without digits', () => {
    const at = (location: unknown) => parseDaylight(details('in-transit'), history('in-transit', (rows) => {
      rows[1]!.location = location;
    }), IN_TRANSIT).events![1]!.location ?? null;
    expect(at('91000-1234 SAMPLE VALLEY CA')).toBe('SAMPLE VALLEY, CA');
    expect(at('svl-dylt-sample valley')).toBe('SAMPLE VALLEY');
    expect(at('SAMPLE HARBOR MX')).toBe('SAMPLE HARBOR MX');
    expect(at('12 SAMPLE ST')).toBe('SAMPLE ST');
    expect(at('91000')).toBeNull();
    expect(at(null)).toBeNull();
  });

  it('reads the unknown probill’s answer as not found, and a shipment only when it is the probill asked', () => {
    expect(() => parseDaylight(unknownDetails(), fixture('not-found.history'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(isDaylightUnknown(fixture('not-found.details'))).toBe(true);
    expect(isDaylightUnknown({ Success: false, Item: { Items: [{}] } })).toBe(false);
    expect(isDaylightUnknown('<html></html>')).toBe(false);
    // A history under a probill the details do not know contradicts them.
    expect(() => parseDaylight(unknownDetails(), history('in-transit'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const probill of [DELIVERED, null, '', ` ${IN_TRANSIT}0`]) {
      expect(() => parseDaylight(details('in-transit', (item) => { item.probill = probill; }), history('in-transit'), IN_TRANSIT), String(probill))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Daylight answered for another shipment' }));
    }
    expect(() => parseDaylight(details('in-transit'), history('in-transit'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (item: Details['item']) => { item.status = 7; },
      (item: Details['item']) => { item.probill = 62345678; },
      (item: Details['item']) => { item.delivery = '2026-10-21' as never; },
      (item: Details['item']) => { item.delivery.startDate = '10/21/2026 8:00 AM'; },
      (item: Details['item']) => { item.delivery.startDate = '2026-10-21T08:00:00-07:00'; },
    ]) {
      expect(() => parseDaylight(details('in-transit', change), history('in-transit'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const change of [
      (rows: Row[]) => { rows[0]!.discreteStatus = null; },
      (rows: Row[]) => { rows[0]!.discreteStatus = ['PICKED UP']; },
      (rows: Row[]) => { rows[0]!.updateDate = null; },
      (rows: Row[]) => { rows[0]!.updateDate = '2026-10-17T24:00:00'; },
      (rows: Row[]) => { rows[0]!.updateDate = '2026-02-30T06:00:00'; },
      (rows: Row[]) => { rows[0]!.updateDate = '2026-10-17T06:09:28Z'; },
      (rows: Row[]) => { rows[0]!.location = { city: 'SAMPLE' }; },
      (rows: Row[]) => { rows[0] = 'row' as never; },
      (rows: Row[]) => { rows.push(...Array.from({ length: 500 }, () => rows[1]!)); },
    ]) {
      expect(() => parseDaylight(details('in-transit'), history('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of [null, [], {}, { success: false, item: null }, { success: true, item: [] }]) {
      expect(() => parseDaylight({ status: 200, body }, history('in-transit'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of [null, [], {}, { success: false, item: [] }, { success: true, item: {} }]) {
      expect(() => parseDaylight(details('in-transit'), body, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseDaylight({ status: 404, body: {} }, fixture('not-found.history'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown probill, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (detailsReply: () => Response, historyReply: () => Response = () => reply(fixture('not-found.history'))) =>
      carrier(replies(detailsReply, historyReply)).track({ number: UNKNOWN });
    await expect(carrier(missing()).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    const html = { headers: { 'Content-Type': 'text/html' } };
    await expect(lookup(() => reply('<html><title>404</title></html>', { status: 404, ...html }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply({ Success: false, Message: 'Not Found' }, { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply(fixture('not-found.details'), { status: 404 }), () => reply('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 410 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 302, headers: { Location: 'https://mydaylight.dylt.com/login' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply(CHALLENGE, { status: 403, ...html }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(CHALLENGE, html))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(fixture('not-found.details'), { status: 404 }), () => reply(CHALLENGE, html))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply('<html><title>Daylight Transport - MyDaylight</title></html>', html))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => reply({ Message: 'An error has occurred.' }))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s from either lookup as %s during retrieval and recognition', async (status, kind) => {
      const failure = () => reply({ Success: false, Message: 'Unexpected Error' }, { status });
      for (const fetcher of [replies(failure, () => reply(fixture('in-transit.history'))), replies(() => reply(fixture('in-transit.details')), failure)]) {
        await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
        await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
        expect(fetcher).toHaveBeenCalledTimes(4);
      }
    });

  it('recognizes a known probill and the unknown answer, and asks nothing for a number Daylight does not issue', async () => {
    // A local clock dates the last activity without an instant.
    await expect(carrier(shipment('delivered')).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-12T10:41:00' });
    await expect(carrier(missing()).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(replies(() => reply(CHALLENGE, { headers: { 'Content-Type': 'text/html' } }), () => reply(fixture('not-found.history'))))
      .recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    // A reply for another shipment is no answer either way.
    await expect(carrier(shipment('delivered')).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind: 'indeterminate' });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('1234567')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects numbers Daylight does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '1234567', '123456789', 'ABCDEFGH', '1234567X', 'PRO12345678', `12345678${'9'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    for (const [raw, number] of [['01234567', '01234567'], ['6234 5678', IN_TRANSIT], ['6234-5678', IN_TRANSIT]]) {
      expect(normalizeDaylightNumber(raw!), raw).toBe(number);
    }
  });

  it('tries a read that hangs once more, and ends inside the budget', async () => {
    fakeBudgetClock();
    // The details and the history are read together.
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity },
      { afterMs: 50, reply: () => reply(fixture('in-transit.details')) }, { afterMs: 50, reply: () => reply(fixture('in-transit.history')) }]);
    const answered = carrier(recovered.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answered).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(recovered.fetcher.mock.calls.map(([url]) => String(url).includes('/history/'))).toEqual([false, true, false, true]);
    // Half of the budget, then the retry within the rest.
    expect(recovered.ended).toEqual([200, 200, 250, 250]);
    const started = performance.now();
    const hanging = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }, { afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(hanging.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(hanging.fetcher).toHaveBeenCalledTimes(4);
    expect(hanging.ended.map((at) => at - started)).toEqual([60, 60, 120, 120]);
  });

  it('stops the other lookup when one fails', async () => {
    let historySignal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (!String(url).includes('/history/')) return reply({ Success: false }, { status: 500 });
      historySignal = init!.signal!;
      return await new Promise<Response>((_resolve, reject) => historySignal!.addEventListener('abort', () => reject(historySignal!.reason), { once: true }));
    });
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(historySignal?.aborted).toBe(true);
  });

  it('routes a probill the caller names Daylight’s to the adapter', async () => {
    const fetcher = shipment('delivered');
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'daylight-transport' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'daylight-transport', source: 'daylight-transport', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === daylightLookupUrls(DELIVERED).details)).toBe(true);
  });
});

describe('Daylight Transport numbers', () => {
  it('leaves probills to the caller’s choice, and reads tracker links', () => {
    // Many carriers issue eight digits, so neither detection nor recognition offers Daylight.
    for (const number of [DELIVERED, IN_TRANSIT]) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('daylight-transport');
      expect(recognitionAskedCarriers(number), number).not.toContain('daylight-transport');
    }
    for (const link of [`https://mydaylight.dylt.com/external/shipment?probill=${DELIVERED}`,
      `https://www.dylt.com/shipment-tracing-result11.asp?SelectionValue=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'daylight-transport', source: 'link' });
    }
  });
});

describe('Daylight Transport status vocabulary', () => {
  it('records every wording the map knows with the stage it gives, and the appointments it leaves out', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string }[]) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(daylightStage(entry.wording), entry.wording).toEqual(entry.stage ? { stage: entry.stage, source: 'carrier_map' } : null);
    }
    expect(statusMap.gaps.map((gap) => gap.wording)).toEqual(['appointment required', 'appointment made']);
    expect(statusMapAnswer({ carrier: 'daylight-transport', providerCode: null, description: 'DOCKED AT ORIGIN' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'daylight-transport', providerCode: null, description: 'Sample Note' })).toEqual({ kind: 'unknown' });
    // Wording the map does not know falls to the shared rules, else stays without a stage.
    expect(daylightStage('Attempted Delivery')).toEqual({ stage: 'failed_attempt', source: 'wording:language' });
    expect(daylightStage('Sample Note')).toBeNull();
  });
});
