import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { UpstreamNetworkError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, BLUEEX_LOOKUP, BlueexTracker } from './adapter.js';
import { blueexWording, normalizeBlueexNumber, parseBlueex } from './parser.js';
import { blueexStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '4000000001';
const IN_TRANSIT = '4000000002';
const UNKNOWN = '4000000000';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const page = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html', ...init.headers } });
const answering = (body: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => body());
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const BLOCKED = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const scan = (line: string) => fixture('in-transit').replace('Shipment is on route to Quetta', line);

describe('BlueEX HTTP adapter', () => {
  it('posts the whole number to the tracking page’s lookup, once, through the supplied transport', async () => {
    const fetcher = answering(() => page(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new BlueexTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 4000-000-001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(BLUEEX_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'SyntheticHost/1.0' } });
    expect([...new URLSearchParams(String(init!.body))]).toEqual([['tracking_numbers[]', DELIVERED], ['type', 'blueex']]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'blueex', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered consignment newest first in Karachi time, once per scan, without who took it', () => {
    expect(parseBlueex(fixture('delivered'), DELIVERED)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-04T13:05:00+05:00', expected_delivery: null,
      delivered_at: '2026-03-04T13:05:00+05:00',
      events: [
        // The delivery and the round before it share a minute: the later line on the page comes first.
        { time: '2026-03-04T13:05:00+05:00', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2026-03-04T13:05:00+05:00', description: 'Out For Delivery', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2026-03-03T16:40:00+05:00', description: 'Unsuccessful attempted due to - Customer Not Available',
          stage: 'failed_attempt', stage_source: 'carrier_map' },
        { time: '2026-03-03T10:15:00+05:00', description: 'Out For Delivery', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        // The page lists this station scan twice.
        { time: '2026-03-03T05:30:00+05:00', description: 'Shipment has reached blueEX Faisalabad Warehouse - Faisalabad',
          location: 'Faisalabad', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-03-02T20:10:00+05:00', description: 'Shipment is on route to Faisalabad', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-03-02T18:45:00+05:00', description: 'Shipment reached blueEX Multan Operations, Multan',
          location: 'Multan', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-03-02T11:20:00+05:00', description: 'Order information received, pending at Shipper\'s end.',
          stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    expect(JSON.stringify(parseBlueex(fixture('delivered'), DELIVERED))).not.toMatch(/Sana|Synthetic/);
  });

  it('reads a consignment in transit through the adapter', async () => {
    const result = await carrier(answering(() => page(fixture('in-transit')))).track({ number: IN_TRANSIT });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: '2026-03-10T21:05:00+05:00',
      last_status_text: 'Shipment is on route to Quetta' });
    expect(result.events!.map((event) => [event.stage, event.location ?? null])).toEqual([
      ['in_transit', null], ['in_transit', 'Karachi'], ['registered', null]]);
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('keeps who took the parcel and phone numbers out of wording', () => {
    expect(blueexWording('Delivered to delivered to customer')).toBe('Delivered');
    expect(blueexWording('Shipment has been delivered to Synthetic Name .')).toBe('Shipment has been delivered');
    expect(blueexWording('Out For Delivery, rider 0300-1234567')).toBe('Out For Delivery, rider');
    expect(blueexWording('Call +92 300 1234567 or 021-111-000-000 for help')).toBe('Call or for help');
    expect(blueexWording('Shipment reached BlueEx Head Office - Karachi.')).toBe('Shipment reached BlueEx Head Office - Karachi.');
    const html = scan('Unsuccessful attempted due to - Customer asked to call 03001234567');
    expect(JSON.stringify(parseBlueex(html, IN_TRANSIT))).not.toMatch(/1234567/);
    // The former tracker's station scan ends with a full stop.
    expect(parseBlueex(scan('Shipment reached BlueEx Head Office - Karachi.'), IN_TRANSIT).events![0]).toMatchObject({ location: 'Karachi' });
  });

  it('stages wording the map does not know by the shared rules', () => {
    expect(parseBlueex(scan('Shipment returned to shipper'), IN_TRANSIT)).toMatchObject({
      current_stage: 'returned', current_stage_source: expect.stringMatching(/^wording:/) });
    const unclear = parseBlueex(scan('Xyzzy'), IN_TRANSIT);
    expect(unclear).toMatchObject({ last_status_text: 'Xyzzy', current_stage: 'in_transit' });
    expect(unclear.events![0]).not.toHaveProperty('stage');
  });

  it('reads a block without scans as no history and an empty reply as inconclusive', async () => {
    expect(() => parseBlueex(fixture('no-history'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    await expect(carrier(answering(() => page(fixture('no-history')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'indeterminate' });
    // The page reports an empty reply as no tracking information; it is the answer to inputs the lookup does not take too.
    for (const body of ['', '\n  ']) {
      expect(() => parseBlueex(body, 'CP000000000001')).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'IndeterminateError' }));
    }
  });

  it('refuses a reply for another number or for several numbers', () => {
    expect(() => parseBlueex(fixture('delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBlueex(fixture('no-history'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const labelled = fixture('delivered').replace(`Label : ${DELIVERED}`, `Label : ${IN_TRANSIT}`);
    expect(() => parseBlueex(labelled, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBlueex(`${fixture('in-transit')}${fixture('delivered')}`, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('refuses a changed reply and reads a bot check as a challenge', () => {
    const delivered = fixture('delivered');
    for (const changed of [
      delivered.replace(/trackingInformation/g, 'results'),
      delivered.replace(`>${DELIVERED}</span>`, '></span>'),
      delivered.replace('BlueEX Shipping Label', 'Shipping Label'),
      delivered.replace('Mar 2nd, 2026(11:20 AM)', '2026-03-02 11:20'),
      delivered.replace('Mar 2nd, 2026(11:20 AM)', 'Mar 2rd, 2026(11:20 AM)'),
      delivered.replace('Mar 2nd, 2026(11:20 AM)', 'Feb 30th, 2026(11:20 AM)'),
      delivered.replace('Mar 2nd, 2026(11:20 AM)', 'Mar 2nd, 2026(13:20 PM)'),
      delivered.replace(' - Out For Delivery</p>', ' - </p>'),
      '<html><body><h1>Internal Server Error</h1></body></html>',
    ]) expect(() => parseBlueex(changed, DELIVERED), changed.slice(-120)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBlueex(BLOCKED, DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('keeps blocks, rate limits and moved routes apart from a missing consignment', async () => {
    const lookup = (answer: () => Response) => carrier(answering(answer)).track({ number: DELIVERED });
    await expect(lookup(() => page(BLOCKED))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => page('Forbidden', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => page('Too many requests', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    // The lookup reads a missing consignment from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup(() => page('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => page('', { status: 302, headers: { Location: '/tracking' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => page('<html><body>Internal Server Error</body></html>', { status: 500 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(() => page('', { status: 503 }))).rejects.toMatchObject({ kind: 'maintenance' });
  });

  it('asks once more when BlueEX cannot be reached, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(page(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new BlueexTracker({ fetcher: flaky, recorder }).fetch(DELIVERED, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
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

  it('rejects what is not a number its tracking box takes, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '400000000', '40000000001', '3999999999', '7000000000', 'CP00000000001', 'CX000000000001', '0'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeBlueexNumber('6999 999 999')).toBe('6999999999');
    expect(normalizeBlueexNumber('cp-0000 0000 0001')).toBe('CP000000000001');
  });

  it('recognizes a known number and leaves a block without scans inconclusive', async () => {
    await expect(carrier(answering(() => page(fixture('delivered')))).recognize!(DELIVERED))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-03-04T08:05:00.000Z' });
    await expect(carrier(answering(() => page(fixture('no-history')))).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'indeterminate' });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('1234567890')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(carrier(answering(() => page(BLOCKED))).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('answers a number filed under BlueEX or opened from its tracking page’s addresses', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url) === BLUEEX_LOOKUP
      ? page(fixture('delivered')) : page('', { status: 404 }));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    const answer = await tracker.track({ number: DELIVERED, carrier: 'blueex' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'blueex', source: 'blueex', result: { current_stage: 'delivered' } });
    for (const link of [`https://www.blue-ex.com/tracking?trackno=${DELIVERED}`, `https://blue-ex.com/tracking.php?cn=${DELIVERED}`,
      `https://www.blue-ex.com/index.php?trackno=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'blueex' });
    }
  });
});

describe('BlueEX status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording), entry.wording).toBe(entry.stage);
      expect(blueexStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'blueex', description: 'Shipment reached blueEX Quetta Operations, Quetta' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'blueex', description: 'Xyzzy' })).toEqual({ kind: 'unknown' });
  });
});
