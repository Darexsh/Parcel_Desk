import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CEVA_SHIPMENTS, CevaLogisticsTracker } from './adapter.js';
import { normalizeCevaLogisticsNumber, parseCevaLogisticsDetails, parseCevaLogisticsSearch } from './parser.js';
import { cevaLogisticsMilestoneStage, cevaLogisticsStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'SMP0000001';
const IN_TRANSIT = 'SMP0000002';
const ORDER = '7000002';
const UNKNOWN = 'SMP0000009';

type Row = Record<string, unknown>;
type Group = Row & { location: Row; events: Row[] };
type Shipment = Row & { summary: Row & { latest_milestone: Row; arrival_dates: Row }; event_history: Group[] };
type Search = Row & { total_results: number; results: Row[] };

const fixture = <T = Shipment>(name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as T;
const changed = (name: string, change: (shipment: Shipment) => void) => {
  const shipment = fixture(name);
  change(shipment);
  return shipment;
};
const searched = (change: (search: Search) => void) => {
  const search = fixture<Search>('search');
  change(search);
  return search;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const missing = () => reply(fixture('not-found'), { status: 404 });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const details = (reference: string) => `${CEVA_SHIPMENTS}/${reference}/HB`;
const search = (reference: string) => `${CEVA_SHIPMENTS}?query=${reference}&max_results=10`;
// Answers each URL from a table, so a test shows which lookups ran.
const routed = (routes: Record<string, () => Response>) => vi.fn<typeof fetch>(async (input) => {
  const route = routes[String(input)];
  if (!route) throw new Error(`unexpected request to ${String(input)}`);
  return route();
});

describe('CEVA Logistics HTTP adapter', () => {
  it('opens the whole number in capitals as a house bill once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CevaLogisticsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' smp-0000 002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(details(IN_TRANSIT));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ceva-logistics', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each terminal’s wall clock, names the town and country, and stages events by their code', () => {
    const result = parseCevaLogisticsDetails(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'On-Hand', last_update: null, last_update_local: '2026-03-06T09:51:28', expected_delivery: '2026-03-12',
      weight_kg: 120.502, destination_country: 'US' });
    expect(result).not.toHaveProperty('canonical_tracking_number');
    expect(result.events!.map((event) => [event.local_time ?? event.time, event.provider_code, event.stage ?? null, event.location ?? null])).toEqual([
      // The window's confirmation carries the offer's instant in UTC. It sorts by
      // that clock, as the page lists it, and moves nothing.
      ['2026-03-06T15:02:05Z', 'APPSET', null, 'SAMPLE DESTINATION, US'],
      ['2026-03-06T10:02:05', 'APPOFR', null, 'SAMPLE DESTINATION, US'],
      ['2026-03-06T09:51:28', 'OHD', 'in_transit', 'SAMPLE DESTINATION, US'],
      // A hub the reply names by code alone has no place.
      ['2026-03-05T21:40:42', 'CHKOUT', 'in_transit', null],
      ['2026-03-05T14:28:22', 'CHKINT', 'in_transit', null],
      ['2026-03-04T13:05:00', 'CUSRAL', 'in_transit', 'Sample Border, US'],
      ['2026-03-04T08:03:26', 'CUSTSB', 'customs', 'Sample Border, US'],
      ['2026-03-03T19:33:49', 'INBOND', 'customs', 'Sample Border, US'],
      ['2026-03-02T10:15:00', 'OHO', 'in_transit', 'Sample Origin, US'],
      ['2026-03-02T09:12:00', 'PICKUP', 'accepted', 'Sample Origin, US'],
      ['2026-03-02T09:11:30', 'HAWBCR', 'registered', 'Sample Origin, US'],
    ]);
    // Only the confirmation is an instant; every other clock is a terminal's wall clock.
    expect(result.events!.filter((event) => event.time !== undefined)).toEqual([expect.objectContaining({ provider_code: 'APPSET' })]);
    expect(result.events![0]).not.toHaveProperty('local_time');
    expect(result.events!.slice(1).every((event) => event.local_time && event.time === undefined)).toBe(true);
    expect(result.events!.at(-1)).toMatchObject({ description: 'Booking Created', stage_source: 'carrier_map' });
  });

  it('keeps the delivery without its signer, remarks, references or the repeated scan', () => {
    const result = parseCevaLogisticsDetails(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update_local: '2026-03-09T13:41:00', expected_delivery: null, weight_kg: 120.502,
      destination_country: 'US' });
    expect(result.events).toHaveLength(13);
    // A window confirmation and a final-mile check-out logged after the delivery do not undo it.
    expect(result.events!.slice(0, 3).map((event) => [event.provider_code, event.stage ?? null, event.time ?? event.local_time])).toEqual([
      ['APPSET', null, '2026-03-09T17:00:01Z'], ['CHKOFD', 'in_transit', '2026-03-09T15:02:10'], ['POD', 'delivered', '2026-03-09T13:41:00'],
    ]);
    expect(result.events!.filter((event) => event.stage === undefined).map((event) => event.provider_code)).toEqual(['APPSET', 'APPOFR', 'UNACTC']);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE SIGNER|sample\.|Sample Dialer|ED 03\/09|7000001|SAMPLEBOL|exception|zipCode|Third Party/);
  });

  it('takes the milestone’s word for a delivery or a closure, and a cancelled booking as an exception', () => {
    const delivered = parseCevaLogisticsDetails(changed('in-transit', (shipment) => {
      shipment.summary.latest_milestone.code = 'DeliveredWithException';
    }), IN_TRANSIT);
    expect(delivered).toMatchObject({ current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'On-Hand',
      expected_delivery: null });
    const closed = parseCevaLogisticsDetails(changed('in-transit', (shipment) => {
      shipment.summary.latest_milestone.code = 'ClosedWithException';
    }), IN_TRANSIT);
    expect(closed).toMatchObject({ status: 'exception', current_stage: 'exception', expected_delivery: null });
    const cancelled = parseCevaLogisticsDetails(changed('in-transit', (shipment) => { shipment.summary.cancelled = true; }), IN_TRANSIT);
    expect(cancelled).toMatchObject({ current_stage: 'exception', current_stage_source: 'carrier_map' });
    // Without an estimate the page shows the scheduled day.
    const scheduled = parseCevaLogisticsDetails(changed('in-transit', (shipment) => { shipment.summary.arrival_dates.estimated = null; }), IN_TRANSIT);
    expect(scheduled.expected_delivery).toBe('2026-03-12');
    const none = parseCevaLogisticsDetails(changed('in-transit', (shipment) => { shipment.summary.arrival_dates = {}; }), IN_TRANSIT);
    expect(none.expected_delivery).toBeNull();
    // A history of the confirmation alone dates the result by its instant.
    const confirmed = parseCevaLogisticsDetails(changed('in-transit', (shipment) => {
      shipment.summary.latest_milestone.code = 'AtShipper';
      shipment.event_history = [{ ...shipment.event_history[0]!, events: shipment.event_history[0]!.events.slice(0, 1) }];
    }), IN_TRANSIT);
    expect(confirmed).toMatchObject({ status: 'unknown', last_status_text: 'Delivery Window Confirmed with Customer',
      last_update: '2026-03-06T15:02:05Z' });
    expect(confirmed).not.toHaveProperty('last_update_local');
  });

  it('follows an order number through the search to its house bill and reports the house bill', async () => {
    const fetcher = routed({
      [details(ORDER)]: missing,
      [search(ORDER)]: () => reply(fixture('search')),
      [details(IN_TRANSIT)]: () => reply(fixture('in-transit')),
    });
    await expect(carrier(fetcher).track({ number: ORDER })).resolves.toMatchObject({ current_stage: 'in_transit',
      canonical_tracking_number: IN_TRANSIT });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([details(ORDER), search(ORDER), details(IN_TRANSIT)]);
  });

  it('follows only a whole house bill or order number to one shipment its lookup opens', () => {
    expect(parseCevaLogisticsSearch(fixture('search'), ORDER)).toEqual({ reference: IN_TRANSIT, type: 'HB', shipment: IN_TRANSIT });
    expect(() => parseCevaLogisticsSearch(fixture('search-empty'), ORDER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const inconclusive = (change: (search: Search) => void, message: string) => expect(() => parseCevaLogisticsSearch(searched(change), ORDER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message }));
    // More matches than the search lists, or only references the number begins.
    inconclusive((body) => { body.total_results = 11; body.results = []; }, 'CEVA matched more shipments than it lists');
    inconclusive((body) => { body.results.pop(); body.total_results = 1; }, 'CEVA matched only longer references');
    inconclusive((body) => { body.results[1]!.matched_reference_type = 'BillOfLadingNumber'; },
      'CEVA matched a reference that is not a house bill or an order number');
    inconclusive((body) => { body.results[0]!.matched_reference_number = ORDER; }, 'CEVA matched several shipments');
    inconclusive((body) => { body.results[1]!.module = 'GR'; }, 'CEVA matched a shipment its public lookup does not open');
    // The same shipment matched twice is one shipment.
    expect(parseCevaLogisticsSearch(searched((body) => { body.results.push(body.results[1]!); }), ORDER)).toMatchObject({ shipment: IN_TRANSIT });
  });

  it('binds the second lookup to the shipment the search matched', async () => {
    const lookup = (opened: () => Response) => carrier(routed({
      [details(ORDER)]: missing, [search(ORDER)]: () => reply(fixture('search')), [details(IN_TRANSIT)]: opened,
    })).track({ number: ORDER });
    await expect(lookup(() => reply(fixture('delivered')))).rejects.toMatchObject({ kind: 'indeterminate', message: 'CEVA answered for another shipment' });
    await expect(lookup(missing)).rejects.toMatchObject({ kind: 'indeterminate', message: 'CEVA did not open the shipment its search matched' });
  });

  it('reads an unknown number as not found only when neither the lookup nor the search knows it', async () => {
    const fetcher = routed({ [details(UNKNOWN)]: missing, [search(UNKNOWN)]: () => reply(fixture('search-empty')) });
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const skipped = routed({ [details(UNKNOWN)]: missing, [search(UNKNOWN)]: () => new Response(null, { status: 204 }) });
    await expect(carrier(skipped).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('counts a shipment only when it names the house bill asked, and one without events as no history', () => {
    expect(() => parseCevaLogisticsDetails(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'CEVA answered for another shipment' }));
    expect(parseCevaLogisticsDetails(changed('in-transit', (shipment) => {
      shipment.summary.house_bill_number = IN_TRANSIT.toLowerCase();
    }), IN_TRANSIT).events).toHaveLength(11);
    for (const history of [null, [], [{ location: {}, events: [] }]]) {
      expect(() => parseCevaLogisticsDetails(changed('in-transit', (shipment) => { shipment.event_history = history as never; }), IN_TRANSIT))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    }
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (shipment: Shipment) => { delete (shipment as Row).summary; },
      (shipment: Shipment) => { delete shipment.summary.house_bill_number; },
      (shipment: Shipment) => { shipment.event_history = 'events' as never; },
      (shipment: Shipment) => { shipment.event_history = Array.from({ length: 201 }, () => shipment.event_history[0]!); },
      (shipment: Shipment) => { shipment.event_history[0] = 'group' as never; },
      (shipment: Shipment) => { shipment.event_history[0]!.events = 'events' as never; },
      (shipment: Shipment) => { shipment.event_history[0]!.events[0] = 'event' as never; },
      (shipment: Shipment) => { shipment.event_history[0]!.location = 'SMD' as never; },
      (shipment: Shipment) => { shipment.event_history[0]!.events[0]!.local_date = '12/03/2026 15:00'; },
      (shipment: Shipment) => { shipment.event_history[0]!.events[0]!.local_date = '2026-03-12T15:00:01-0500'; },
      (shipment: Shipment) => { shipment.event_history[0]!.events[0]!.local_date = '2026-02-30T15:00:01+0000'; },
      (shipment: Shipment) => { shipment.event_history[0]!.events[0]!.name = ['Delivered']; },
      (shipment: Shipment) => { shipment.event_history[0]!.events[0]!.name = ''; },
      (shipment: Shipment) => { shipment.summary.total_weight = [{ value: '120', unit: 'KG' }]; },
    ]) {
      expect(() => parseCevaLogisticsDetails(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of [{}, { total_results: 1 }, { total_results: 1, results: ['shipment'] }]) {
      expect(() => parseCevaLogisticsSearch(body, ORDER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps a moved route, a refusal, a browser check and a broken reply apart from an unknown number', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    // The gateway's answer for a route it no longer serves.
    await expect(lookup('"Proxy rule not found"', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Not Found</title></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://my.cevalogistics.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Access Denied</title></head><body>Reference #0.0</body></html>', { status: 403 }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Access Denied</title><a href="https://errors.edgesuite.net/0">ref</a></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Just a moment...</title><script>window._cf_chl_opt = {}</script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>myCEVA</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    const empty = carrier(vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(empty.track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('preserves a rate limit on the search', async () => {
    const fetcher = routed({ [details(ORDER)]: missing, [search(ORDER)]: () => new Response('', { status: 429 }) });
    await expect(carrier(fetcher).track({ number: ORDER })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number CEVA does not issue', async () => {
    const fetcher = routed({
      [details(DELIVERED)]: () => reply(fixture('delivered')),
      [details(UNKNOWN)]: missing,
      [search(UNKNOWN)]: () => reply(fixture('search-empty')),
    });
    // The window's confirmation is the history's one instant; the terminals' wall clocks cannot date activity.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-09T17:00:01.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers CEVA does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['SMP1', 'SAMPLEREF', '00000000', `SMP${'0'.repeat(38)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeCevaLogisticsNumber('smp 0000.001')).toBe(DELIVERED);
  });

  it('retries a hanging attempt once inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('routes a number filed under CEVA Logistics to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'ceva-logistics' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'ceva-logistics', source: 'ceva-logistics', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === details(DELIVERED))).toBe(true);
  });
});

describe('CEVA Logistics status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      // Shipment milestones are written in mixed case; event codes in capitals.
      const milestone = entry.code !== entry.code.toUpperCase();
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBeUndefined();
        expect(cevaLogisticsStage(entry.code, entry.wording), entry.code).toBeNull();
        expect(statusMapAnswer({ carrier: 'ceva-logistics', providerCode: entry.code, description: entry.wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      if (milestone) expect(cevaLogisticsMilestoneStage(entry.code), entry.code).toBe(entry.stage);
      else expect(cevaLogisticsStage(entry.code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'ceva-logistics', providerCode: 'POD', description: 'Delivered' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'ceva-logistics', providerCode: 'ZZZZZZ', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to the shared wording rules.
    expect(cevaLogisticsStage('PODX', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(cevaLogisticsStage('ZZZZZZ', 'Synthetic note')).toBeNull();
    expect(cevaLogisticsStage('appset', 'Delivered')).toBeNull();
    expect(cevaLogisticsStage('pod', 'Delivered')).toEqual({ stage: 'delivered', source: 'carrier_map' });
  });
});
