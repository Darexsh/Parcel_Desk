import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ONE_WORLD_EXPRESS_ENDPOINT, OneWorldExpressTracker } from './adapter.js';
import { normalizeOneWorldExpressNumber, oneWorldExpressWording, parseOneWorldExpress } from './parser.js';
import { oneWorldExpressStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

// Synthetic One World Express numbers.
const DELIVERED = 'OWE900000000001';
const TRANSIT = 'OWE900000000002';
const UNKNOWN = 'OWE000000000000';

const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookupUrl = (number: string) => `${ONE_WORLD_EXPRESS_ENDPOINT}?tracking_number=${number}`;
const summary = (result: ReturnType<typeof parseOneWorldExpress>) => result.events!.map((event) =>
  [event.local_time, event.location ?? null, event.description, event.provider_code ?? null, event.stage ?? null]);
// A block page a firewall in front of the site could serve with HTTP 200.
const BLOCK = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('One World Express HTTP adapter', () => {
  it('asks SmartTrack\'s page for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html(page('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new OneWorldExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' owe 9000 0000 0002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(lookupUrl(TRANSIT));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'one-world-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery with its service, destination and the delivering carrier\'s number, once per scan', () => {
    const result = parseOneWorldExpress(page('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-03-06T18:20:00', expected_delivery: null,
      service_name: 'OWE FLIGHT', destination_country: 'US', delivery_tracking_number: '9200190000000000000016' });
    expect(summary(result)).toEqual([
      // Who signed and the driver's phone are dropped.
      ['2026-03-06T18:20:00', 'SAMPLETOWN', 'Delivered', 'Delivered', 'delivered'],
      ['2026-03-06T10:05:00', 'SAMPLETOWN', 'Out for delivery, driver', 'Out for delivery', 'out_for_delivery'],
      // The repeated arrival is kept once.
      ['2026-03-05T22:10:00', 'SAMPLE CITY HUB', 'Arrived at Destination Hub', 'Arrived', 'in_transit'],
      ['2026-03-03T04:30:00', 'NEW SAMPLE', 'Departed from Origin Facility', 'In Transit', 'in_transit'],
      ['2026-03-03T01:15:00', 'NEW SAMPLE', 'Arrived at Origin Facility', 'Carrier Received', 'in_transit'],
      // The Status label decides: the shared rules would read the hand-over as an acceptance.
      ['2026-03-03T01:14:00', 'Sample Village', 'Shipment Handed Over', 'In Transit', 'in_transit'],
      ['2026-03-02T09:00:00', 'Sample Service Centre - IND', 'Arrived at Sort Facility Sample Service Centre - IND', 'Arrived', 'in_transit'],
      ['2026-03-01T23:45:00', 'Sample Service Centre - IND', 'Data Received', 'Data Received', 'registered'],
    ]);
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
    // A label the map does not know falls to the shared rules on the description.
    expect(result.events![1]).toMatchObject({ stage_source: 'wording:language' });
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE PERSON|000 0000|10000001|000-00000000S|India|transit time|\.jpg/);
  });

  it('hands the parcel to the carrier whose number the page names', () => {
    expect(deliveryHandoff('one-world-express', DELIVERED, parseOneWorldExpress(page('delivered'), DELIVERED)))
      .toEqual({ carrier: 'usps', number: '9200190000000000000016', basis: 'reference' });
  });

  it('reads a parcel in transit by its newest scan with a stage, without its own number as a partner\'s', () => {
    const result = parseOneWorldExpress(page('in-transit'), TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Manifest Update', last_update_local: '2026-10-14T08:15:00', service_name: 'OWE ECONOMY', destination_country: 'GB' });
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(summary(result)).toEqual([
      // Neither the label nor the description says what this scan moved.
      ['2026-10-14T08:15:00', 'SAMPLE GATEWAY', 'Manifest Update', 'Relabel', null],
      ['2026-10-14T07:50:00', 'SAMPLE GATEWAY', 'Arrived at Destination Hub', 'Arrived', 'in_transit'],
      ['2026-10-13T23:05:00', 'SAMPLE PORT', 'Departed from Origin Facility', 'In Transit', 'in_transit'],
      ['2026-10-13T19:40:00', 'SAMPLE PORT', 'Shipment Handed Over', 'In Transit', 'in_transit'],
      ['2026-10-12T11:30:00', null, 'Data Received', 'Data Received', 'registered'],
    ]);
  });

  it('keeps a destination it cannot name as a country, and the HAWB out of the partner\'s number', () => {
    const result = parseOneWorldExpress(page('in-transit').replace('United Kingdom', 'Sampleland')
      .replace(`<span>${TRANSIT}</span>`, '<span>10000002</span>'), TRANSIT);
    expect(result).toMatchObject({ destination_country_name: 'Sampleland' });
    expect(result).not.toHaveProperty('destination_country');
    expect(result).not.toHaveProperty('delivery_tracking_number');
  });

  it('drops who signed, phones and e-mail addresses from a description', () => {
    expect(oneWorldExpressWording('Delivered, signed by Sample Person')).toBe('Delivered');
    expect(oneWorldExpressWording('Delivered - received by Sample Person at 12 Sample Street')).toBe('Delivered');
    expect(oneWorldExpressWording('Contact sample@example.com or +44 0000 000000 to rebook')).toBe('Contact or to rebook');
    expect(oneWorldExpressWording('Arrived at Sort Facility Sample Centre - IND')).toBe('Arrived at Sort Facility Sample Centre - IND');
    // The signatory or driver a cell sets off in its own element is dropped with it.
    const result = parseOneWorldExpress(page('delivered').replace('Delivered, signed by SAMPLE PERSON',
      'Delivered <i>SAMPLE PERSON</i> <a href="https://example.com/pod.jpg">Signature Image</a>'), DELIVERED);
    expect(result.events![0]).toMatchObject({ description: 'Delivered' });
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE PERSON|Signature|example\.com/);
  });

  it('reads the page\'s notice for an unknown number as not found, and nothing else', () => {
    expect(() => parseOneWorldExpress(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseOneWorldExpress(page('not-found').replace('No Tracking available.', 'Service unavailable, please try later.'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseOneWorldExpress(page('not-found').replace('<p>No Tracking available.</p>', ''), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('binds the page to the whole number asked', () => {
    expect(() => parseOneWorldExpress(page('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'One World Express answered for another number' }));
    // The parcel image is named after the parcel's own number.
    expect(() => parseOneWorldExpress(page('delivered').replace(`20260301/${DELIVERED}.jpg`, `20260301/${TRANSIT}.jpg`), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'One World Express answered for another parcel' }));
    expect(() => parseOneWorldExpress(page('delivered').replace(/<input[^>]*name="tracking_number"[^>]*>/, ''), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseOneWorldExpress(page('delivered').replace(`value="${DELIVERED}"`, `value="${DELIVERED.toLowerCase()}"`), DELIVERED).events)
      .toHaveLength(8);
  });

  it('reads a parcel page without scans as no history', () => {
    const empty = page('in-transit').replace(/(<\/tr>\s*)<tr>\s*<th colspan="4">[\s\S]*<\/tbody>/, '$1</tbody>');
    expect(() => parseOneWorldExpress(empty, TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects a changed page', () => {
    for (const change of [
      (body: string) => body.replace('<td width="90">08:15</td>', '<td width="90">8.15 am</td>'),
      (body: string) => body.replace('<td width="90">08:15</td>', '<td width="90">24:00</td>'),
      // A weekday that does not fit the date.
      (body: string) => body.replace('Wednesday, October 14, 2026', 'Thursday, October 14, 2026'),
      (body: string) => body.replace('Wednesday, October 14, 2026', '14/10/2026'),
      (body: string) => body.replace(/<td>\s*Relabel\s*<\/td>/, ''),
      // A scan before any day heading.
      (body: string) => body.replace(/<tr>\s*<th colspan="4">Wednesday, October 14, 2026<\/th>\s*<\/tr>/, ''),
      (body: string) => body.replace(/<td>\s*SAMPLE GATEWAY\s*<\/td>\s*<td>\s*Manifest Update\s*<\/td>\s*<td>\s*Relabel\s*<\/td>/,
        '<td></td><td></td><td></td>'),
      (body: string) => body.replace('</table>', '</table><table><thead><tr><th>Tracking Events</th></tr></thead></table>'),
      (body: string) => body.replace(/class="portlet-body"/, 'class="portlet"'),
      (body: string) => body.replace('<tbody>', `<tbody>${'<tr><td>1</td></tr>'.repeat(601)}`),
    ]) {
      expect(() => parseOneWorldExpress(change(page('in-transit')), TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a refusal, a block page, a rate limit and a broken page apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(html(body, init))).track({ number: UNKNOWN });
    await expect(lookup(page('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page answers every number with HTTP 200: a 404 is a moved route and a redirect another page.
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.smarttrack.co/index.php' } })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(BLOCK)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(BLOCK, { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('Too Many Requests', { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '10' } }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 10_000 });
    await expect(lookup('<html><title>SmartTrack</title><body>Home</body></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the not-found notice, and asks nothing for a number One World Express does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(html(page('delivered')))
      .mockResolvedValueOnce(html(page('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-06T18:20:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('9200190000000000000016')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('tries once more after a failure to reach SmartTrack, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(html(page('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new OneWorldExpressTracker({ fetcher, recorder }).fetch(TRANSIT, { budgetMs: 2000 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'one-world-express', step: 'retry', outcome: 'ok' }));
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
    await clock.settle(expect(carrier(fetcher).track({ number: TRANSIT }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects numbers One World Express does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['OWE90000000001', 'OWE9000000000011', 'OWX900000000001', 'T01ZAA0000000000', '9200190000000000000016', `OWE${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeOneWorldExpressNumber(' owe-9000-0000-0002 ')).toBe(TRANSIT);
  });

  it('routes a number filed under One World Express, detected as one, or in a SmartTrack link, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url).startsWith(ONE_WORLD_EXPRESS_ENDPOINT)
      ? html(page('delivered')) : new Response('', { status: 404 })));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'one-world-express' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'one-world-express', source: 'one-world-express', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'one-world-express', source: 'one-world-express' });
    expect(fetcher.mock.calls.some(([url]) => String(url) === lookupUrl(DELIVERED))).toBe(true);
    expect(parseTrackingInput(`https://www.smarttrack.co/tracking.php?tracking_number=${DELIVERED}`))
      .toMatchObject({ trackingNumber: DELIVERED, carrier: 'one-world-express' });
    // SmartTrack also finds a parcel by its delivering carrier's number, which stays that carrier's.
    expect(parseTrackingInput('https://www.smarttrack.co/tracking.php?tracking_number=9200190000000000000016').carrier)
      .not.toBe('one-world-express');
  });
});

describe('One World Express numbers', () => {
  it('claims OWE and twelve digits, and nothing shorter or longer', () => {
    for (const number of [DELIVERED, TRANSIT, UNKNOWN]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'one-world-express', confidence: 'high' });
    }
    for (const number of ['OWE90000000001', 'OWE9000000000011']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('one-world-express');
    }
  });
});

describe('One World Express status vocabulary', () => {
  it('records every label the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string }[]) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(oneWorldExpressStage(entry.code, entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'one-world-express', providerCode: entry.code, description: entry.wording }))
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'one-world-express', providerCode: 'Relabel', description: 'Manifest Update' })).toEqual({ kind: 'unknown' });
    // A label the map does not know leaves the stage to the shared rules, description first.
    expect(oneWorldExpressStage('Customs clearance', 'Held for inspection')).toEqual({ stage: 'customs', source: 'wording:language' });
    expect(oneWorldExpressStage('Relabel', 'Manifest Update')).toBeNull();
    expect(oneWorldExpressStage('in transit', 'Shipment Handed Over')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
  });
});
