import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, XLCOURIER_API, XlcourierTracker, xlcourierLookupUrl } from './adapter.js';
import { normalizeXlcourierNumber, parseXlcourier, xlcourierLocation, xlcourierWording } from './parser.js';
import { statusMap, xlcourierStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'XLC000000000001';
const IN_TRANSIT = 'XLC00000000002';
const UNKNOWN = 'XLC0000000000';

type Row = Record<string, unknown>;
type Shipment = Row & { events: Row[] };
type Reply = Row & { data: Shipment };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (data: Shipment, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('XLCourier HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number in capitals once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new XlcourierTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' xlc 000-0000-0002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${XLCOURIER_API}${IN_TRANSIT}`);
    expect(xlcourierLookupUrl('zx00000000')).toBe('https://de.xlcourier.com/custom-api/api/v3/xlc/getLogisticsTrack/ZX00000000');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'xlcourier', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps a delivered history’s wall clocks newest first, with the depot each arrival names', () => {
    const result = parseXlcourier(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Your parcel has been delivered successfully. Thank you!', last_update: null,
      last_update_local: '2026-03-09T13:26:45', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['2026-03-09T13:26:45', '1600', 'delivered', null],
      ['2026-03-09T07:58:02', '1000', 'out_for_delivery', null],
      ['2026-03-06T14:47:29', '600', 'in_transit', 'National Hub'],
      ['2026-03-05T16:02:33', '1100', 'failed_attempt', null],
      ['2026-03-05T08:20:16', '1000', 'out_for_delivery', null],
      // The repeated hub scan is kept once.
      ['2026-03-04T09:05:51', '600', 'in_transit', 'National Hub'],
      ['2026-03-02T13:41:08', '600', 'in_transit', 'SMP- DEP'],
      ['2026-03-02T05:12:40', '100', 'registered', null],
    ]);
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
    // The failed attempt keeps its reason without the phone number.
    expect(result.events![3]).toMatchObject({ description: 'Unfortunately, we were unable to deliver your parcel. Reason: No answer at the address, call to rearrange' });
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Street|Road)|Sampleton|SA1 1AA|07000/);
  });

  it('reads a parcel that left the hub as in transit, the later of two scans on one clock first', () => {
    const result = parseXlcourier(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Parcel has left the National hub', last_update_local: '2026-05-13T06:12:00' });
    expect(result.events!.map((event) => [event.provider_code, event.stage])).toEqual([
      ['800', 'in_transit'], ['700', 'in_transit'], ['600', 'in_transit'], ['500', 'accepted'], ['100', 'registered'],
    ]);
  });

  it('stages a type the list does not name by its wording, or leaves it without a stage', () => {
    const worded = parseXlcourier(changed('in-transit', (data) => {
      data.events.push({ reason: null, tracking_event_status_id: 1650, title: 'Delivered', updated_at_localized: '2026-05-14 12:00:00', description: '' });
    }), IN_TRANSIT);
    expect(worded).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered' });
    expect(worded.current_stage_source).toMatch(/^wording:/);
    const silent = parseXlcourier(changed('in-transit', (data) => {
      data.events.push({ reason: null, tracking_event_status_id: 1700, title: 'Synthetic note', updated_at_localized: '2026-05-14 12:00:00', description: null });
    }), IN_TRANSIT);
    expect(silent).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Synthetic note' });
    expect(silent.events![0]).not.toHaveProperty('stage');
  });

  it('words a scan from its line, else its title, with the reason the page adds', () => {
    expect(xlcourierWording('Delivery Failed', 'Unfortunately, we were unable to deliver your parcel.', 'Recipient not available'))
      .toBe('Unfortunately, we were unable to deliver your parcel. Reason: Recipient not available');
    expect(xlcourierWording('Pickup Failed', '', 'Business closed sample@example.com')).toBe('Pickup Failed. Reason: Business closed');
    expect(xlcourierWording('', '', 'Address not found')).toBe('Reason: Address not found');
    expect(xlcourierWording('Out for Delivery', 'Your parcel is currently out for delivery.', '')).toBe('Your parcel is currently out for delivery.');
    expect(xlcourierLocation('Your parcel has arrived safely at SMP- DEP.')).toBe('SMP- DEP');
    expect(xlcourierLocation('Your parcel has arrived at our National hub')).toBe('National hub');
    expect(xlcourierLocation('Parcel has left the National hub')).toBe('');
  });

  it('reads the backend’s answer for an unknown number as not found, another failure as inconclusive and a record without scans as no history', () => {
    expect(() => parseXlcourier(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseXlcourier({ msg: 'internal error', data: null, code: '-1', success: false }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseXlcourier({ msg: 'parse tracking response failed', data: {}, code: '-1', success: false }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseXlcourier(changed('delivered', (data) => { data.events = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseXlcourier(changed('delivered', (data) => { delete (data as Row).events; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_data: Shipment, body: Reply) => { delete (body as Row).code; },
      (_data: Shipment, body: Reply) => { body.data = 'shipment' as never; },
      (_data: Shipment, body: Reply) => { body.data = null as never; },
      (data: Shipment) => { data.events = 'events' as never; },
      (data: Shipment) => { data.events = Array.from({ length: 501 }, () => data.events[0]!); },
      (data: Shipment) => { data.events[0] = 'scan' as never; },
      (data: Shipment) => { data.events[0]!.updated_at_localized = '13/05/2026 06:12'; },
      (data: Shipment) => { data.events[0]!.updated_at_localized = '2026-05-13T06:12:00+01:00'; },
      (data: Shipment) => { data.events[0]!.updated_at_localized = '2026-02-30 06:12:00'; },
      (data: Shipment) => { data.events[0]!.updated_at_localized = '2026-05-13 24:00:00'; },
      (data: Shipment) => { delete data.events[0]!.updated_at_localized; },
      (data: Shipment) => { data.events[0]!.description = ['Created']; },
      (data: Shipment) => { data.events[0]!.reason = 7; },
      (data: Shipment) => { data.events[0]!.title = ''; data.events[0]!.description = null; },
    ]) {
      expect(() => parseXlcourier(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page reads a missing parcel from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup({ status: 404, error: 'Not Found' }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://www.xlcourier.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>XLC WEBSITE</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number XLCourier does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-09T13:26:45' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('XLC000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers XLCourier does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['XLC000000000', 'XLC0000000000000', 'ZX0000000', 'ZX000000000', 'XLA00000000000', `XLC${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeXlcourierNumber('xlc 000-000-000-001')).toBe(DELIVERED);
    expect(normalizeXlcourierNumber('zx 0000 0000')).toBe('ZX00000000');
  });

  it('tries a read that does not reach XLCourier once more inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 3000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('routes a number filed under XLCourier, or detected as one of its numbers, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'xlcourier' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'xlcourier', source: 'xlcourier', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'xlcourier', source: 'xlcourier' });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${XLCOURIER_API}${DELIVERED}`)).toBe(true);
  });
});

describe('XLCourier numbers', () => {
  it('claims the XLC layout and leaves the short ZX one to a filed carrier', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'xlcourier', confidence: 'high' });
    }
    for (const number of ['ZX00000000', 'XLC000000000', 'XLC0000000000000']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('xlcourier');
    }
  });
});

describe('XLCourier status vocabulary', () => {
  it('records every event type with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string }[]) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(xlcourierStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'xlcourier', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'xlcourier', providerCode: '9999', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(xlcourierStage('9999', 'Synthetic note')).toBeNull();
  });
});
