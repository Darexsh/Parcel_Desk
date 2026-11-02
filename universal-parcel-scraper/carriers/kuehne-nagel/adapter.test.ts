import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, KUEHNE_NAGEL_ORIGIN, KuehneNagelTracker } from './adapter.js';
import { parseKuehneNagel, parseKuehneNagelSearch, type KuehneNagelMatch } from './parser.js';
import { kuehneNagelLabel, kuehneNagelStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'RWM999000001';
const TRANSIT = 'RWM999000002';
const ABSENT = 'RWM999000099';
const SEARCH = `${KUEHNE_NAGEL_ORIGIN}/public-tracking/internal/shipment-list?query=`;
const SHIPMENT = `${KUEHNE_NAGEL_ORIGIN}/public-tracking/internal/shipments/900000001`;
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const json = <T>(name: string) => JSON.parse(text(name)) as T;
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

interface Clock { date: string; time?: string; offset?: string; localDateTime: string; offsetDateTime: string }
interface Milestone { labelIdentifier: string; achievementDateTime?: unknown; actualAchievementDateTime?: unknown; exception?: unknown }
interface Stop { location: Record<string, unknown>; locationMilestones: Milestone[] }
interface Routing { routeLocations: Stop[] }
interface Notice { labelIdentifier: string; dateTime?: Clock; children?: unknown[] }
interface Information { transportInformationMilestones: Notice[] }
interface Shipment {
  id: unknown; trackingNumber?: unknown; weight?: unknown; completionMilestoneDate?: unknown;
  currentMilestoneDate: { actualAchievementDateTime: { dateTime: Partial<Clock> } };
}
interface Group { kind: string; numberOfResults?: number; shipments: (Shipment | null)[] }
interface Search { totalResults: number; searchResultsByType: Group[] }
// The tracker's replies by address: the search for any reference, then a shipment's route and notices.
const tracker = (replies: { search?: string; routing?: string; information?: string } = {}) => vi.fn<typeof fetch>(async (input) => {
  const url = String(input);
  if (url.startsWith(SEARCH)) return reply(replies.search ?? text('search-found'));
  if (url.endsWith('/shipment-routing')) return reply(replies.routing ?? text('routing-delivered'));
  if (url.endsWith('/information-milestones')) return reply(replies.information ?? text('information-delivered'));
  return reply('', 404);
});
const search = (change: (shipments: Shipment[], payload: Search) => void) => {
  const payload = json<Search>('search-found');
  change(payload.searchResultsByType[0]!.shipments as Shipment[], payload);
  return payload;
};
const MATCH: KuehneNagelMatch = { id: '900000001', trackingNumber: DELIVERED, kind: 'reference.TN', weightKg: 120.5, lastActivityAt: null };
const delivered = (change: (stops: Stop[], notices: Notice[]) => void = () => {}) => {
  const routing = json<Routing>('routing-delivered');
  const information = json<Information>('information-delivered');
  change(routing.routeLocations, information.transportInformationMilestones);
  return parseKuehneNagel(routing, information, MATCH, DELIVERED);
};
const rows = (result: ReturnType<typeof parseKuehneNagel>) =>
  result.events!.map(event => [event.time ?? event.local_time, event.provider_code, event.stage ?? null, event.location ?? null]);
const clock = (date: string, time?: string, offset?: string): Clock => ({ date, ...(time ? { time } : {}), ...(offset ? { offset } : {}),
  localDateTime: `${date}T${time ?? '00:00:00'}`, offsetDateTime: `${date}T${time ?? '00:00:00'}${offset ?? '+00:00'}` });

describe('Kuehne+Nagel tracking adapter', () => {
  it('searches the whole reference, then asks for the shipment’s route and notices by its id, in English, and records the step', async () => {
    const fetcher = tracker();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new KuehneNagelTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' rwm-999 000 001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `${SEARCH}${DELIVERED}`, `${SHIPMENT}/shipment-routing`, `${SHIPMENT}/information-milestones`]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ signal: expect.any(AbortSignal),
        headers: { Accept: 'application/json', 'Accept-Language': 'en', 'User-Agent': 'SyntheticHost/1.0' } });
      expect(init?.method).toBeUndefined();
      expect(new Headers(init!.headers).has('cookie')).toBe(false);
    }
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'kuehne-nagel', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered road shipment’s achieved milestones and notices, newest first, with their offsets', async () => {
    const result = await carrier(tracker()).track({ number: DELIVERED });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Proof of delivery available', last_update: '2026-03-12T10:15:00+01:00', expected_delivery: null,
      delivered_at: '2026-03-12T09:40:00+01:00', weight_kg: 120.5, destination_country: 'FR' });
    expect(rows(result)).toEqual([
      ['2026-03-12T10:15:00+01:00', 'pod-available', 'delivered', null],
      ['2026-03-12T09:40:00+01:00', 'destination.cargo-delivered.road', 'delivered', 'Villefictive, FR'],
      ['2026-03-12T07:20:00+01:00', 'arrival.in-delivery.road', 'out_for_delivery', 'Exempleville, FR'],
      ['2026-03-12T06:30:00+01:00', 'arrival.vehicle-arrived.road', 'in_transit', 'Exempleville, FR'],
      ['2026-03-10T19:05:00+01:00', 'booking-confirmation', 'registered', null],
      ['2026-03-10T18:50:00+01:00', 'departure.vehicle-departed.road', 'in_transit', 'Beispielfeld, DE'],
      ['2026-03-10T18:05:00+01:00', 'departure.vehicle-arrived.road', 'in_transit', 'Beispielfeld, DE'],
      ['2026-03-10T16:02:00Z', 'delivery-appointment-submission', null, null],
      ['2026-03-10T08:12:31Z', 'booking-submission', 'registered', null],
    ]);
    expect(result.events!.map(event => event.description)).toEqual(['Proof of delivery available', 'Delivery', 'In delivery', 'Arrival',
      'Booking confirmation', 'Departure', 'Arrival', 'Delivery appointment submission', 'Booking submission']);
    // The planned pickup and delivery are forecasts, the vehicle and the search's own towns are not read.
    expect(JSON.stringify(result)).not.toMatch(/ready-for-pickup|2026-03-11|V0000001|Musterstadt|volume|canonical/);
  });

  it('keeps clocks without an offset as local clocks, reads notice details and skips notices still to come', () => {
    const result = parseKuehneNagel(json<Routing>('routing-in-transit'), json<Information>('information-in-transit'),
      { id: '900000002', trackingNumber: TRANSIT, kind: 'reference.TN', lastActivityAt: null }, TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Departure',
      last_update: '2026-02-06T18:00:00+01:00', delivered_at: null, destination_country: 'GR' });
    expect(result.weight_kg).toBeUndefined();
    expect(rows(result)).toEqual([
      ['2026-02-06T18:00:00+01:00', 'transit.vehicle-departed.road', 'in_transit', 'Probedorf, DE'],
      ['2026-02-05T23:38:00+01:00', 'transit.vehicle-arrived.road', 'in_transit', 'Probedorf, DE'],
      ['2026-02-04T20:56:00Z', 'departure.vehicle-departed.road', 'in_transit', 'Testbury, GB'],
      ['2026-02-04T12:30:00Z', 'export-customs-clearance-complete', 'in_transit', null],
      ['2026-02-04T10:05:00Z', 'child.customs-documentation-first-received', 'customs', null],
      ['2026-02-04T10:00:00Z', 'export-customs-clearance-start', 'customs', null],
      ['2026-02-03T21:44:00', 'departure.vehicle-arrived.road', 'in_transit', 'Testbury, GB'],
      ['2026-02-03T16:36:00', 'origin.cargo-picked-up.road', 'accepted', 'Sampleton, GB'],
      ['2026-02-03T09:00:00Z', 'booking-submission', 'registered', null],
    ]);
    expect(result.events!.filter(event => event.local_time).every(event => event.time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/import-customs|Mythopoli|Paradeigma|T00000/);
  });

  it('reads a road exception beside its milestone, at the date it was reported', () => {
    const failed = delivered((stops, notices) => {
      stops[3]!.locationMilestones = [];
      notices.pop();
      stops[2]!.locationMilestones[1]!.exception = { label: 'routing.road-exception.name.delivery-attempt-failed',
        statusDate: clock('2026-03-12', '11:05:00', '+01:00'), explanation: 'Synthetic note' };
    });
    expect(failed).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: 'Delivery attempt failed',
      last_update: '2026-03-12T11:05:00+01:00', delivered_at: null });
    expect(failed.events![0]).toEqual({ time: '2026-03-12T11:05:00+01:00', description: 'Delivery attempt failed',
      provider_code: 'road-exception.name.delivery-attempt-failed', location: 'Exempleville, FR', stage: 'failed_attempt', stage_source: 'carrier_map' });
    expect(JSON.stringify(failed)).not.toContain('Synthetic note');
    // Without a date of its own, the exception takes its milestone's; a delivery with discrepancies is a delivery.
    const discrepancies = delivered((stops) => {
      stops[3]!.locationMilestones[0]!.exception = { label: 'routing.road-exception.name.delivery-with-discrepancies' };
    });
    expect(discrepancies).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-03-12T09:40:00+01:00' });
    expect(rows(discrepancies)[1]).toEqual(['2026-03-12T09:40:00+01:00', 'road-exception.name.delivery-with-discrepancies', 'delivered', 'Villefictive, FR']);
    // A label the messages do not hold is kept, worded from its code and without a stage.
    const unknown = delivered((stops) => {
      stops[2]!.locationMilestones[1]!.exception = { label: 'routing.road-exception.name.synthetic-hold', statusDate: clock('2026-03-12', '12:00:00', '+01:00') };
    });
    expect(unknown.events![0]).toEqual({ time: '2026-03-12T12:00:00+01:00', description: 'Road exception synthetic hold',
      provider_code: 'road-exception.name.synthetic-hold', location: 'Exempleville, FR' });
    expect(unknown).toMatchObject({ current_stage: 'delivered', last_status_text: 'Proof of delivery available' });
  });

  it('never moves a shipment back for a booking confirmed late or a notice filed after the delivery', () => {
    const late = delivered((_, notices) => {
      notices.pop();
      notices.push({ labelIdentifier: 'information-milestone.import-customs-clearance-complete', dateTime: clock('2026-03-13', '09:00:00', '+01:00') },
        { labelIdentifier: 'information-milestone.booking-modification', dateTime: clock('2026-03-13', '10:00:00', '+01:00') });
    });
    expect(late).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivery',
      last_update: '2026-03-12T09:40:00+01:00', delivered_at: '2026-03-12T09:40:00+01:00' });
    // A cancellation or a failed delivery after it still counts.
    const cancelled = delivered((_, notices) => {
      notices.push({ labelIdentifier: 'information-milestone.cancellation', dateTime: clock('2026-03-13', '09:00:00', '+01:00') });
    });
    expect(cancelled).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Cancellation', delivered_at: null });
  });

  it('reads a booked shipment as registered and one without achieved milestones or notices as no history', () => {
    const booked = delivered((stops, notices) => {
      for (const stop of stops) stop.locationMilestones = stop.locationMilestones.filter(milestone => !milestone.actualAchievementDateTime);
      notices.splice(1);
    });
    expect(booked).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'Booking submission' });
    expect(booked.events).toHaveLength(1);
    const empty = () => delivered((stops, notices) => {
      for (const stop of stops) stop.locationMilestones = stop.locationMilestones.filter(milestone => !milestone.actualAchievementDateTime);
      notices.splice(0);
    });
    expect(empty).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'no_history' }));
    // Gaps alone keep the status unknown.
    const notice = delivered((stops, notices) => {
      for (const stop of stops) stop.locationMilestones = [];
      notices.splice(0, notices.length, { labelIdentifier: 'information-milestone.hawb-creation', dateTime: clock('2026-03-10', '09:00:00', '+01:00') });
    });
    expect(notice).toMatchObject({ status: 'unknown', last_status_text: 'HAWB available', last_update: '2026-03-10T09:00:00+01:00' });
    expect(notice.current_stage).toBeUndefined();
  });

  it('keeps a stop’s town only without digits and its country, and a date without a clock as a local date', () => {
    const result = delivered((stops) => {
      stops[3]!.location.freeTextLocation = '12 Rue Fictive';
      stops[1]!.location = { locationCode: 'DEBSF', countryCode: 'DE', countryName: 'Germany', freeTextLocation: 'Beispielfeld Hbf' };
      stops[1]!.locationMilestones[0]!.actualAchievementDateTime = { condition: 'ACTUAL', dateTime: clock('2026-03-10') };
      delete stops[1]!.locationMilestones[0]!.achievementDateTime;
    });
    expect(rows(result)).toContainEqual(['2026-03-12T09:40:00+01:00', 'destination.cargo-delivered.road', 'delivered', 'France']);
    expect(rows(result)).toContainEqual(['2026-03-10', 'departure.vehicle-arrived.road', 'in_transit', 'Beispielfeld Hbf, DE']);
    expect(JSON.stringify(result)).not.toContain('Rue Fictive');
  });

  it('rejects malformed routes and notices', () => {
    const information = json<Information>('information-delivered');
    for (const routing of [null, [], {}, { routeLocations: {} }, { routeLocations: ['stop'] },
      { routeLocations: [{ location: {}, locationMilestones: {} }] },
      { routeLocations: [{ location: {}, locationMilestones: [{ labelIdentifier: 'arrival.in-delivery.road' }] }] },
      { routeLocations: [{ location: {}, locationMilestones: [null] }] },
      { routeLocations: Array.from({ length: 101 }, () => ({ locationMilestones: [] })) }]) {
      expect(() => parseKuehneNagel(routing, information, MATCH, DELIVERED), JSON.stringify(routing).slice(0, 80))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const routing = json<Routing>('routing-delivered');
    for (const notices of [null, [], { transportInformationMilestones: {} }, { transportInformationMilestones: ['notice'] },
      { transportInformationMilestones: [{ labelIdentifier: 'information-milestone.pod-available', children: {} }] },
      { transportInformationMilestones: [{ labelIdentifier: 'information-milestone.pod-available', children: [7] }] }]) {
      expect(() => parseKuehneNagel(routing, notices, MATCH, DELIVERED), JSON.stringify(notices)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A reply without notices has none.
    expect(parseKuehneNagel(routing, {}, MATCH, DELIVERED)).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivery' });
    expect(() => parseKuehneNagel(routing, information, MATCH, 'RWM 9')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });
});

describe('Kuehne+Nagel search', () => {
  it('takes the shipment whose own tracking number is the reference, ignoring case and separators', () => {
    expect(parseKuehneNagelSearch(json<Search>('search-found'), 'rwm-999 000 001')).toEqual({ id: '900000001', trackingNumber: DELIVERED,
      kind: 'reference.TN', weightKg: 120.5, lastActivityAt: '2026-03-12T09:15:00.000Z' });
    // Another shipment found under a customer reference does not compete with the exact match.
    const both = search((shipments, payload) => {
      payload.searchResultsByType.push({ kind: 'reference.CR', numberOfResults: 1,
        shipments: [{ ...shipments[0]!, id: 900000003, trackingNumber: 'RWM999000003' }] });
    });
    expect(parseKuehneNagelSearch(both, DELIVERED)).toMatchObject({ id: '900000001', trackingNumber: DELIVERED });
    expect(() => parseKuehneNagelSearch(json<Search>('search-not-found'), ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseKuehneNagelSearch({ totalResults: 0, searchResultsByType: [] }, ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('follows another reference to its one shipment and names that shipment’s tracking number', async () => {
    const alias = search((shipments, payload) => { payload.searchResultsByType[0]!.kind = 'reference.CR'; shipments[0]!.weight = { value: '9', unit: 'content.weightUnit.lb' }; });
    expect(parseKuehneNagelSearch(alias, '99000000001')).toMatchObject({ id: '900000001', trackingNumber: DELIVERED, kind: 'reference.CR' });
    const result = await carrier(tracker({ search: JSON.stringify(alias) })).track({ number: '99-0000-00001' });
    expect(result).toMatchObject({ status: 'delivered', canonical_tracking_number: DELIVERED });
    expect(result.weight_kg).toBeUndefined();
    // The same shipment in two groups is one shipment.
    const twice = search((shipments, payload) => {
      payload.searchResultsByType[0]!.kind = 'reference.KN';
      payload.searchResultsByType.push({ kind: 'reference.PN', numberOfResults: 1, shipments: [{ ...shipments[0]! }] });
    });
    expect(parseKuehneNagelSearch(twice, '99000000001')).toMatchObject({ id: '900000001', kind: 'reference.KN' });
  });

  it('leaves several shipments for one reference undecided and rejects malformed results', () => {
    const several = search((shipments, payload) => {
      payload.searchResultsByType[0]!.kind = 'reference.CR';
      shipments.push({ ...shipments[0]!, id: 900000003, trackingNumber: 'RWM999000003' });
      payload.totalResults = 2;
    });
    expect(() => parseKuehneNagelSearch(several, '99000000001')).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'several_parcels' }));
    for (const payload of [null, [], {}, { totalResults: '1' }, { totalResults: 1 }, { totalResults: 1, searchResultsByType: [] },
      { totalResults: 1, searchResultsByType: {} }, { totalResults: 1, searchResultsByType: [{ kind: 'reference.TN' }] },
      search(shipments => { shipments[0]!.id = 'abc'; }), search(shipments => { delete shipments[0]!.trackingNumber; }),
      search(shipments => { (shipments as (Shipment | null)[])[0] = null; })]) {
      expect(() => parseKuehneNagelSearch(payload, DELIVERED), JSON.stringify(payload)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('recognizes a number found under one of Kuehne+Nagel’s own references, from the search alone', async () => {
    const fetcher = tracker();
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-12T09:15:00.000Z' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(carrier(tracker({ search: text('search-not-found') })).recognize!(ABSENT)).resolves.toEqual({ known: false });
    const house = search((_, payload) => { payload.searchResultsByType[0]!.kind = 'reference.HAW'; });
    await expect(carrier(tracker({ search: JSON.stringify(house) })).recognize!('99A999000001')).resolves.toMatchObject({ known: true });
    // A customer reference or a container anyone can hold does not show the number is Kuehne+Nagel's.
    for (const kind of ['reference.CR', 'reference.CN', 'reference.PN']) {
      const foreign = search((_, payload) => { payload.searchResultsByType[0]!.kind = kind; });
      await expect(carrier(tracker({ search: JSON.stringify(foreign) })).recognize!('99A999000001'), kind).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    // Clocks without an offset cannot rank reuse of a number.
    const local = search((shipments) => {
      delete shipments[0]!.currentMilestoneDate.actualAchievementDateTime.dateTime.offset;
      delete shipments[0]!.completionMilestoneDate;
    });
    await expect(carrier(tracker({ search: JSON.stringify(local) })).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null });
  });

  it('takes references of 6 to 35 letters and digits with at least one digit, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['RWM9', 'ABCDEFGH', 'RWM999/000001', 'X'.repeat(35) + '1']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('', status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps a missing route or notices apart from a missing shipment', async () => {
    for (const part of ['routing', 'information'] as const) {
      const fetcher = vi.fn<typeof fetch>(async (input) => String(input).startsWith(SEARCH) ? reply(text('search-found'))
        : String(input).endsWith(part === 'routing' ? '/shipment-routing' : '/information-milestones') ? reply('', 404)
          : reply(text(part === 'routing' ? 'information-delivered' : 'routing-delivered')));
      await expect(carrier(fetcher).track({ number: DELIVERED }), part).rejects.toMatchObject({ kind: 'transport' });
    }
  });

  it('keeps block pages and malformed replies apart from missing shipments', async () => {
    for (const [body, kind] of [
      ['<html><head><title>Request Rejected</title></head><body>The requested URL was rejected.</body></html>', 'challenge'],
      ['<html><body>Maintenance</body></html>', 'schema'], ['', 'schema'], ['{"searchResultsByType":[]}', 'schema']] as const) {
      await expect(carrier(tracker({ search: body })).recognize!(DELIVERED), body).rejects.toMatchObject({ kind });
      await expect(carrier(tracker({ routing: body })).track({ number: DELIVERED }), body).rejects.toMatchObject({ kind });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const answers = tracker();
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockImplementation(answers);
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(4);
    const immediate = tracker();
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
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

  it('routes a shipment filed under Kuehne+Nagel to the adapter', async () => {
    const fetcher = tracker();
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'kuehne-nagel' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'kuehne-nagel', source: 'kuehne-nagel', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${KUEHNE_NAGEL_ORIGIN}/public-tracking/internal/`))).toBe(true);
  });

  it('is asked about year-prefixed road numbers, which detection leaves as a suggestion, and reads its links', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'kuehne-nagel', confidence: 'high' });
    expect(recognitionAskedCarriers('99A999000001')).toContain('kuehne-nagel');
    for (const link of [`https://mykn.kuehne-nagel.com/public-tracking/shipments?query=${DELIVERED}`,
      `https://mykn.kuehne-nagel.com/public-tracking/shipments/900000001?query=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'kuehne-nagel', source: 'link' });
    }
  });
});

describe('Kuehne+Nagel status vocabulary', () => {
  it('records every code with the tracker’s English wording and the stage the map gives', () => {
    expect(new Set(statuses.entries.map(entry => entry.code)).size).toBe(statuses.entries.length);
    for (const entry of statuses.entries) {
      expect(kuehneNagelStage(entry.code), entry.code).toBe(entry.stage);
      expect(kuehneNagelLabel(entry.code), entry.code).toBe(entry.wording);
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase())).toBe(entry.stage);
      if (!entry.stage) expect(entry.note, entry.code).toBeTruthy();
    }
    for (const code of ['constructor', 'toString', 'arrival.unknown.road', '']) expect(kuehneNagelStage(code), code).toBeUndefined();
    expect(statusMap.stage(null, 'delivery')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'kuehne-nagel', providerCode: 'arrival.in-delivery.road', description: 'In delivery' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'kuehne-nagel', providerCode: 'hawb-creation', description: 'HAWB available' }))
      .toMatchObject({ kind: 'intentional_gap' });
  });
});
