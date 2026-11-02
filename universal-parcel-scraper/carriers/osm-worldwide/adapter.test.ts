import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, OSM_ENDPOINT, OsmWorldwideTracker, osmTrackingUrl } from './adapter.js';
import { normalizeOsmNumber, parseOsmWorldwide } from './parser.js';
import { osmCodeStage, osmGroupStage, osmStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'OSM000000TT01ZZ9X';
const PACKAGE = 'A0000000001ZZZ00000001';
const PIC = '9205599999999900000015';
const ABSENT = 'OSM000000ZZ9999ZZ';
// A parsed fixture that tests change in place.
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const notFound = (id: string) => [{ result: 'not-found', id }];
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(
  typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
/** The fixture's entry with its newest scan changed. */
const newestWith = (name: string, scan: Reply): Reply => {
  const payload = fixture(name);
  Object.assign(payload[0].history[0], scan);
  return payload;
};

describe('OSM Worldwide tracking adapter', () => {
  it('asks the tracking service once for the number through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new OsmWorldwideTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' osm000000tt01zz9x ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://prod.track-pub.osmworldwide.com/tracking/tracking-request?ids=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'osm-worldwide', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered parcel newest first, as wall clocks, with each scan once and its town', () => {
    const result = parseOsmWorldwide(fixture('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Package delivered', last_update: null, last_update_local: '2026-03-12T14:07:21', expected_delivery: null,
      events: [
        { local_time: '2026-03-12T14:07:21', description: 'Package delivered', location: 'RIVERTON, WA, US', provider_code: 'OSM01',
          stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-03-12T07:48:05', description: 'Package left courier partner and is on its way', location: 'RIVERTON, WA, US',
          provider_code: 'OSM13', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-10T08:16:44', description: 'Package left courier partner and is on its way', location: 'RIVERTON, WA, US',
          provider_code: 'OSM13', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-09T17:20:00', description: 'Departed OSM facility', location: 'MESA VERDE, NV, US', provider_code: 'OSM05',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-09T15:02:37', description: 'Package arrived at courier partner', location: 'LAKEVIEW, IL, US', provider_code: 'OSM06',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-09T06:41:00', description: 'Arrived at OSM facility', location: 'MESA VERDE, NV, US', provider_code: 'OSM04',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-07T23:55:00', description: 'Departed OSM facility', location: 'OAK HOLLOW, IL, US', provider_code: 'OSM05',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-07T19:12:00', description: 'Arrived at OSM facility', location: 'OAK HOLLOW, IL, US', provider_code: 'OSM04',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-06T03:30:00', description: 'Shipping label created - OSM awaiting item', provider_code: 'OSM02',
          stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    // Postcodes, scan ids and the shipper's package reference stay behind; an OSM id names no partner.
    const text = JSON.stringify(result);
    for (const value of ['00009', '00006', '00000000-0000', 'SHOP-ORDER-0001']) expect(text, value).not.toContain(value);
  });

  it('names USPS as the delivery carrier of a USPS barcode and keeps the expected day until the delivery', () => {
    const result = parseOsmWorldwide(fixture('usps-transit'), PIC);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Package arrived at courier partner', last_update: null, last_update_local: '2026-04-02T10:15:00',
      expected_delivery: '2026-04-06', delivery_carrier: 'usps' });
    expect(result.delivery_tracking_number).toBeUndefined();
    expect(result.events!.map((event) => [event.provider_code, event.stage])).toEqual([['OSM06', 'in_transit'], ['OSM04', 'in_transit'], ['OSM02', 'registered']]);
    expect(deliveryHandoff('osm-worldwide', PIC, result)).toEqual({ carrier: 'usps', number: PIC, basis: 'partner' });
    expect(deliveryHandoff('osm-worldwide', DELIVERED, parseOsmWorldwide(fixture('delivered'), DELIVERED))).toBeNull();
    for (const [value, expected] of [['2026-04-06T00:00:00', '2026-04-06'], ['2026-04-06T00:00:00.000', '2026-04-06'], ['', null], [null, null],
      ['2026-02-30', null], ['04/06/2026', null], ['2026-04-06T09:30:00', null]] as const) {
      const payload = fixture('usps-transit');
      payload[0].estDelivery = value;
      expect(parseOsmWorldwide(payload, PIC).expected_delivery, String(value)).toBe(expected);
    }
    const delivered = newestWith('usps-transit', { eventCode: 'OSM01', description: 'Package delivered', group: 4 });
    expect(parseOsmWorldwide(delivered, PIC)).toMatchObject({ status: 'delivered', expected_delivery: null });
  });

  it('stages a scan by its code, then the tracker flags and milestone group, then OSM wording and the shared rules', () => {
    const result = parseOsmWorldwide(fixture('attempted'), PACKAGE);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map',
      last_status_text: 'Delivery attempted - no access to delivery location', expected_delivery: null });
    expect(result.delivery_carrier).toBeUndefined();
    expect(result.events).toEqual([
      { local_time: '2026-05-20T18:31:09', description: 'Delivery attempted - no access to delivery location', location: 'RIVERTON, WA, US',
        provider_code: 'OSM99', stage: 'failed_attempt', stage_source: 'carrier_map' },
      { local_time: '2026-05-20T08:02:51', description: 'Out for delivery with courier partner', location: 'RIVERTON, WA, US',
        provider_code: 'OSM98', stage: 'out_for_delivery', stage_source: 'carrier_map' },
      // OSM's FAQ: the label upload, not a pickup.
      { local_time: '2026-05-17T11:00:00', description: 'Picked Up by Shipping Partner', stage: 'registered', stage_source: 'carrier_map' },
    ]);
    const exception = newestWith('attempted', { instructionsNeeded: false, isException: true });
    expect(parseOsmWorldwide(exception, PACKAGE)).toMatchObject({ current_stage: 'exception', current_stage_source: 'carrier_map' });
    // A known code outranks the flags; the shared rules read wording the map does not know.
    const coded = newestWith('attempted', { eventCode: 'OSM01', description: 'Package delivered', isException: true });
    expect(parseOsmWorldwide(coded, PACKAGE)).toMatchObject({ current_stage: 'delivered' });
    const worded = newestWith('attempted', { eventCode: 'OSM97', instructionsNeeded: false, description: 'Package returned to sender' });
    expect(parseOsmWorldwide(worded, PACKAGE)).toMatchObject({ current_stage: 'returned', current_stage_source: expect.stringMatching(/^wording:/) });
    // Wording nobody knows keeps no stage, and the next staged scan decides.
    const unknown = parseOsmWorldwide(newestWith('attempted', { eventCode: 'OSM97', instructionsNeeded: false, description: 'Synthetic note' }), PACKAGE);
    expect(unknown).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Synthetic note' });
    expect(unknown.events![0]).toEqual({ local_time: '2026-05-20T18:31:09', description: 'Synthetic note', location: 'RIVERTON, WA, US', provider_code: 'OSM97' });
    const none = fixture('attempted');
    none[0].history = [{ ...none[0].history[0], eventCode: 'OSM97', instructionsNeeded: false, description: 'Synthetic note' }];
    expect(parseOsmWorldwide(none, PACKAGE)).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic note' });
    expect(parseOsmWorldwide(none, PACKAGE).current_stage).toBeUndefined();
  });

  it('keeps an instant only when the scan carries an offset, and leaves a place part with digits out', () => {
    const payload = newestWith('attempted', { datetime: '2026-05-20T18:31:09.250Z', city: '12 SAMPLE ST', state: 'WA', country: '' });
    const result = parseOsmWorldwide(payload, PACKAGE);
    expect(result).toMatchObject({ last_update: '2026-05-20T18:31:09.250Z' });
    expect(result.last_update_local).toBeUndefined();
    expect(result.events![0]).toMatchObject({ time: '2026-05-20T18:31:09.250Z', location: 'WA' });
    expect(result.events![0]!.local_time).toBeUndefined();
  });

  it('caps the history it returns', () => {
    const long = fixture('delivered');
    long[0].history = Array.from({ length: 120 }, (_, index) => ({ ...long[0].history[1],
      datetime: `2026-03-${String(1 + Math.floor(index / 24)).padStart(2, '0')}T${String(index % 24).padStart(2, '0')}:00:00` }));
    const result = parseOsmWorldwide(long, DELIVERED);
    expect(result.events).toHaveLength(100);
    expect(result.history_truncated).toBe(true);
  });

  it('counts a reply only for the number asked, and only the service’s not-found as a missing parcel', () => {
    expect(() => parseOsmWorldwide(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseOsmWorldwide(notFound(DELIVERED.toLowerCase()), DELIVERED)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const payload of [notFound(ABSENT), fixture('delivered'), [{ ...fixture('delivered')[0], id: undefined }]]) {
      expect(() => parseOsmWorldwide(payload, PACKAGE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const result of ['pending', 'error', '']) {
      expect(() => parseOsmWorldwide([{ result, id: ABSENT }], ABSENT), result).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    const empty = fixture('delivered');
    empty[0].history = [];
    expect(() => parseOsmWorldwide(empty, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects replies it cannot read', () => {
    const broken: Array<(payload: Reply) => void> = [
      (payload) => { payload.push(payload[0]); },
      (payload) => { payload[0] = 'found'; },
      (payload) => { payload[0].history = {}; },
      (payload) => { payload[0].history[0] = null; },
      (payload) => { payload[0].history[0].datetime = '2026-02-30T10:00:00'; },
      (payload) => { payload[0].history[0].datetime = '2026-03-12T24:00:00'; },
      (payload) => { payload[0].history[0].datetime = null; },
      (payload) => { payload[0].history[0].description = ''; },
      (payload) => { payload[0].history[0].city = { name: 'RIVERTON' }; },
      (payload) => { payload[0].history[0].group = '4'; },
      (payload) => { payload[0].history[0].isException = 'false'; },
      (payload) => { payload[0].history = Array.from({ length: 501 }, () => payload[0].history[0]); },
    ];
    for (const [index, change] of broken.entries()) {
      const payload = fixture('delivered');
      change(payload);
      expect(() => parseOsmWorldwide(payload, DELIVERED), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const payload of [null, [], {}, 'not-found', { result: 'found', id: DELIVERED }]) {
      expect(() => parseOsmWorldwide(payload, DELIVERED), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('sends a routing barcode without its ZIP code and refuses other input without a request', async () => {
    expect(normalizeOsmNumber(` 420 00000 ${PIC} `)).toBe(PIC);
    expect(osmTrackingUrl(`42000000${PIC}`)).toBe(`${OSM_ENDPOINT}?ids=${PIC}`);
    expect(normalizeOsmNumber('a0000000001zzz00000001')).toBe(PACKAGE);
    const fetcher = vi.fn<typeof fetch>();
    // A routing barcode whose package identifier fails its check digit, a stray character, and lengths the tracker does not take.
    for (const number of [`42000000${PIC.slice(0, -1)}6`, 'OSM_000', 'AB1', '', 'A'.repeat(41), '9'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recognizes a parcel OSM knows, reads its not-found as unknown, and never claims a USPS barcode', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered'))).mockResolvedValueOnce(reply(notFound(ABSENT)))
      .mockResolvedValueOnce(reply(notFound(ABSENT)));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-12T14:07:21' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const usps = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('usps-transit')));
    for (const number of [PIC, `42000000${PIC}`]) await expect(carrier(usps).recognize!(number), number).resolves.toEqual({ known: false });
    expect(usps).not.toHaveBeenCalled();
    await expect(carrier(usps).track({ number: PIC })).resolves.toMatchObject({ delivery_carrier: 'usps' });
    // Another number's answer is no answer either way.
    const other = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    await expect(carrier(other).recognize!(ABSENT)).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[400, 'indeterminate'], [403, 'challenge'], [404, 'transport'], [410, 'transport'], [429, 'rate_limited'], [500, 'indeterminate'],
    [503, 'maintenance']] as const)('keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
    const body = status === 400 ? { statusCode: 400, title: 'Error', message: 'Maximum of 1 ID is allowed', details: {} } : '';
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body, status));
    await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind });
    await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps the rate limit’s wait, block pages, other pages and oversized replies apart from missing parcels', async () => {
    const limited = vi.fn<typeof fetch>().mockResolvedValue(reply('', 429, { 'Retry-After': '30' }));
    await expect(carrier(limited).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    for (const body of ['<!DOCTYPE html><html><head><title>ERROR: The request could not be satisfied</title></head><body>CloudFront</body></html>',
      '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>']) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body));
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'challenge' });
    }
    for (const body of ['', '<html><head><title>Error</title></head><body><pre>Cannot GET /tracking</pre></body></html>', '[{"result":']) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body));
      await expect(carrier(fetcher).track({ number: ABSENT }), body).rejects.toMatchObject({ kind: 'schema' });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('claims OSM’s own package ids, leaves USPS barcodes to USPS, and reads tracker links', () => {
    // Detection claims them outright, so recognition is not asked.
    for (const number of [DELIVERED, PACKAGE]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'osm-worldwide', confidence: 'high' });
      expect(recognitionAskedCarriers(number), number).toEqual([]);
    }
    for (const number of [PIC, `42000000${PIC}`]) {
      expect(detectCarrierMatch(number).carrier, number).toBe('usps');
      expect(recognitionAskedCarriers(number), number).not.toContain('osm-worldwide');
    }
    for (const number of ['OSM000000TT01ZZ9', 'OSM000000TT01ZZ9XY', 'XSM000000TT01ZZ9X']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('osm-worldwide');
    }
    for (const link of [`https://www.osmworldwide.com/tracking/?trackingIds=${DELIVERED}`, `https://www.osmworldwide.com/tracking/?trackingNumbers=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'osm-worldwide', source: 'link' });
    }
  });

  it('routes OSM’s own ids to the adapter and offers USPS a barcode OSM answers', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'osm-worldwide', source: 'osm-worldwide', result: { current_stage: 'delivered' } });
    expect(answer.handoff).toBeUndefined();
    expect(fetcher.mock.calls.every(([url]) => String(url) === `${OSM_ENDPOINT}?ids=${DELIVERED}`)).toBe(true);

    const partnered = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).startsWith(OSM_ENDPOINT)
      ? reply(fixture('usps-transit')) : reply('', 500));
    const handed = await createTracker({ fetcher: partnered, providers: [], env: {} })
      .track({ number: PIC, carrier: 'osm-worldwide' }, { budgetMs: 3000 });
    expect(handed).toMatchObject({ carrier: 'osm-worldwide', source: 'osm-worldwide',
      result: { current_stage: 'in_transit', delivery_carrier: 'usps' }, handoff: { carrier: 'usps', number: PIC, basis: 'partner' } });
  });
});

describe('OSM Worldwide status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    const flags = { group: 0, instructionsNeeded: false, isException: false };
    for (const entry of statuses.entries) {
      const code = 'code' in entry ? entry.code ?? '' : '';
      const label = `${code} ${entry.wording}`;
      expect(osmStage(code, entry.wording, flags), label).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMap.stage(code || null, normalizeStatusWording(entry.wording)), label).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'osm-worldwide', providerCode: code || null, description: entry.wording }), label)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(osmGroupStage(3)).toBe('out_for_delivery');
    for (const code of ['constructor', 'toString', 'OSM00', '']) expect(osmCodeStage(code), code).toBeUndefined();
    for (const group of [0, 5, -1]) expect(osmGroupStage(group), String(group)).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'osm-worldwide', providerCode: 'OSM97', description: 'Package delivered' })).toEqual({ kind: 'unknown' });
  });
});
