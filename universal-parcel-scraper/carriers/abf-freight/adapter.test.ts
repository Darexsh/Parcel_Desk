import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { ABF_ENDPOINT, AbfFreightTracker, abfTrackingUrl, adapter } from './adapter.js';
import { normalizeAbfNumber, parseAbfFreight } from './parser.js';
import { abfStage, abfWordingStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '000000101';
const TRANSIT = '000000202';
const ABSENT = '000000909';
// A parsed fixture that tests change in place.
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const notFound = (number: string) => ({ [number]: [] });
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(
  typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
/** The fixture with its shipment's transit status changed. */
const transitWith = (name: string, number: string, changes: Reply): Reply => {
  const payload = fixture(name);
  Object.assign(payload[number][0].data.transitStatus, changes);
  return payload;
};
// ArcBest's edge page, which a request without the page's referrer gets after a few seconds.
const EDGE_PAGE = '<!DOCTYPE html><html lang="en"><head><title>There was a problem</title></head>'
  + '<body><h1>We are experiencing technical difficulties.</h1><p>Please try again later.</p></body></html>';

describe('ABF Freight tracking adapter', () => {
  it('asks the page’s tracking service once for the PRO, from the page, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new AbfFreightTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 000-000-101 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://view.arcb.com/api/nlo/track?ref=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal), headers: { Accept: 'application/json',
      'User-Agent': 'SyntheticHost/1.0', Referer: `https://view.arcb.com/nlo/tools/tracking/${DELIVERED}` } });
    expect(init!.body).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'abf-freight', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery as an instant on the delivering center’s clock, and the pickup at a center on Central time', () => {
    const result = parseAbfFreight(fixture('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      // 10:15 at a center an hour behind Central is Mountain time, whatever offset the service gives it.
      last_update: '2026-03-12T10:15:00-06:00', expected_delivery: null, delivered_at: '2026-03-12T10:15:00-06:00',
      weight_kg: 54.431, destination_country: 'US', summary_only: true,
      events: [
        { time: '2026-03-12T10:15:00-06:00', description: 'Delivered', location: 'MESA LINDA, TX', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2026-03-06T15:20:11-06:00', description: 'Picked Up', location: 'BAYPORT, TX', stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
    // The signer, instructions, addresses, postcodes, positions and contacts stay behind.
    const text = JSON.stringify(result);
    for (const value of ['SYNTHETIC', 'SAMPLE', '00000', '10.5', 'ABF SERVICE CENTER', 'Received by', '901', '902']) {
      expect(text, value).not.toContain(value);
    }
  });

  it('keeps a pickup clock whose zone it cannot settle as a wall clock, and the projected day until the delivery', () => {
    const result = parseAbfFreight(fixture('transit'), TRANSIT);
    expect(result).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'At Destination Service Center', last_update: null, expected_delivery: '2026-04-09',
      weight_kg: 226.796, destination_country: 'US', summary_only: true,
      // A center on Eastern time: the clock may be its own or Central's.
      events: [{ local_time: '2026-04-03T08:29:00', description: 'Picked Up', location: 'RIVERBEND, KY', stage: 'accepted', stage_source: 'carrier_map' }],
    });
    for (const [kind, expected] of [['appointment', '2026-04-09'], ['unknown', null], ['final', null], ['', null]] as const) {
      expect(parseAbfFreight(transitWith('transit', TRANSIT, { effectiveDateType: kind }), TRANSIT).expected_delivery, kind).toBe(expected);
    }
    const delivered = transitWith('transit', TRANSIT, { status: 'Delivered', effectiveDateType: 'projected' });
    expect(parseAbfFreight(delivered, TRANSIT)).toMatchObject({ current_stage: 'delivered', expected_delivery: null, last_update: null });
  });

  it('settles a center’s zone only from its state and its offset from Central', () => {
    const at = (center: Reply, clock: string) => {
      const payload = transitWith('delivered', DELIVERED, { effectiveDate: clock });
      Object.assign(payload[DELIVERED][0].data.transitStatus.serviceCenters.consignee, center);
      return parseAbfFreight(payload, DELIVERED);
    };
    const place = (city: string, stateProvince: string, country = 'US') => ({ city, stateProvince, country, street1: '1 SAMPLE ROAD' });
    // A state with one zone needs no offset; a split state needs one that names a single zone.
    expect(at({ utcOffset: null, physicalAddress: place('LAKEVIEW', 'IL') }, '2026-07-01T09:00:00').delivered_at).toBe('2026-07-01T09:00:00-05:00');
    expect(at({ utcOffset: 1, physicalAddress: place('RIVERBEND', 'KY') }, '2026-07-01T09:00:00').delivered_at).toBe('2026-07-01T09:00:00-04:00');
    expect(at({ utcOffset: 0, physicalAddress: place('RIVERBEND', 'KY') }, '2026-01-15T09:00:00').delivered_at).toBe('2026-01-15T09:00:00-06:00');
    expect(at({ utcOffset: -2, physicalAddress: place('HIGH DESERT', 'NV') }, '2026-07-01T09:00:00').delivered_at).toBe('2026-07-01T09:00:00-07:00');
    expect(at({ utcOffset: 1, physicalAddress: place('HARBOURTON', 'ON', 'CA') }, '2026-07-01T09:00:00'))
      .toMatchObject({ delivered_at: '2026-07-01T09:00:00-04:00', destination_country: 'CA', events: [{ location: 'HARBOURTON, ON, CA' }, {}] });
    for (const center of [{ utcOffset: null, physicalAddress: place('MESA LINDA', 'TX') }, { utcOffset: 3, physicalAddress: place('LAKEVIEW', 'IL') },
      { utcOffset: 0, physicalAddress: place('PUEBLO NUEVO', 'NL', 'MX') }, { utcOffset: 0, physicalAddress: place('NOWHERE', 'ZZ') },
      { utcOffset: -1, physicalAddress: null }]) {
      const result = at(center, '2026-07-01T09:00:00');
      expect(result.delivered_at, JSON.stringify(center)).toBeUndefined();
      expect(result).toMatchObject({ last_update: null, last_update_local: '2026-07-01T09:00:00', events: [{ local_time: '2026-07-01T09:00:00' }, {}] });
    }
    // A midnight clock is a day the page shows without a time.
    expect(at({}, '2026-07-01T00:00:00')).toMatchObject({ last_update: null, last_update_local: '2026-07-01', events: [{ local_time: '2026-07-01' }, {}] });
    // The delivered clock stands in when the effective date is missing; its offset is Central's and is dropped.
    const fallback = parseAbfFreight(transitWith('delivered', DELIVERED, { effectiveDate: null, delivered: '2026-03-12T11:40:00-05:00' }), DELIVERED);
    expect(fallback.delivered_at).toBe('2026-03-12T11:40:00-06:00');
    // A place part with digits could be a street or a postcode.
    expect(at({ utcOffset: 0, physicalAddress: place('12 SAMPLE ST', 'IL') }, '2026-07-01T09:00:00').events![0]!.location).toBeUndefined();
  });

  it('stages the status by ArcBest’s wording, then the shared rules, then the rail and the pickup', () => {
    const staged = (changes: Reply, rail?: Reply[]) => {
      const payload = transitWith('transit', TRANSIT, changes);
      if (rail) payload[TRANSIT][0].meta.progress = rail;
      return parseAbfFreight(payload, TRANSIT);
    };
    expect(staged({ status: 'Out For Delivery' })).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', expected_delivery: '2026-04-09' });
    expect(staged({ status: 'Returned to shipper' })).toMatchObject({ current_stage: 'returned', current_stage_source: 'wording:returned' });
    // Wording nobody knows leaves the rail's furthest step done or under way to decide.
    expect(staged({ status: 'Synthetic note' })).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Synthetic note' });
    expect(staged({ status: 'Synthetic note' }, [{ title: 'Picked Up', completion: 'inProgress' }, { title: 'Delivered', completion: 'incomplete' }]))
      .toMatchObject({ current_stage: 'accepted', last_update: null, last_update_local: '2026-04-03T08:29:00' });
    expect(staged({ status: null, effectiveDateType: 'final', effectiveDate: '2026-04-08T13:05:00' }, []))
      .toMatchObject({ status: 'delivered', last_status_text: null, delivered_at: '2026-04-08T13:05:00-05:00' });
    expect(staged({ status: '', effectivePickupType: 'pickupScheduled' }, [])).toMatchObject({ status: 'pending', current_stage: 'registered' });
    expect(staged({ status: 'Pickup Stop Completed', effectivePickupType: 'pickupStopCompleted' }).events)
      .toEqual([{ local_time: '2026-04-03T08:29:00', description: 'Pickup Stop Completed', location: 'RIVERBEND, KY', stage: 'accepted', stage_source: 'carrier_map' }]);
    const unknown = staged({ status: 'Synthetic note', effectivePickupType: null }, []);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic note', events: [] });
    expect(unknown.current_stage).toBeUndefined();
    expect(() => staged({ status: null, effectivePickupType: null, effectiveDateType: 'unknown' }, []))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('answers only for the PRO asked, and counts only the service’s empty answer as a missing shipment', () => {
    expect(() => parseAbfFreight(fixture('not-found'), ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseAbfFreight(notFound(DELIVERED), DELIVERED)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const payload of [notFound(ABSENT), fixture('transit'), { ...fixture('delivered'), ...notFound(ABSENT) }]) {
      expect(() => parseAbfFreight(payload, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // The service finds shipments by a reference too; the page shows its last one.
    const reference = fixture('transit')[TRANSIT][0];
    const byReference = { [DELIVERED]: [{ ...reference, id: TRANSIT }] };
    expect(() => parseAbfFreight(byReference, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const both = fixture('delivered');
    both[DELIVERED].push({ ...reference, id: TRANSIT });
    expect(parseAbfFreight(both, DELIVERED)).toMatchObject({ current_stage: 'delivered', weight_kg: 54.431 });
    const twice = fixture('delivered');
    twice[DELIVERED].push({ ...reference, id: DELIVERED, data: { ...reference.data, identifiers: { pronumber: DELIVERED } } });
    expect(parseAbfFreight(twice, DELIVERED)).toMatchObject({ current_stage: 'in_transit' });
    const mismatched = fixture('delivered');
    mismatched[DELIVERED][0].data.identifiers.pronumber = TRANSIT;
    expect(() => parseAbfFreight(mismatched, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // ArcBest's page sends a U-Pack move to upack.com.
    const upack = fixture('delivered');
    upack[DELIVERED][0].data.solution = 'UpackResidential';
    expect(() => parseAbfFreight(upack, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects replies it cannot read', () => {
    const broken: Array<(item: Reply) => void> = [
      (item) => { item.data = 'shipment'; },
      (item) => { item.data.transitStatus = []; },
      (item) => { item.data.transitStatus.status = { text: 'Delivered' }; },
      (item) => { item.data.transitStatus.serviceCenters.consignee.utcOffset = '-1'; },
      (item) => { item.data.transitStatus.serviceCenters.consignee.utcOffset = 14; },
      (item) => { item.data.transitStatus.serviceCenters.consignee.physicalAddress = 'MESA LINDA'; },
      (item) => { item.meta.progress = {}; },
      (item) => { item.meta.progress[0] = 'Picked Up'; },
      (item) => { item.meta.progress = Array.from({ length: 21 }, () => item.meta.progress[0]); },
    ];
    for (const [index, change] of broken.entries()) {
      const payload = fixture('delivered');
      change(payload[DELIVERED][0]);
      expect(() => parseAbfFreight(payload, DELIVERED), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const payload of [null, [], {}, 'Delivered', { [DELIVERED]: {} }, { [DELIVERED]: [null] }, { [DELIVERED]: Array.from({ length: 51 }, () => ({})) }]) {
      expect(() => parseAbfFreight(payload, DELIVERED), JSON.stringify(payload)?.slice(0, 40)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A clock it cannot read is no milestone, and a weight it cannot read is none.
    for (const clock of ['2026-02-30T10:00:00', '2026-03-12T24:00:00', '03/12/2026 10:15 AM', '']) {
      const payload = transitWith('delivered', DELIVERED, { effectiveDate: clock, delivered: null });
      expect(parseAbfFreight(payload, DELIVERED).events!.map((event) => event.description), clock).toEqual(['Picked Up']);
    }
    for (const weight of [{ unit: 'lb', value: 0 }, { unit: 'oz', value: 12 }, { unit: 'lb', value: '120' }, null]) {
      const payload = fixture('delivered');
      payload[DELIVERED][0].data.details.totalWeight = weight;
      expect(parseAbfFreight(payload, DELIVERED).weight_kg, JSON.stringify(weight)).toBeUndefined();
    }
    const kilos = fixture('delivered');
    kilos[DELIVERED][0].data.details.totalWeight = { unit: 'kg', value: 54.5 };
    expect(parseAbfFreight(kilos, DELIVERED).weight_kg).toBe(54.5);
  });

  it('refuses numbers ABF does not issue without a request', async () => {
    expect(normalizeAbfNumber(' 000 000 101 ')).toBe(DELIVERED);
    expect(abfTrackingUrl('000.000.202')).toBe(`${ABF_ENDPOINT}?ref=${TRANSIT}`);
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['00000010', '0000001010', 'A00000101', '', '9'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recognizes a shipment ArcBest knows and reads its empty answer as unknown', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered'))).mockResolvedValueOnce(reply(fixture('transit')))
      .mockResolvedValueOnce(reply(fixture('not-found'), 404)).mockResolvedValueOnce(reply(fixture('not-found'), 404));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-12T16:15:00.000Z' });
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-04-03T08:29:00' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(4);
    // Another number's answer is no answer either way.
    const other = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    await expect(carrier(other).recognize!(ABSENT)).rejects.toMatchObject({ kind: 'schema' });
    const otherEmpty = vi.fn<typeof fetch>().mockImplementation(async () => reply(notFound(DELIVERED), 404));
    await expect(carrier(otherEmpty).recognize!(ABSENT)).rejects.toMatchObject({ kind: 'transport' });
  });

  it.each([[403, 'challenge'], [404, 'transport'], [410, 'transport'], [429, 'rate_limited'], [500, 'indeterminate'],
    [503, 'maintenance']] as const)('keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
    const body = status === 403 ? { title: 'Forbidden', status: 403 } : status === 503 ? '' : { message: 'Synthetic' };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body, status));
    await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind });
    await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps the rate limit’s wait, the edge’s page, other pages and oversized replies apart from missing shipments', async () => {
    const limited = vi.fn<typeof fetch>().mockResolvedValue(reply('', 429, { 'Retry-After': '30' }));
    await expect(carrier(limited).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    for (const [body, status] of [[EDGE_PAGE, 503], [EDGE_PAGE, 200], ['<html><head><title>Just a moment...</title></head><body></body></html>', 200]] as const) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body, status, { 'Content-Type': 'text/html', 'Retry-After': '0' }));
      await expect(carrier(fetcher).track({ number: ABSENT }), String(status)).rejects.toMatchObject({ kind: 'challenge' });
      await expect(carrier(fetcher).recognize!(ABSENT), String(status)).rejects.toMatchObject({ kind: 'challenge' });
    }
    for (const body of ['', '<html><head><title>Error</title></head><body>Server Error</body></html>', '{"000000909":']) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body));
      await expect(carrier(fetcher).track({ number: ABSENT }), body).rejects.toMatchObject({ kind: 'schema' });
    }
    const missing = vi.fn<typeof fetch>().mockImplementation(async () => reply('<html><body>Not Found</body></html>', 404));
    await expect(carrier(missing).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'transport' });
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(300_000)));
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

  it('leaves nine-digit numbers to the caller’s choice, and reads tracking page links', () => {
    // Nine digits are a PRO number at several carriers, so neither detection nor recognition offers ABF.
    for (const number of [DELIVERED, TRANSIT]) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('abf-freight');
      expect(recognitionAskedCarriers(number), number).not.toContain('abf-freight');
    }
    for (const link of [`https://view.arcb.com/nlo/tools/tracking#/${DELIVERED}`, `https://view.arcb.com/nlo/tools/tracking/${DELIVERED}`,
      `https://view.arcb.com/nlo/tools/tracking/#/${DELIVERED}?source=email`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'abf-freight', source: 'link' });
    }
    expect(parseTrackingInput(`https://view.arcb.com/nlo/tools/quotes#/${DELIVERED}`).carrier).not.toBe('abf-freight');
  });

  it('routes a PRO the caller names ABF’s to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'abf-freight' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'abf-freight', source: 'abf-freight', result: { current_stage: 'delivered', summary_only: true } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === `${ABF_ENDPOINT}?ref=${DELIVERED}`)).toBe(true);
  });
});

describe('ABF Freight status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(abfStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(abfWordingStage(entry.wording.toUpperCase()), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'abf-freight', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    for (const wording of ['constructor', 'toString', '']) expect(abfWordingStage(wording), wording).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'abf-freight', providerCode: 'X1', description: 'Delivered' })).toEqual({ kind: 'unknown' });
  });
});
