import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, MORNING_GLOBAL_ACTION, MORNING_GLOBAL_API, MORNING_GLOBAL_PAGE, MorningGlobalTracker } from './adapter.js';
import { morningGlobalWording, normalizeMorningGlobalNumber, parseMorningGlobal, parseMorningGlobalNonce } from './parser.js';
import { morningGlobalMappedStage, morningGlobalStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'QQ000000011MG';
const IN_TRANSIT = 'QQ000000002MG';
const NO_HISTORY = 'QQ000000003PH01';
const UNKNOWN = 'QQ000000000MG';
const NONCE = '0a1b2c3d4e';

type Row = Record<string, unknown>;
type Result = Row & { events: Row[] };
type Reply = { success: boolean; data: { results: Result[] } };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(`${name}.json`)) as Reply;
const PAGE = text('tracking-page.html');
/** A fixture whose only result is changed in place by `change`. */
const changed = (name: string, change: (result: Result, reply: Reply) => void): Reply => {
  const reply = fixture(name);
  change(reply.data.results[0]!, reply);
  return reply;
};
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=UTF-8', ...init.headers } });
/** A site that serves the tracker page, then `lookup` for the plugin's action. */
const site = (lookup: () => Response, page: () => Response = () => html(PAGE)) => vi.fn<typeof fetch>()
  .mockImplementation(async (url) => (String(url).startsWith(MORNING_GLOBAL_PAGE) ? page() : lookup()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';

describe('Morning Global HTTP adapter', () => {
  it('reads the nonce from the number’s tracker page, then posts the whole number with it, through the supplied transport', async () => {
    const fetcher = site(() => json(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new MorningGlobalTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' qq 000-000-002 mg ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[pageUrl, pageInit], [url, init]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(String(pageUrl)).toBe(`${MORNING_GLOBAL_PAGE}?tracking_number=${IN_TRANSIT}`);
    expect(pageInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(String(url)).toBe(MORNING_GLOBAL_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(Object.fromEntries(new URLSearchParams(String(init.body))))
      .toEqual({ action: MORNING_GLOBAL_ACTION, nonce: NONCE, tracking_number: IN_TRANSIT, mg_tr_website: '' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'morning-global', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('takes the tracking plugin’s nonce, not the site’s others, and only for its own action and endpoint', () => {
    expect(parseMorningGlobalNonce(PAGE)).toBe(NONCE);
    for (const page of [
      PAGE.replace(`&quot;nonce&quot;:&quot;${NONCE}&quot;,`, ''),
      PAGE.replace(NONCE, 'not-a-nonce'),
      PAGE.replace('mg_tr_lookup', 'other_action'),
      PAGE.replace('www.morninglobal.com\\/wp-admin', 'www.example.com\\/wp-admin'),
      PAGE.replace('data-mg-tr-config="{', 'data-mg-tr-config="'),
      PAGE.replace('class="mg-tracking-results"', 'class="other-section"'),
    ]) {
      expect(() => parseMorningGlobalNonce(page)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseMorningGlobalNonce(CLOUDFLARE)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('keeps each scan once, newest first, as an instant where its location names the offset and as a wall clock elsewhere', () => {
    const result = parseMorningGlobal(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-05-18T14:02:00-04:00', delivered_at: '2026-05-18T14:02:00-04:00',
      expected_delivery: null, service_name: 'MGIE', destination_country: 'CA' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.location ?? null, event.description, event.stage])).toEqual([
      ['2026-05-18T14:02:00-04:00', 'CA', 'Delivered', 'delivered'],
      ['2026-05-18T07:10:00-04:00', 'CA', 'Out for Delivery', 'out_for_delivery'],
      ['2026-05-14T12:30:00-04:00', 'CA', 'Handed Over for Delivery', 'in_transit'],
      ['2026-05-13T15:50:00-04:00', 'CA', 'Customs Cleared', 'in_transit'],
      ['2026-05-13T08:05:00-04:00', 'CA', 'Customs Clearance Begins', 'customs'],
      ['2026-05-11T18:20:00-04:00', 'CA', 'Arrive Destination', 'in_transit'],
      // Hub and flight scans name no place, so their clocks stay on the wall.
      ['2026-05-11T03:15:00', null, 'Flight Departure to Destination', 'in_transit'],
      ['2026-05-11T01:30:00', null, 'Ready for Departure', 'in_transit'],
      // The hub scan listed twice is kept once.
      ['2026-05-10T11:40:00', null, 'Arrive Hub', 'in_transit'],
      ['2026-05-10T10:12:00+08:00', 'HK', 'Collection', 'accepted'],
      ['2026-05-08T16:05:00+08:00', 'HK', 'Order Created', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !(event.time && event.local_time))).toBe(true);
    // The signatory, origin, reference, weight, pieces and estimate stay out.
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Person|Origin)|SAMPLEREF|1\.25|2026-05-20|signed/i);
  });

  it('keeps a wall clock whose named offset the country’s own clock did not have then', () => {
    const result = parseMorningGlobal(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', last_status_text: 'Customs Clearance Begins',
      last_update: null, last_update_local: '2026-07-09T09:45:00', destination_country: 'GB' });
    expect(result).not.toHaveProperty('service_name');
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.location ?? null])).toEqual([
      // British clocks were an hour ahead of UTC in July.
      ['2026-07-09T09:45:00', 'GB'],
      ['2026-07-08T06:40:00+01:00', 'GB'],
      ['2026-07-07T02:45:00', null],
      ['2026-07-06T10:05:00', null],
      ['2026-07-06T09:30:00+08:00', 'HK'],
      ['2026-07-03T20:15:00+08:00', 'HK'],
    ]);
  });

  it('reads an offset across a country of several zones as the reply gives it, and a place in another form as it is', () => {
    const result = parseMorningGlobal(changed('in-transit', (shipment) => {
      shipment.destination = 'Sampleland';
      Object.assign(shipment.events[4]!, { location: 'US (UTC-7)' });
      Object.assign(shipment.events[5]!, { location: 'Sample Hub', description: 'Customs Clearance Begins' });
      Object.assign(shipment.events[0]!, { location: 'QQ (UTC+8)' });
    }), IN_TRANSIT);
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.location ?? null])).toEqual([
      ['2026-07-09T09:45:00', 'Sample Hub'],
      ['2026-07-08T06:40:00-07:00', 'US'],
      ['2026-07-07T02:45:00', null],
      ['2026-07-06T10:05:00', null],
      ['2026-07-06T09:30:00+08:00', 'HK'],
      // No country has the code, so the offset is not read.
      ['2026-07-03T20:15:00', 'QQ'],
    ]);
    // The destination is not a country, so the arrival scan's country stands.
    expect(result).toMatchObject({ destination_country: 'US' });
  });

  it('reads a history listed newest first in that order', () => {
    const result = parseMorningGlobal(changed('delivered', (shipment) => { shipment.events.reverse(); }), DELIVERED);
    expect(result).toMatchObject({ last_status_text: 'Delivered', current_stage: 'delivered' });
    expect(result.events!.at(-1)).toMatchObject({ description: 'Order Created' });
  });

  it('adds a description that says more than the status, without a signatory or phone numbers', () => {
    expect(morningGlobalWording('Delivered', 'Delivered, signed by Sample Person')).toBe('Delivered');
    expect(morningGlobalWording('Delivered', 'Received by Sample Person')).toBe('Delivered');
    expect(morningGlobalWording('Handed Over for Delivery', 'Call +00 (0) 000 000 0000 for help'))
      .toBe('Handed Over for Delivery: Call for help');
    expect(morningGlobalWording('Arrive Hub', 'arrive hub')).toBe('Arrive Hub');
    expect(morningGlobalWording('', 'Arrive Hub')).toBe('Arrive Hub');
    const result = parseMorningGlobal(changed('delivered', (shipment) => {
      shipment.events[9]!.description = 'Parcel handed to the local partner';
    }), DELIVERED);
    expect(result.events![2]).toMatchObject({ description: 'Handed Over for Delivery: Parcel handed to the local partner', stage: 'in_transit',
      stage_source: 'carrier_map' });
  });

  it('reads an unknown number as not found, a refusal as inconclusive and a parcel without scans as no history', () => {
    expect(() => parseMorningGlobal(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The answer names the number it looked up; one naming another proves nothing about this one.
    expect(() => parseMorningGlobal(fixture('not-found'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Morning Global answered for another number' }));
    expect(() => parseMorningGlobal({ success: true, data: { results: [] } }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Morning Global answered for another number' }));
    expect(() => parseMorningGlobal({ success: false, data: { message: 'Shipment information is temporarily unavailable. Please try again later.' } }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Morning Global did not complete the lookup' }));
    expect(() => parseMorningGlobal(fixture('no-history'), NO_HISTORY)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('keeps only the result that names the whole number asked', () => {
    expect(() => parseMorningGlobal(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Morning Global answered for another number' }));
    expect(parseMorningGlobal(changed('in-transit', (shipment) => { shipment.tracking_number = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events)
      .toHaveLength(6);
    expect(() => parseMorningGlobal(changed('in-transit', (shipment) => { shipment.tracking_number = `${IN_TRANSIT}9`; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ message: 'Morning Global answered for another number' }));
    // A reply for several numbers is read for the one asked.
    const both = fixture('in-transit');
    both.data.results.unshift(fixture('not-found').data.results[0]!);
    expect(parseMorningGlobal(both, IN_TRANSIT)).toMatchObject({ current_stage: 'customs' });
  });

  it('rejects a changed reply', () => {
    for (const [index, change] of [
      (_shipment: Result, reply: Reply) => { (reply as Row).success = 'true'; },
      (_shipment: Result, reply: Reply) => { (reply as Row).data = 'results'; },
      (_shipment: Result, reply: Reply) => { (reply.data as Row).results = 'results'; },
      (_shipment: Result, reply: Reply) => { reply.data.results = Array.from({ length: 21 }, () => reply.data.results[0]!); },
      (shipment: Result) => { delete shipment.tracking_number; },
      (shipment: Result) => { shipment.found = 'yes'; },
      (shipment: Result) => { shipment.events = 'events' as never; },
      (shipment: Result) => { shipment.events = Array.from({ length: 301 }, () => shipment.events[0]!); },
      (shipment: Result) => { shipment.events[0] = 'scan' as never; },
      (shipment: Result) => { shipment.events[0]!.date = '03/07/2026'; },
      (shipment: Result) => { shipment.events[0]!.time = '8:15'; },
      (shipment: Result) => { shipment.events[0]!.time = '24:00'; },
      (shipment: Result) => { shipment.events[0]!.date = '2026-02-30'; },
      (shipment: Result) => { delete shipment.events[0]!.time; },
      (shipment: Result) => { shipment.events[0]!.location = 'HK (UTC+15)'; },
      (shipment: Result) => { shipment.events[0]!.status = ['Order Created']; },
      (shipment: Result) => { shipment.events[0]!.status = ''; shipment.events[0]!.description = null; },
      (shipment: Result) => { shipment.service = 7; },
    ].entries()) {
      expect(() => parseMorningGlobal(changed('in-transit', change), IN_TRANSIT), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a refused nonce, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: () => Response, page?: () => Response) => carrier(site(body, page)).track({ number: UNKNOWN });
    await expect(lookup(() => json(fixture('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    // WordPress answers a nonce it does not accept with HTTP 403 and `-1`.
    await expect(lookup(() => html('-1', { status: 403 }))).rejects.toMatchObject({ kind: 'indeterminate', reason: 'nonce_expired' });
    await expect(lookup(() => html(CLOUDFLARE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    // An action no plugin registers is HTTP 400 and `0`; a 404 or a redirect is a move too.
    await expect(lookup(() => html('0', { status: 400 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => html('', { status: 302, headers: { Location: 'https://www.morninglobal.com/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => json(fixture('not-found')), () => html('', { status: 301, headers: { Location: 'https://www.morninglobal.com/' } })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => json(fixture('not-found')), () => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    // The plugin's own refusals carry `success: false`.
    await expect(lookup(() => json({ success: false, data: { message: 'Shipment information is temporarily unavailable. Please try again later.' } },
      { status: 400 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(() => json({ success: false, data: { message: 'Enter a tracking number to view the latest shipment information.' } },
      { status: 422 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(() => html(CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => json(fixture('not-found')), () => html(CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html('<html><title>Morning Global</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => json(fixture('not-found')), () => html('<html><title>Morning Global</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s from the page and from the lookup', async (status, kind) => {
      const fromLookup = site(() => new Response('', { status }));
      await expect(carrier(fromLookup).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fromLookup).toHaveBeenCalledTimes(2);
      const fromPage = site(() => json(fixture('in-transit')), () => new Response('', { status }));
      await expect(carrier(fromPage).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fromPage).toHaveBeenCalledTimes(1);
    });

  it('refuses what Morning Global does not issue, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['QQ00000', 'SAMPLETRACKING', `${DELIVERED},${IN_TRANSIT}`, '0'.repeat(41), '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeMorningGlobalNumber(' qq 000-000-003 ph01 ')).toBe(NO_HISTORY);
  });

  it('tries a read that hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number Morning Global does not issue', async () => {
    const answers = [fixture('delivered'), fixture('not-found')];
    const fetcher = site(() => json(answers.shift()));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-05-18T18:02:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('QQ-00')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('routes a number filed under Morning Global to the adapter', async () => {
    const fetcher = site(() => json(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'morning-global' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'morning-global', source: 'morning-global', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === MORNING_GLOBAL_API)).toBe(true);
  });
});

describe('Morning Global status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      if (!entry.stage) {
        expect(morningGlobalMappedStage(entry.wording.toLowerCase()), entry.wording).toBeUndefined();
        continue;
      }
      expect(statusMapAnswer({ carrier: 'morning-global', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(morningGlobalStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('stages a status with a longer description by its status and leaves an unknown wording to the shared rules', () => {
    expect(statusMap.stage(null, 'handed over for delivery: parcel handed to the local partner')).toBe('in_transit');
    expect(statusMap.stage(null, 'returned to sender')).toBeUndefined();
    expect(morningGlobalMappedStage('Delivered')).toBeUndefined();
    expect(morningGlobalStage('Returned to sender')).toEqual({ stage: 'returned', source: 'wording:language' });
    expect(morningGlobalStage('Synthetic note')).toBeNull();
  });
});
