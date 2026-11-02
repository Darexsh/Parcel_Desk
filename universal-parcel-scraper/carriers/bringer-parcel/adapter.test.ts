import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, BRINGER_PARCEL_API, BringerParcelTracker } from './adapter.js';
import { isBringerParcelMissing, normalizeBringerParcelNumber, parseBringerParcel } from './parser.js';
import { bringerParcelStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'BPS000000000001';
const IN_TRANSIT = 'BPS0000000000002';
const UNKNOWN = 'BPS000000000000';

type Row = Record<string, unknown>;
type Parcel = Row & { events: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as unknown;
const parcels = (name: string) => fixture(name) as Parcel[];
const changed = (name: string, change: (parcel: Parcel, reply: Parcel[]) => void) => {
  const reply = parcels(name);
  change(reply[0]!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Bringer Parcel Xpress HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number in capitals once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new BringerParcelTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' bps 0000-0000-00002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${BRINGER_PARCEL_API}${IN_TRANSIT}`);
    expect(String(url)).toBe('https://bps.bringer.io/parcels/track-public/BPS0000000000002');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'bringer-parcel', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history newest first as UTC instants, staged by code or parcel status', () => {
    const result = parseBringerParcel(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-05-20T17:42:10Z', delivered_at: '2026-05-20T17:42:10Z', expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage ?? null, event.description, event.location ?? null])).toEqual([
      ['2026-05-20T17:42:10Z', 'delivered', 'delivered', 'Delivered', 'Sample City'],
      ['2026-05-18T11:05:00Z', 'BPS-0800', 'in_transit', 'Handed to the delivery partner', 'Sample City'],
      ['2026-05-12T09:30:00Z', 'BPS-0700', 'customs', 'Arrived at destination customs', null],
      // The repeated flight scan is kept once.
      ['2026-05-08T03:20:00Z', 'BPS-1820', 'in_transit', 'Departed on flight', 'Sample Airport'],
      ['2026-05-07T22:00:00Z', 'dispatch_closed', 'in_transit', 'Dispatch Closed', 'Sample Town'],
      ['2026-05-05T15:12:00Z', 'inspection_of_package_dimensions_and_weight', 'in_transit', 'Dimension & Weight Inspection', 'Sample Town'],
      // A place with a postal code is not kept.
      ['2026-05-05T15:10:00Z', 'BPS-0002', 'accepted', 'Received at the BPX warehouse', null],
      ['2026-05-02T13:00:04Z', 'BPS-0001', 'registered', 'Label Created', null],
      ['2026-05-02T13:00:00Z', 'label_generated', 'registered', 'Label Generated', null],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.local_time === undefined)).toBe(true);
  });

  it('keeps neither the other carrier’s number nor BPX’s record ids', () => {
    const text = JSON.stringify(parseBringerParcel(fixture('delivered'), DELIVERED));
    expect(text).not.toMatch(/0000000000000000000003|"id"|00000/);
    expect(parseBringerParcel(fixture('delivered'), DELIVERED)).not.toHaveProperty('delivery_tracking_number');
  });

  it('reads a parcel at customs from its newest scan', () => {
    const result = parseBringerParcel(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map',
      last_status_text: 'Arrived at destination customs', last_update: '2026-06-09T14:45:00Z' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => event.stage)).toEqual(['customs', 'in_transit', 'in_transit', 'accepted', 'registered']);
  });

  it('takes the parcel’s own word for a delivery, a return or an undeliverable parcel, and an outcome code’s', () => {
    const delivered = parseBringerParcel(changed('in-transit', (parcel) => { parcel.status = 'delivered'; }), IN_TRANSIT);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map' });
    expect(delivered).not.toHaveProperty('delivered_at');
    expect(parseBringerParcel(changed('in-transit', (parcel) => { parcel.status = 'returned'; }), IN_TRANSIT))
      .toMatchObject({ status: 'exception', current_stage: 'returned' });
    expect(parseBringerParcel(changed('in-transit', (parcel) => { parcel.status = 'undeliverable'; }), IN_TRANSIT))
      .toMatchObject({ status: 'exception', current_stage: 'exception' });
    const lost = parseBringerParcel(changed('in-transit', (parcel) => {
      parcel.events.unshift({ id: '26', status: 'in_transit', location: '', bpxEventCode: 'BPS-1830', bpxEventDescription: 'Lost',
        createdAt: '2026-06-20T10:00:00.000Z' });
    }), IN_TRANSIT);
    expect(lost).toMatchObject({ current_stage: 'exception', last_status_text: 'Lost' });
  });

  it('lists scans newest first whatever the reply’s order, keeping the reply’s order within one instant', () => {
    const result = parseBringerParcel(changed('delivered', (parcel) => { parcel.events.reverse(); }), DELIVERED);
    expect(result).toMatchObject({ last_update: '2026-05-20T17:42:10Z', current_stage: 'delivered' });
    expect(result.events!.at(-1)).toMatchObject({ provider_code: 'label_generated' });
    const offset = parseBringerParcel(changed('in-transit', (parcel) => { parcel.events[0]!.createdAt = '2026-06-09T09:45:00-05:00'; }), IN_TRANSIT);
    expect(offset.events![0]).toMatchObject({ time: '2026-06-09T09:45:00-05:00', provider_code: 'BPS-0700' });
  });

  it('keeps scans of one instant in the reply’s order, whichever way it lists them', () => {
    const scan = (bpxEventCode: string, bpxEventDescription: string) => ({ id: '27', status: 'in_transit', location: '', bpxEventCode,
      bpxEventDescription, createdAt: '2026-06-20T10:00:00.000Z' });
    for (const reversed of [false, true]) {
      const result = parseBringerParcel(changed('in-transit', (parcel) => {
        parcel.events.unshift(scan('BPS-0800', 'Handed to the delivery partner'), scan('BPS-0710', 'Released from customs'));
        if (reversed) parcel.events.reverse();
      }), IN_TRANSIT);
      expect(result.events!.slice(0, 2).map((event) => event.description)).toEqual(['Handed to the delivery partner', 'Released from customs']);
    }
  });

  it('shows a status without a label as it comes, and leaves an error creating the label without a stage', () => {
    const result = parseBringerParcel(changed('in-transit', (parcel) => {
      parcel.events.unshift({ id: '27', status: 'synthetic_state', location: '', bpxEventCode: null, bpxEventDescription: null,
        createdAt: '2026-06-21T10:00:00.000Z' });
      parcel.events.unshift({ id: '28', status: 'processing_error', location: '', bpxEventCode: null, bpxEventDescription: null,
        createdAt: '2026-06-22T10:00:00.000Z' });
    }), IN_TRANSIT);
    expect(result.events!.slice(0, 2).map((event) => [event.provider_code, event.description, event.stage ?? null])).toEqual([
      ['processing_error', 'Processing Error', null],
      ['synthetic_state', 'synthetic state', null],
    ]);
    expect(result).toMatchObject({ current_stage: 'customs', last_status_text: 'Processing Error' });
  });

  it('reads an unknown number as not found, and a parcel without scans as no history', async () => {
    expect(isBringerParcelMissing(fixture('not-found'), UNKNOWN)).toBe(true);
    expect(isBringerParcelMissing(fixture('not-found'), DELIVERED)).toBe(false);
    expect(isBringerParcelMissing({ message: 'Cannot GET /parcels/track-public/x', error: 'Not Found', statusCode: 404 }, UNKNOWN)).toBe(false);
    expect(() => parseBringerParcel([], UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseBringerParcel(changed('delivered', (parcel) => { parcel.events = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseBringerParcel(changed('delivered', (parcel) => { delete (parcel as Row).events; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a parcel only under its own BPX number', () => {
    expect(() => parseBringerParcel(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'BPX answered for another shipment' }));
    // The tracker also finds a parcel by another carrier's number it carries: only the parcel the number is BPX's own counts.
    const both = changed('in-transit', (_parcel, list) => {
      list.unshift({ ...parcels('delivered')[0]!, trackingCode: 'BPS000000000005', externalTrackingNumber: IN_TRANSIT });
    });
    expect(parseBringerParcel(both, IN_TRANSIT)).toMatchObject({ current_stage: 'customs' });
    const twice = changed('in-transit', (parcel, list) => { list.push({ ...parcel, id: '29' }); });
    expect(() => parseBringerParcel(twice, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseBringerParcel(changed('in-transit', (parcel) => { parcel.trackingCode = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events)
      .toHaveLength(5);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_parcel: Parcel, list: Parcel[]) => { list[0] = 'parcel' as never; },
      (parcel: Parcel) => { delete parcel.trackingCode; },
      (parcel: Parcel) => { parcel.status = 7; },
      (parcel: Parcel) => { parcel.status = 'Delivered!'; },
      (parcel: Parcel) => { parcel.events = 'events' as never; },
      (parcel: Parcel) => { parcel.events = Array.from({ length: 501 }, () => parcel.events[0]!); },
      (parcel: Parcel) => { parcel.events[0] = 'scan' as never; },
      (parcel: Parcel) => { parcel.events[0]!.createdAt = '2026-06-09 14:45:00'; },
      (parcel: Parcel) => { parcel.events[0]!.createdAt = '2026-06-09T14:45:00'; },
      (parcel: Parcel) => { parcel.events[0]!.createdAt = '2026-02-30T14:45:00.000Z'; },
      (parcel: Parcel) => { delete parcel.events[0]!.createdAt; },
      (parcel: Parcel) => { delete parcel.events[0]!.status; },
      (parcel: Parcel) => { parcel.events[0]!.bpxEventDescription = ['Customs']; },
      (parcel: Parcel) => { parcel.events[0]!.bpxEventCode = 'BPS 0700 <b>'; },
      (parcel: Parcel) => { parcel.events[0]!.location = 7; },
    ]) {
      expect(() => parseBringerParcel(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseBringerParcel({ parcels: [] }, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBringerParcel(Array.from({ length: 21 }, () => parcels('in-transit')[0]), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'not_found' });
    // A 404 that does not name the number asked, a 410 or a redirect is a moved route.
    await expect(lookup({ message: 'Cannot GET /parcels/track-public/BPS000000000000', error: 'Not Found', statusCode: 404 }, { status: 404 }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>404 Not Found</title></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(fixture('not-found'), { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://www.bringerparcel.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><script src="https://sample.awswaf.com/challenge.js"></script></html>', { status: 404 }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>BPX - Bringer Parcel Xpress</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ message: 'Parcel with tracking code BPS000000000000 not found' })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number with its last scan, the unknown-number answer, and asks nothing for a number BPX does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('in-transit')))
      .mockResolvedValueOnce(reply(fixture('not-found'), { status: 404 }));
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: '2026-06-09T14:45:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('null')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers BPX does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['BPS00000000000', 'BPS00000000000000', 'BPX000000000000', 'BPS', 'null', '0000000000000000000003',
      'BPS00000000000%', `BPS${'0'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeBringerParcelNumber('bps 0000 0000 0001')).toBe(DELIVERED);
  });

  it('tries a read that hangs once more, and ends inside the budget', async () => {
    fakeBudgetClock();
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: 50, reply: () => reply(fixture('in-transit')) }]);
    const answered = carrier(recovered.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answered).resolves.toMatchObject({ current_stage: 'customs' });
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

  it('routes a number filed under BPX, or recognized as one of its numbers, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('in-transit')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: IN_TRANSIT, carrier: 'bringer-parcel' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'bringer-parcel', source: 'bringer-parcel', result: { current_stage: 'customs' } });
    // Recognition settles on a parcel with recent scans.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-06-10T00:00:00Z'));
      await expect(tracker.track({ number: IN_TRANSIT }, { budgetMs: 3000 }))
        .resolves.toMatchObject({ carrier: 'bringer-parcel', source: 'bringer-parcel' });
    } finally {
      vi.useRealTimers();
    }
    expect(fetcher.mock.calls.every(([url]) => String(url) === `${BRINGER_PARCEL_API}${IN_TRANSIT}`)).toBe(true);
  });
});

describe('Bringer Parcel Xpress numbers', () => {
  it('offers BPX for the numbers the adapter takes without naming it', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['bringer-parcel'] });
    }
  });
});

describe('Bringer Parcel Xpress status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBeUndefined();
        expect(bringerParcelStage('', entry.code, entry.wording), entry.code).toBeNull();
        expect(statusMapAnswer({ carrier: 'bringer-parcel', providerCode: entry.code, description: entry.wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      const coded = entry.code.startsWith('BPS-');
      expect(bringerParcelStage(coded ? entry.code : '', coded ? 'in_transit' : entry.code, entry.wording)?.stage, entry.code).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'bringer-parcel', providerCode: 'BPS-0001', description: 'Label Created' }))
      .toEqual({ kind: 'mapped', stage: 'registered' });
    // A code outside the map takes its stage from the parcel status beside it, which the code alone does not carry.
    expect(statusMapAnswer({ carrier: 'bringer-parcel', providerCode: 'BPS-9999', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(bringerParcelStage('BPS-9999', 'customs', 'Synthetic note')).toEqual({ stage: 'customs', source: 'carrier_map' });
    // A status the map does not know falls to the shared wording rules.
    expect(bringerParcelStage('', 'synthetic_state', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(bringerParcelStage('', 'synthetic_state', 'Synthetic note')).toBeNull();
    expect(bringerParcelStage('', 'processing_error', 'Delivered')).toBeNull();
    expect(bringerParcelStage('bps-1601', 'in_transit', 'Delivered')).toEqual({ stage: 'delivered', source: 'carrier_map' });
  });
});
