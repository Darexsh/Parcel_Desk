import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { UpstreamNetworkError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, M_AND_P_TRACKING, MAndPTracker } from './adapter.js';
import { mAndPSentence, normalizeMAndPNumber, parseMAndP } from './parser.js';
import { mAndPStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '100000000000001';
const IN_TRANSIT = '100000000002';
const ATTEMPTED = '100000000000003';
const UNKNOWN = '100000000000000';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const page = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const answering = (body: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => body());
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cZone:"www.mulphilog.com"}</script></body></html>';
// The scans of a page, in the order the page lists them.
const stepsOf = (html: string): string[] => [...html.match(/ {52}<div class="order-track-step[\s\S]*?\n {28}<\/div>/g)!];
const withSteps = (html: string, steps: string[]) => html.replace(stepsOf(html).join('\n'), steps.join('\n'));

describe('M&P HTTP adapter', () => {
  it('opens the tracker’s page for the whole number, once, through the supplied transport', async () => {
    const fetcher = answering(() => page(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new MAndPTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 100000 000000 001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${M_AND_P_TRACKING}${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'm-and-p', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered consignment newest first in Karachi time, once per scan, without who took it', () => {
    const result = parseMAndP(fixture('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'The shipment has been delivered at the consignee\'s address',
      last_update: '2026-02-12T16:05:00+05:00', expected_delivery: null, delivered_at: '2026-02-12T16:05:00+05:00',
      events: [
        { time: '2026-02-12T16:05:00+05:00', description: 'The shipment has been delivered at the consignee\'s address', location: 'SOUTHPORT',
          provider_code: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' },
        // The page lists this scan twice.
        { time: '2026-02-12T09:40:00+05:00', location: 'SOUTHPORT', provider_code: 'Out-for-Delivery', stage: 'out_for_delivery', stage_source: 'carrier_map',
          description: 'The shipment has been scheduled for delivery. Please keep your mobile on and prepare the exact amount for COD transaction' },
        { time: '2026-02-11T03:02:00+05:00', description: 'The shipment has been arrived at the destination city and will be scheduled for delivery',
          location: 'SOUTHPORT', provider_code: 'Reached at Destination', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-02-09T20:15:00+05:00', description: 'The shipment has been dispatched and is on its way to the destination city',
          location: 'NORTHVILLE', provider_code: 'In-transit', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-02-09T18:30:00+05:00', description: 'The shipment has been arrived at M&P operations at the origin hub and will be scheduled for transit',
          location: 'NORTHVILLE', provider_code: 'Arrived at OPS Facility', stage: 'accepted', stage_source: 'carrier_map' },
        { time: '2026-02-09T12:10:00+05:00', description: 'Your order has been placed. It will be packed and prepared for shipment.',
          location: 'NORTHVILLE', provider_code: 'Booked', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    // Names, cities of the booking and the order reference are not read.
    expect(JSON.stringify(result)).not.toMatch(/Fictive|Northville|Southport|SYN0001/);
  });

  it('reads a twelve-digit consignment in transit through the adapter', async () => {
    const result = await carrier(answering(() => page(fixture('in-transit')))).track({ number: IN_TRANSIT });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: '2026-03-01T06:45:00+05:00',
      last_status_text: 'The shipment has been dispatched and is on its way to the destination city' });
    expect(result.events!.map((event) => [event.location, event.stage])).toEqual([['MIDVALE', 'in_transit'], ['WESTBROOK', 'in_transit'], ['WESTBROOK', 'registered']]);
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('reads a failed attempt with its reason and the line under it, and a scan without a city', () => {
    const result = parseMAndP(fixture('attempted'), ATTEMPTED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map',
      last_status_text: 'An attempt to deliver your shipment failed due to: Consignee not available. Delivery will be rescheduled on next working day.' });
    expect(result.events![2]).toEqual({ time: '2026-03-01T23:48:00+05:00', provider_code: 'Reached at Destination', stage: 'in_transit', stage_source: 'carrier_map',
      description: 'The shipment has been arrived at the destination city and will be scheduled for delivery' });
  });

  it('orders scans by their clocks and keeps the page’s order within a minute', () => {
    const html = fixture('delivered');
    const steps = stepsOf(html);
    expect(parseMAndP(withSteps(html, [...steps].reverse()), DELIVERED)).toEqual(parseMAndP(html, DELIVERED));
    const shuffled = parseMAndP(withSteps(html, [steps[5]!, steps[0]!, steps[6]!, steps[3]!]), DELIVERED);
    expect(shuffled.events!.map((event) => event.provider_code)).toEqual(['Delivered', 'Reached at Destination', 'Arrived at OPS Facility', 'Booked']);
  });

  it('keeps scans of one instant in the carrier’s order', () => {
    const html = fixture('delivered');
    const steps = stepsOf(html);
    const oldestFirst = withSteps(html, [steps[6]!, steps[5]!, steps[4]!.replace('08:15 pm', '06:30 pm')]);
    expect(parseMAndP(oldestFirst, DELIVERED).events!.map((event) => event.provider_code)).toEqual(['In-transit', 'Arrived at OPS Facility', 'Booked']);
  });

  it('stages a label the map does not know by its wording, else leaves it without a stage', () => {
    const returned = fixture('in-transit').replace('<p class="order-track-text-stat status">In-transit</p>', '<p class="order-track-text-stat status">Returned to Shipper</p>')
      .replace('The shipment has been dispatched and is on its way to the  destination city', 'The shipment has been returned to the shipper');
    expect(parseMAndP(returned, IN_TRANSIT)).toMatchObject({ current_stage: 'returned', current_stage_source: expect.stringMatching(/^wording:/) });
    const unclear = fixture('in-transit').replace('<p class="order-track-text-stat status">In-transit</p>', '<p class="order-track-text-stat status">Xyzzy</p>')
      .replace('The shipment has been dispatched and is on its way to the  destination city', 'Plugh');
    expect(parseMAndP(unclear, IN_TRANSIT)).toMatchObject({ last_status_text: 'Plugh', current_stage: 'in_transit' });
    expect(parseMAndP(unclear, IN_TRANSIT).events![0]).toEqual(expect.objectContaining({ description: 'Plugh', provider_code: 'Xyzzy' }));
    expect(parseMAndP(unclear, IN_TRANSIT).events![0]).not.toHaveProperty('stage');
    // A scan without a sentence is described by its label.
    const bare = fixture('in-transit').replace('The shipment has been dispatched and is on its way to the  destination city', '');
    expect(parseMAndP(bare, IN_TRANSIT).events![0]).toMatchObject({ description: 'In-transit', stage: 'in_transit' });
  });

  it('takes who took the parcel, phone numbers and amounts out of a sentence', () => {
    expect(mAndPSentence('The shipment has been delivered at the consignee\'s address and has been received by Fictive Signer 12'))
      .toBe('The shipment has been delivered at the consignee\'s address');
    expect(mAndPSentence('Shipment delivered, signed by FICTIVE SIGNER')).toBe('Shipment delivered');
    expect(mAndPSentence('Rider will call you from 0300-0000000, keep Rs. 1,250 ready')).toBe('Rider will call you from, keep ready');
    expect(mAndPSentence('Arrived at hub on 12 Feb 2026')).toBe('Arrived at hub on 12 Feb 2026');
  });

  it('reads the tracker’s notice as not found', async () => {
    expect(() => parseMAndP(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(answering(() => page(fixture('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('refuses a page opened for another number', () => {
    expect(() => parseMAndP(fixture('delivered'), ATTEMPTED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseMAndP(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseMAndP(fixture('delivered').replace(`value="${DELIVERED}" required`, `value="${DELIVERED}0" required`), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a changed page, reads an empty result as no history and a bot check as a challenge', () => {
    const delivered = fixture('delivered');
    for (const changed of [
      delivered.replace('id="orderTrackSection"', 'id="results"'),
      delivered.replace('id="consignmentInput"', 'id="consignment"'),
      delivered.replace(`value="${DELIVERED}" required`, 'value="" required'),
      delivered.replace('04:05 pm', '16:05'),
      delivered.replace('04:05 pm', '13:05 pm'),
      delivered.replace('12 Feb 2026 <br>\n                                        04:05 pm', '30 Feb 2026 <br>\n                                        04:05 pm'),
      delivered.replace('12 Feb 2026 <br>\n                                        04:05 pm', '2026-02-12 <br>\n                                        04:05 pm'),
      delivered.replace('<p class="order-track-text-stat status">Booked</p>', ''),
      delivered.replace('<p class="order-track-text-stat status">Booked</p>', '<p class="order-track-text-stat status"></p>')
        .replace('Your order has been placed. It will be packed and prepared for shipment.', ''),
      '<html><body><h1>Internal Server Error</h1></body></html>',
      '',
    ]) expect(() => parseMAndP(changed, DELIVERED), changed.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // A result without scans that is not the tracker's notice.
    expect(() => parseMAndP(fixture('not-found').replace('No tracking record found with the provided consignment number.', 'Something else'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMAndP(withSteps(delivered, []), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseMAndP(CLOUDFLARE, DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('keeps blocks, rate limits and moved routes apart from a missing consignment', async () => {
    const lookup = (answer: () => Response) => carrier(answering(answer)).track({ number: DELIVERED });
    await expect(lookup(() => page(CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => page('Forbidden', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => page('Too many requests', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    // The tracker reads a missing consignment from a 200 page: a 404 or a redirect is a moved route.
    await expect(lookup(() => page('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => page('', { status: 302, headers: { Location: '/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => page('<html><body>Server Error</body></html>', { status: 500 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(() => page('', { status: 503 }))).rejects.toMatchObject({ kind: 'maintenance' });
  });

  it('asks once more when M&P cannot be reached, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(page(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new MAndPTracker({ fetcher: flaky, recorder }).fetch(DELIVERED, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(failing).track({ number: DELIVERED }, { budgetMs: 2000 })).rejects.toBeInstanceOf(UpstreamNetworkError);
    expect(failing).toHaveBeenCalledTimes(2);
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
    await clock.settle(expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects what is not a number it issues, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '1234567', '10000000001', '1000000000000001', 'AB1000000000001', '0'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeMAndPNumber('1000-0000-0002')).toBe(IN_TRANSIT);
  });

  it('recognizes a known number and not an unknown one', async () => {
    await expect(carrier(answering(() => page(fixture('delivered')))).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-02-12T11:05:00.000Z' });
    await expect(carrier(answering(() => page(fixture('not-found')))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('1234567')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(carrier(answering(() => page(CLOUDFLARE))).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('answers a number filed under M&P or opened from its tracker’s address', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).startsWith(M_AND_P_TRACKING)
      ? page(fixture('delivered')) : page('', { status: 404 }));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    const answer = await tracker.track({ number: DELIVERED, carrier: 'm-and-p' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'm-and-p', source: 'm-and-p', result: { current_stage: 'delivered' } });
    for (const link of [`https://www.mulphilog.com/tracking/${DELIVERED}`, `https://mulphilog.com/tracking/${DELIVERED}/`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'm-and-p' });
    }
  });
});

describe('M&P status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording), entry.wording).toBe(entry.stage);
      expect(mAndPStage('', entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'm-and-p', providerCode: 'Out-for-Delivery', description: 'Anything' })).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'm-and-p', description: 'Xyzzy' })).toEqual({ kind: 'unknown' });
  });
});
