import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PARCELPOINT_API, ParcelpointTracker, parcelpointTrackUrl } from './adapter.js';
import { normalizeParcelpointNumber, parseParcelpoint } from './parser.js';
import { parcelpointMappedStage, parcelpointStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const CONSIGNMENT = 'AB0C000000';
const BOOKING = '12345678901234567890';
const READY_CONSIGNMENT = '1234567890123';
const REFERENCE = 'REF0000000';
const UNKNOWN = 'ZZ0000000000';

type Row = Record<string, unknown>;
type Reply = { trackingId: string; currentStatus: string; statusDesc: string; details: Row | unknown[]; events: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (body: Reply) => void) => {
  const body = fixture(name);
  change(body);
  return body;
};
// The proxy echoes the number asked; a fixture asked under another of its numbers echoes that one.
const asked = (name: string, number: string) => changed(name, (body) => { body.trackingId = number; });
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('ParcelPoint HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number in capitals once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('collected')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ParcelpointTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' ab0c 000-000 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${PARCELPOINT_API}?trackingId=${CONSIGNMENT}`);
    expect(parcelpointTrackUrl(CONSIGNMENT)).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'parcelpoint', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a collected parcel’s history as UTC instants, with the point it waited at', () => {
    const result = parseParcelpoint(fixture('collected'), CONSIGNMENT);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Your parcel has been collected from the PARCELPOINT location.',
      last_update: '2026-07-03T02:01:00Z', delivered_at: '2026-07-03T02:01:00Z',
      pickup_point: 'Example Newsagency Sampleton',
      events: [
        { time: '2026-07-03T02:01:00Z', location: 'Example Newsagency Sampleton', provider_code: 'CHECKED_OUT',
          description: 'Your parcel has been collected from the PARCELPOINT location.', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2026-07-01T07:10:00Z', location: 'Example Newsagency Sampleton', provider_code: 'CHECKED_IN',
          description: 'Example Newsagency Sampleton has confirmed delivery of your parcel from Example Couriers, it\'s ready for collection.',
          stage: 'ready_for_pickup', stage_source: 'carrier_map' },
        { time: '2026-06-30T01:09:00Z', location: 'Example Newsagency Sampleton', provider_code: 'BOOKED',
          description: 'Parcel information has been received by PARCELPOINT.', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    // The same parcel opens by its booking code.
    expect(parseParcelpoint(asked('collected', '00000000000000000000'), '00000000000000000000')).toMatchObject({ current_stage: 'delivered' });
  });

  it('reads a parcel waiting at a point, sorted newest first without the repeated row', () => {
    const result = parseParcelpoint(fixture('ready'), BOOKING);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map',
      last_update: '2026-12-03T05:30:00Z', pickup_point: 'Demo Pharmacy Exampleville' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage])).toEqual([
      ['2026-12-03T05:30:00Z', 'CHECKED_IN', 'ready_for_pickup'],
      ['2026-12-01T23:45:00Z', 'BOOKED', 'registered'],
    ]);
    // Its consignment id and its reference open it too.
    for (const number of [READY_CONSIGNMENT, REFERENCE, REFERENCE.toLowerCase()]) {
      expect(parseParcelpoint(asked('ready', number.toUpperCase()), number), number).toMatchObject({ current_stage: 'ready_for_pickup' });
    }
  });

  it('keeps scans of one instant in the carrier’s order', () => {
    const result = parseParcelpoint(changed('collected', (body) => {
      body.events.reverse();
      body.events[1]!.date = body.events[0]!.date;
    }), CONSIGNMENT);
    expect(result.events!.map((event) => event.provider_code)).toEqual(['CHECKED_OUT', 'CHECKED_IN', 'BOOKED']);
  });

  it('stages by the summary, else by the newest staged event, and keeps the point only after a check-in', () => {
    const ready = (change: (body: Reply) => void) => parseParcelpoint(changed('ready', change), BOOKING);
    // An unknown code with wording the shared rules read.
    const sent = ready((body) => {
      body.currentStatus = 'SYNTHETIC_STEP';
      body.statusDesc = 'Your parcel has been returned to the sender.';
      body.events.unshift({ status: 'SYNTHETIC_STEP', description: body.statusDesc, date: '2026-12-10 01:00', location: 'Demo Pharmacy Exampleville' });
    });
    expect(sent).toMatchObject({ current_stage: 'returned', current_stage_source: expect.stringMatching(/^wording:/) });
    expect(sent).not.toHaveProperty('pickup_point');
    expect(sent.events![0]).toMatchObject({ provider_code: 'SYNTHETIC_STEP', stage: 'returned' });
    // Wording nothing reads leaves the newest staged event to stage the parcel.
    const unread = ready((body) => {
      body.currentStatus = '';
      body.statusDesc = '';
      body.events.unshift({ status: 'SYNTHETIC_STEP', description: '', date: '2026-12-10 01:00' });
    });
    expect(unread).toMatchObject({ current_stage: 'ready_for_pickup', last_status_text: 'Synthetic Step', pickup_point: 'Demo Pharmacy Exampleville' });
    expect(unread.events![0]).toEqual({ time: '2026-12-10T01:00:00Z', provider_code: 'SYNTHETIC_STEP', description: 'Synthetic Step' });
    // A row without a date is a step still to come, which the page's proxy leaves out.
    expect(ready((body) => { body.events.push({ status: 'CHECKED_OUT', description: 'Synthetic', date: '' }); }).events).toHaveLength(2);
    // A collection with no check-in before it names no point.
    const collected = parseParcelpoint(changed('collected', (body) => { body.events.splice(1, 1); }), CONSIGNMENT);
    expect(collected).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-07-03T02:01:00Z' });
    expect(collected).not.toHaveProperty('pickup_point');
  });

  it('marks a history cut to its newest events', () => {
    const result = parseParcelpoint(changed('ready', (body) => {
      body.events = Array.from({ length: 101 }, (_, index) => ({ ...body.events[0]!,
        date: `2026-11-${String(1 + Math.floor(index / 24)).padStart(2, '0')} ${String(index % 24).padStart(2, '0')}:00` }));
    }), BOOKING);
    expect(result.events).toHaveLength(100);
    expect(result.history_truncated).toBe(true);
  });

  it('reads an unknown number as not found, a parcel without events as its summary or no history', () => {
    expect(() => parseParcelpoint(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(parseParcelpoint(changed('ready', (body) => { body.events = []; }), BOOKING)).toEqual({
      status: 'out_for_delivery', current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map',
      last_status_text: 'Demo Pharmacy Exampleville has confirmed delivery of your parcel from Sample Freight, it\'s ready for collection.',
      provider_code: 'CHECKED_IN', last_update: null, summary_only: true, events: [],
    });
    expect(() => parseParcelpoint(changed('ready', (body) => { body.events = []; body.currentStatus = ''; body.statusDesc = ''; }), BOOKING))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('counts a parcel only when the reply names it by the whole number asked', () => {
    // The echo of another number, and a parcel none of whose numbers is the one asked.
    expect(() => parseParcelpoint(fixture('collected'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'ParcelPoint answered for another number' }));
    expect(() => parseParcelpoint(asked('collected', UNKNOWN), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'ParcelPoint answered for another parcel' }));
    expect(() => parseParcelpoint(asked('ready', `${BOOKING}0`), `${BOOKING}0`)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseParcelpoint(asked('ready', BOOKING.slice(0, 19)), BOOKING.slice(0, 19))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // Events under no numbers cannot be bound to the parcel asked.
    expect(() => parseParcelpoint(changed('collected', (body) => { body.details = []; }), CONSIGNMENT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseParcelpoint({ ...fixture('not-found'), currentStatus: 'BOOKED' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete (body as Partial<Reply>).trackingId; },
      (body: Reply) => { body.trackingId = 5 as never; },
      (body: Reply) => { body.currentStatus = 5 as never; },
      (body: Reply) => { body.details = 'details' as never; },
      (body: Reply) => { body.details = [CONSIGNMENT]; },
      (body: Reply) => { (body.details as Row).consignmentId = 12345; },
      (body: Reply) => { body.events = 'events' as never; },
      (body: Reply) => { body.events = Array.from({ length: 501 }, () => body.events[0]!); },
      (body: Reply) => { body.events[0] = 'row' as never; },
      (body: Reply) => { body.events[0]!.status = ['CHECKED_OUT']; },
      (body: Reply) => { body.events[0]!.status = ''; body.events[0]!.description = ''; },
      (body: Reply) => { body.events[0]!.location = { name: 'Example' }; },
      (body: Reply) => { body.events[0]!.date = 1_783_044_060; },
      (body: Reply) => { body.events[0]!.date = '2026-07-03T02:01:00Z'; },
      (body: Reply) => { body.events[0]!.date = '2026-07-03 02:01:00'; },
      (body: Reply) => { body.events[0]!.date = '2026-07-03 24:00'; },
      (body: Reply) => { body.events[0]!.date = '2026-02-30 02:01'; },
    ]) {
      expect(() => parseParcelpoint(changed('collected', change), CONSIGNMENT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const payload of ['reply', [], null]) {
      expect(() => parseParcelpoint(payload, CONSIGNMENT), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a browser check, a quota and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page reads a 404 from its proxy as not found; WordPress's missing route is a moved one.
    await expect(lookup({ code: 'not_found', message: 'Synthetic', data: { status: 404 } }, { status: 404 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup({ code: 'rest_no_route', message: 'No route was found matching the URL and request method.', data: { status: 404 } },
      { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Page not found</title></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://parcelpoint.com.au/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(CLOUDFLARE, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CLOUDFLARE, { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup({ code: 'rest_forbidden', message: 'Synthetic' }, { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('', { status: 429, headers: { 'Retry-After': '120' } })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 });
    await expect(lookup('', { status: 429 })).rejects.toMatchObject({ kind: 'rate_limited' });
    // The proxy's answer when the tracking service behind it does not reply.
    await expect(lookup({ code: 'upstream_error', message: 'Could not reach tracking service.', data: { status: 502 } }, { status: 502 }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('<html><title>PARCELPOINT</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ trackingId: UNKNOWN })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('rejects numbers ParcelPoint does not track and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['12345', 'ABCDEFGH', '1234567%', '0'.repeat(41), '0'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: CONSIGNMENT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeParcelpointNumber('6000-0000 F00m')).toBe('60000000F00M');
  });

  it('tries a read that hangs once more, and ends inside the budget', async () => {
    fakeBudgetClock();
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: 50, reply: () => reply(fixture('collected')) }]);
    const answered = carrier(recovered.fetcher).track({ number: CONSIGNMENT }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answered).resolves.toMatchObject({ current_stage: 'delivered' });
    // Half of the budget, then the retry within the rest.
    expect(recovered.ended).toEqual([200, 250]);
    const started = performance.now();
    const hanging = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(hanging.fetcher).track({ number: CONSIGNMENT }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(hanging.fetcher).toHaveBeenCalledTimes(2);
    expect(hanging.ended.map((at) => at - started)).toEqual([60, 120]);
  });

  it('routes a number filed under ParcelPoint to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => reply(String(input) === parcelpointTrackUrl(CONSIGNMENT) ? fixture('collected') : fixture('not-found')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: CONSIGNMENT, carrier: 'parcelpoint' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'parcelpoint', source: 'parcelpoint',
        result: { current_stage: 'delivered', pickup_point: 'Example Newsagency Sampleton' } });
  });
});

describe('ParcelPoint numbers', () => {
  it('claims none: the tracker’s booking codes and carrier numbers have no layout of their own', () => {
    for (const number of [CONSIGNMENT, BOOKING, READY_CONSIGNMENT, '60000000F00M']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('parcelpoint');
    }
  });
});

describe('ParcelPoint status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string }[]) {
      expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording)), entry.code).toBe(entry.stage);
      expect(parcelpointStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'parcelpoint', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
  });

  it('maps a check-in or a check-out only with the wording seen beside it', () => {
    expect(parcelpointMappedStage('checked_in', 'Synthetic Point has confirmed delivery of your parcel from Synthetic Couriers, it\'s ready for collection.'))
      .toBe('ready_for_pickup');
    expect(parcelpointMappedStage('CHECKED_IN', 'Your parcel has been dropped off at Synthetic Point.')).toBeUndefined();
    expect(parcelpointMappedStage('CHECKED_OUT', 'Your parcel has been collected by Synthetic Couriers.')).toBeUndefined();
    expect(parcelpointMappedStage('BOOKED', 'Synthetic wording')).toBe('registered');
    expect(statusMap.stage(null, 'parcel information has been received by parcelpoint.')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'parcelpoint', providerCode: 'SYNTHETIC', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(parcelpointStage('SYNTHETIC', 'Synthetic note')).toBeNull();
  });
});
