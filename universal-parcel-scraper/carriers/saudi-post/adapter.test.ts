import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SAUDI_POST_API, SaudiPostTracker } from './adapter.js';
import { normalizeSaudiPostNumber, parseSaudiPost } from './parser.js';
import { saudiPostStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'CRDSAL0000000017';
const IN_TRANSIT = 'RR000000005BD';
const UNKNOWN = 'CRDSAL0000000025';

type Row = Record<string, unknown>;
type Shipment = Row & { TrackingInfoItemList: Row[] };

const raw = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(raw(`${name}.json`)) as Shipment[];
const changed = (name: string, change: (shipment: Shipment, reply: Shipment[]) => void) => {
  const reply = fixture(name);
  change(reply[0]!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Saudi Post HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number in capitals and in English, once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SaudiPostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' rr 000 000 005 bd ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SAUDI_POST_API}?language=en&shipmentCode=${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'saudi-post', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each scan’s wall clock and the office the page shows, and stages it by its step and wording', () => {
    const result = parseSaudiPost(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Your shipment is delivered, Thank you for choosing us', last_update: null,
      last_update_local: '2026-04-06T13:08:26', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage ?? null, event.location ?? null])).toEqual([
      // An office the reply names only by its code is no place.
      ['2026-04-06T13:08:26', '5', 'delivered', null],
      ['2026-04-06T09:55:13', '4', 'out_for_delivery', null],
      ['2026-04-05T15:20:41', '2', 'failed_attempt', 'SAMPLE TOWN'],
      ['2026-04-05T11:03:58', '4', 'failed_attempt', 'Dist. Center - SAMPLE TOWN'],
      ['2026-04-05T11:03:58', '4', 'failed_attempt', 'Dist. Center - SAMPLE TOWN'],
      ['2026-04-05T10:12:00', '4', 'out_for_delivery', 'Dist. Center - SAMPLE TOWN'],
      // The repeated scan is kept once. The office a parcel is on its way to is not where it is.
      ['2026-04-04T07:45:30', '2', 'in_transit', null],
      ['2026-04-04T07:31:09', '2', 'in_transit', 'Central post office - SAMPLE CITY'],
      ['2026-04-03T22:02:47', '2', 'in_transit', null],
      ['2026-04-03T21:40:12', '1', 'accepted', 'Sample office - SAMPLE CITY'],
      // The announcement's office is the sender's.
      ['2026-04-02T09:14:05', '12', 'registered', null],
    ]);
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
    expect(result.events!.map((event) => event.description)).toEqual(expect.arrayContaining([
      'Your shipment is on its way to Dist. Center - SAMPLE TOWN',
      'Your shipment has arrived Central post office - SAMPLE CITY',
      'Thank you for trusting us with your shipment Sample office - SAMPLE CITY',
    ]));
    expect(JSON.stringify(result)).not.toMatch(/Sample Store|Dear valued customer|consecutive days|SAUDI ARABIA|Latitude|10\.1/);
  });

  it('keeps a parcel from abroad in transit with its estimate, its customs steps and its origin post’s scan', () => {
    const result = parseSaudiPost(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Your shipment is on its way to Sample office - SAMPLE TOWN', last_update_local: '2026-05-18T07:05:10',
      expected_delivery: '2026-05-21' });
    expect(result.events!.map((event) => [event.provider_code, event.stage])).toEqual([
      ['2', 'in_transit'], ['11', 'exception'], ['2', 'in_transit'], ['2', 'in_transit'], ['2', 'in_transit'],
      ['7', 'customs'], ['7', 'customs'], ['2', 'in_transit'], ['2', 'in_transit'],
    ]);
    // A line that names the office it goes to keeps it once, and not as the parcel's place.
    expect(result.events![3]).toMatchObject({ description: 'Your shipment is on its way to Central post office - SAMPLE CITY' });
    expect(result.events![3]).not.toHaveProperty('location');
    // The origin post's scan keeps its own wall clock, which is not Saudi Arabia's, and the office it left.
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2026-05-10T10:31:00', location: 'SAMPLE PORT',
      description: 'Your shipment is on its way to destination' });
    expect(result).not.toHaveProperty('destination_country');
  });

  it('reads the partner’s, the pickup office’s and the return’s wording past their step', () => {
    expect(saudiPostStage('2', 'Your shipment is ready for pickup Sample office')).toEqual({ stage: 'ready_for_pickup', source: 'carrier_map' });
    expect(saudiPostStage('2', 'Shipment On Hold')).toEqual({ stage: 'exception', source: 'carrier_map' });
    expect(saudiPostStage('4', 'Arrived at final Destination for Delivery')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(saudiPostStage('4', 'With delivering courier')).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
    // A delivery or a return keeps its step whatever its wording.
    expect(saudiPostStage('5', 'Shipment Delivered')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(saudiPostStage('9', 'Failed delivery, returned to origin')).toEqual({ stage: 'returned', source: 'carrier_map' });
    // A step the map does not know falls to the shared wording rules.
    expect(saudiPostStage('13', 'Shipment Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(saudiPostStage('13', 'Synthetic note')).toBeNull();
    const returned = parseSaudiPost(changed('delivered', (shipment) => {
      shipment.TrackingInfoItemList.splice(-1, 1, { ...shipment.TrackingInfoItemList.at(-1)!, Status: 9,
        EventDescription: 'Your shipment  was returnd to origin Other - None' });
    }), DELIVERED);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', expected_delivery: null,
      last_status_text: 'Your shipment was returnd to origin Other - None' });
  });

  it('takes the step’s headline when a scan has no description, and leaves a scan nothing stages without a stage', () => {
    const result = parseSaudiPost(changed('in-transit', (shipment) => {
      Object.assign(shipment.TrackingInfoItemList.at(-1)!, { Status: 13, EventDescription: '', StatusMessage: 'Synthetic note' });
    }), IN_TRANSIT);
    expect(result.events![0]).toMatchObject({ provider_code: '13', description: 'Synthetic note' });
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(result).toMatchObject({ last_status_text: 'Synthetic note', current_stage: 'exception' });
  });

  it('reads the unknown-number answer as not found and a shipment without scans as no history', () => {
    expect(() => parseSaudiPost(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const list of [[], null]) {
      expect(() => parseSaudiPost(changed('delivered', (shipment) => { shipment.TrackingInfoItemList = list as never; }), DELIVERED))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    }
  });

  it('counts a shipment only when it names the number asked', () => {
    expect(() => parseSaudiPost(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Saudi Post answered for another shipment' }));
    expect(parseSaudiPost(changed('in-transit', (shipment) => { shipment.TrackingCode = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events)
      .toHaveLength(9);
    // Several numbers' answer, as the page asks for them, keeps the one asked.
    expect(parseSaudiPost([...fixture('delivered'), ...fixture('in-transit')], IN_TRANSIT)).toMatchObject({ expected_delivery: '2026-05-21' });
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_shipment: Shipment, body: Shipment[]) => { body.length = 0; },
      (_shipment: Shipment, body: Shipment[]) => { body[0] = 'shipment' as never; },
      (shipment: Shipment) => { shipment.TrackingCode = 17; },
      (shipment: Shipment) => { shipment.TrackingInfoItemList = 'scans' as never; },
      (shipment: Shipment) => { shipment.TrackingInfoItemList = Array.from({ length: 501 }, () => shipment.TrackingInfoItemList[0]!); },
      (shipment: Shipment) => { shipment.TrackingInfoItemList[0] = 'scan' as never; },
      (shipment: Shipment) => { shipment.TrackingInfoItemList[0]!.Status = '1'; },
      (shipment: Shipment) => { delete shipment.TrackingInfoItemList[0]!.Status; },
      (shipment: Shipment) => { shipment.TrackingInfoItemList[0]!.EventDateTime = '02/04/2026 09:14'; },
      (shipment: Shipment) => { shipment.TrackingInfoItemList[0]!.EventDateTime = '2026-02-30T09:14:05'; },
      (shipment: Shipment) => { shipment.TrackingInfoItemList[0]!.EventDateTime = '2026-04-02T24:00:00'; },
      (shipment: Shipment) => { shipment.TrackingInfoItemList[0]!.EventDateTime = '2026-04-02T09:14:05+03:00'; },
      (shipment: Shipment) => { delete shipment.TrackingInfoItemList[0]!.EventDateTime; },
      (shipment: Shipment) => { shipment.TrackingInfoItemList[0]!.EventDescription = ['Received']; },
      (shipment: Shipment) => { shipment.TrackingInfoItemList[0]!.EventDescription = ''; shipment.TrackingInfoItemList[0]!.StatusMessage = null; },
    ]) {
      expect(() => parseSaudiPost(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseSaudiPost({ Status: 404 }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a moved route, the firewall’s refusal and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page reads a missing parcel from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup({ Message: 'No HTTP resource was found that matches the request URI.' }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://splonline.com.sa/' } })).rejects.toMatchObject({ kind: 'transport' });
    // The firewall answers a request it refuses with its own page and HTTP 200.
    await expect(lookup(raw('rejected.html'), { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Just a moment...</title><script>window._cf_chl_opt = {}</script></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Shipment Details | Saudi Post | SPL</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number SPL does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-04-06T13:08:26' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('360000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers SPL does not issue, Naqel’s waybills and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['36000000', '360000000', '3600000000001', 'CRDSAL', 'RR005BD', 'SAMPLETRACKING', `RR${'0'.repeat(26)}BD`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSaudiPostNumber('crdsal 0000-0000-17')).toBe(DELIVERED);
    expect(normalizeSaudiPostNumber('1000000SA')).toBe('1000000SA');
  });

  it('tries a read that does not reach SPL once more inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 120 })).rejects.toThrow());
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('routes a number filed under Saudi Post, or detected as one of its numbers, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'saudi-post' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'saudi-post', source: 'saudi-post', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'saudi-post', source: 'saudi-post' });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(SAUDI_POST_API))).toBe(true);
  });
});

describe('Saudi Post numbers', () => {
  it('claims its CRDSAL numbers and leaves S10 items and digit runs to other detection', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'saudi-post', confidence: 'high' });
    expect(detectCarrierMatch('RR000000005SA').carrier).not.toBe('saudi-post');
    expect(detectCarrierMatch('360000000').carrier).not.toBe('saudi-post');
  });
});

describe('Saudi Post status vocabulary', () => {
  it('records every step and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      if (!entry.code) continue;
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(saudiPostStage(entry.code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'saudi-post', providerCode: entry.code, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'saudi-post', providerCode: '13', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
