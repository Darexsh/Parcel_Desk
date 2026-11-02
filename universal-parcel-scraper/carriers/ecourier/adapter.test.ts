import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { UpstreamNetworkError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ecourierPageUrl, EcourierTracker } from './adapter.js';
import { normalizeEcourierNumber, parseEcourier } from './parser.js';
import { ecourierStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'ECR1000000000000001';
const IN_TRANSIT = 'ECR1000000000000002';
const UNKNOWN = 'ECR1000000000000000';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const page = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const answering = (body: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => body());
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const BLOCKED = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const status = (wording: string) => fixture('in-transit').replace('<b>In Transit</b>', `<b>${wording}</b>`);

describe('eCourier HTTP adapter', () => {
  it('opens the tracking page for the whole ID, once, through the supplied transport', async () => {
    const fetcher = answering(() => page(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new EcourierTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' ecr 1000-0000-0000-0001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://ecourier.com.bd/tracking/?tracking_no=${DELIVERED}`);
    expect(ecourierPageUrl(DELIVERED)).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ecourier', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered parcel newest first in Dhaka time, once per scan, without staff, riders or addresses', () => {
    const result = parseEcourier(fixture('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-04T15:05:00+06:00', expected_delivery: null,
      service_name: 'Standard', delivered_at: '2026-03-04T15:05:00+06:00',
      events: [
        { time: '2026-03-04T15:05:00+06:00', description: 'Delivered', location: 'Riverside Branch (D90) - Dhaka - RIVERSIDE 3',
          stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2026-03-04T10:12:00+06:00', description: 'On the way to Delivery', location: 'Riverside Branch (D90) - Dhaka - RIVERSIDE 3',
          stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2026-03-04T09:40:00+06:00', description: 'Delivery Agent Assigned', location: 'Riverside Branch (D90) - Dhaka',
          stage: 'in_transit', stage_source: 'carrier_map' },
        // The page lists this hub scan twice.
        { time: '2026-03-04T09:31:00+06:00', description: 'In Destination Hub', location: 'Riverside Branch (D90) - Dhaka',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-03-04T06:15:00+06:00', description: 'Sent to Destination Hub', location: 'In transit to Riverside Branch (D90) - Dhaka',
          stage: 'in_transit', stage_source: 'carrier_map' },
        // This day writes its labels outside the bold values.
        { time: '2026-03-02T23:20:00+06:00', description: 'Parcel process by Fulfillment', location: 'Fulfillment',
          stage: 'accepted', stage_source: 'carrier_map' },
        { time: '2026-03-02T17:55:00+06:00', description: 'Initiated', location: 'Hilltop Branch (D91) - Dhaka',
          stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/Synthetic|SYNTHETIC|0170|Example|Fullfillemnt|\(riverside\)|Elapsed/);
  });

  it('reads a parcel in transit through the adapter', async () => {
    const result = await carrier(answering(() => page(fixture('in-transit')))).track({ number: IN_TRANSIT });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: '2026-03-10T08:05:00+06:00',
      last_status_text: 'In Transit', service_name: 'Standard' });
    expect(result.events!.map((event) => [event.description, event.stage, event.location ?? null])).toEqual([
      ['In Transit', 'in_transit', 'In transit to Seaside Branch (C20) - Chattogram'],
      ['In Source Branch', 'in_transit', 'Hilltop Branch (D91) - Dhaka'],
      ['Picked Up', 'accepted', 'Hilltop Branch (D91) - Dhaka'],
      ['Initiated API', 'registered', null],
    ]);
    expect(result).not.toHaveProperty('delivered_at');
    expect(JSON.stringify(result)).not.toMatch(/Synthetic|0180/);
  });

  it('keeps phone numbers out of a status and stages wording the map does not know by the shared rules', () => {
    expect(parseEcourier(status('Hold (call 01700000000)'), IN_TRANSIT).events![0]).toMatchObject({ description: 'Hold (call)' });
    expect(parseEcourier(status('Hold, rider (01700000000)'), IN_TRANSIT).events![0]).toMatchObject({ description: 'Hold, rider' });
    expect(parseEcourier(status('Returned to Merchant'), IN_TRANSIT)).toMatchObject({
      current_stage: 'returned', current_stage_source: expect.stringMatching(/^wording:/) });
    const unclear = parseEcourier(status('Xyzzy'), IN_TRANSIT);
    expect(unclear).toMatchObject({ last_status_text: 'Xyzzy', current_stage: 'in_transit' });
    expect(unclear.events![0]).not.toHaveProperty('stage');
  });

  it('reads the page’s notice as not found and a result without scans as no history', async () => {
    expect(() => parseEcourier(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(answering(() => page(fixture('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    const empty = fixture('in-transit').replace(/<div class="track-info">[\s\S]*?<a class="common-btn"/, '<a class="common-btn"');
    expect(() => parseEcourier(empty, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('refuses a page for another ID', () => {
    expect(() => parseEcourier(fixture('delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseEcourier(fixture('delivered').replace(`<strong> ${DELIVERED}</strong>`, `<strong> ${DELIVERED}0</strong>`), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a changed page and reads a bot check as a challenge', () => {
    const delivered = fixture('delivered');
    for (const changed of [
      delivered.replace('class="track-content"', 'class="results"'),
      delivered.replace(`<strong> ${DELIVERED}</strong>`, '<strong></strong>'),
      delivered.replace('Wednesday, March 4 2026', 'Tuesday, March 4 2026'),
      delivered.replace('Wednesday, March 4 2026', '2026-03-04'),
      delivered.replace('<h4>3:05 pm</h4>', '<h4>15:05 pm</h4>'),
      delivered.replace('<h4>3:05 pm</h4>', '<h4></h4>'),
      delivered.replace('<b>Delivered</b>', '<b></b>'),
      `${delivered.replace('</section>', '')}${delivered}`,
      fixture('not-found').replace('No Result Found', 'Something went wrong'),
      '<html><body><h1>Internal Server Error</h1></body></html>',
    ]) expect(() => parseEcourier(changed, DELIVERED), changed.slice(0, 200)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseEcourier(BLOCKED, DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('keeps blocks, rate limits and moved routes apart from a missing parcel', async () => {
    const lookup = (answer: () => Response) => carrier(answering(answer)).track({ number: DELIVERED });
    await expect(lookup(() => page(BLOCKED))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => page('Forbidden', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => page('Too many requests', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    // The page reads a missing parcel from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup(() => page('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => page('', { status: 301, headers: { Location: '/tracking/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => page('<html><body>Internal Server Error</body></html>', { status: 500 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(() => page('', { status: 503 }))).rejects.toMatchObject({ kind: 'maintenance' });
  });

  it('asks once more when eCourier cannot be reached, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(page(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new EcourierTracker({ fetcher: flaky, recorder }).fetch(DELIVERED, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
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

  it('rejects what is not an ID its tracking form takes, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'ECR', 'ECR1234567', 'ECR12345678A', 'ECR1%', 'BL12345678', 'XY100000000000', '1000000000000001', `ECR${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeEcourierNumber('ecr 1000 0000 0000 0001')).toBe(DELIVERED);
    expect(normalizeEcourierNumber('ECR12345678')).toBe('ECR12345678');
    expect(normalizeEcourierNumber('bl-a1b2c3d4e')).toBe('BLA1B2C3D4E');
  });

  it('recognizes a known ID and an unknown one', async () => {
    await expect(carrier(answering(() => page(fixture('delivered')))).recognize!(DELIVERED))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-03-04T09:05:00.000Z' });
    await expect(carrier(answering(() => page(fixture('not-found')))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('1234567890')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(carrier(answering(() => page(BLOCKED))).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('answers an ID detected as eCourier’s or opened from its tracking page’s address', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url) === ecourierPageUrl(DELIVERED)
      ? page(fixture('delivered')) : page('', { status: 404 }));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    const answer = await tracker.track({ number: DELIVERED, carrier: 'ecourier' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'ecourier', source: 'ecourier', result: { current_stage: 'delivered' } });
    for (const link of [`https://ecourier.com.bd/tracking?tracking_no=${DELIVERED}`, `https://www.ecourier.com.bd/tracking/?tracking_no=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'ecourier' });
    }
  });
});

describe('eCourier status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording), entry.wording).toBe(entry.stage);
      expect(ecourierStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'ecourier', description: 'In Destination Hub' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'ecourier', description: 'Xyzzy' })).toEqual({ kind: 'unknown' });
  });
});
