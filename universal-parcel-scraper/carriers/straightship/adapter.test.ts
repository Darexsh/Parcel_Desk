import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, StraightshipTracker, straightshipTrackingUrl } from './adapter.js';
import { normalizeStraightshipNumber, parseStraightship } from './parser.js';
import { statusMap, straightshipStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'STRTD123456789';
const IN_TRANSIT = 'STRCA1234560890124';
const ATTEMPTED = 'STRTD12345678901234567';
const RETURNED = 'STRCA0000000000000';
const UNKNOWN = 'STRTD000000000';
// A Monday morning in Vancouver, after every fixture's rows.
const NOW = Date.parse('2026-10-19T16:00:00Z');

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const page = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A history row as the page writes it.
const row = (clock: string, wording: string, city = '') => `<tr>\n<td>${clock}</td>\n<td>${wording}</td>\n<td>${city}</td>\n</tr>`;
const withRows = (rows: string) => fixture('in-transit').replace(/(<thead>[\s\S]*?<\/thead>\s*<tbody>)[\s\S]*?(<\/tbody>)/, `$1${rows}$2`);
const withoutNote = (html: string) => html.replace(/<div class="alert-note">[\s\S]*?<\/div>/, '');
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:"managed"};</script></body></html>';

describe('Straightship HTTP adapter', () => {
  it('opens the tracking page for the whole number in capitals once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(page(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new StraightshipTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0', now: () => NOW })
      .fetch(' strtd 123-456-789 ', { budgetMs: 1000.5 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://www.straightship.com/track-your-shipment/tracking-id/${DELIVERED}/`);
    expect(straightshipTrackingUrl('strtd123456789')).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'straightship', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history newest first as UTC instants, with the place out of the wording', () => {
    const result = normalizeCarrierResult(parseStraightship(fixture('delivered'), DELIVERED, NOW));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-10-15T20:12:19Z', expected_delivery: null, delivered_at: '2026-10-15T20:12:19Z' });
    expect(result).not.toHaveProperty('timezone');
    expect(result.events!.map((event) => [event.time, event.description, event.location ?? null, event.stage ?? null])).toEqual([
      ['2026-10-15T20:12:19Z', 'Delivered', 'Testville, AB', 'delivered'],
      ['2026-10-15T16:45:01Z', 'Package will be delivered before 9:00pm', 'TESTVILLE, AB', 'out_for_delivery'],
      ['2026-10-15T11:20:33Z', 'Package is received at a Straightship station', 'Example City, AB', 'in_transit'],
      ['2026-10-14T21:05:10Z', 'Package is received at a Straightship station', 'Sampleton, BC', 'in_transit'],
      ['2026-10-14T21:05:10Z', 'Package Received with Origin Scan warehouse', 'Sampleton, BC', 'accepted'],
      ['2026-10-08T09:15:42Z', 'Package information is created in the system', null, 'registered'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.stage_source === 'carrier_map')).toBe(true);
  });

  it('keeps neither the summary’s codes nor the proof-of-delivery form', () => {
    const result = JSON.stringify(parseStraightship(fixture('delivered'), DELIVERED, NOW));
    expect(result).not.toMatch(/Client Code|Package ID|proof|po_val|Last Updated|Coordinated/i);
  });

  it('reads a parcel at a station as in transit, whatever the summary says', () => {
    const result = parseStraightship(fixture('in-transit'), IN_TRANSIT, NOW);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Package arrived at transit station',
      last_update: '2026-10-18T08:02:55Z' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events![0]).toEqual({ time: '2026-10-18T08:02:55Z', description: 'Package arrived at transit station',
      stage: 'in_transit', stage_source: 'carrier_map' });
  });

  it('keeps failed rounds, the attempt’s advice and both loading rows', () => {
    const result = parseStraightship(fixture('attempted'), ATTEMPTED, NOW);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Delivery is in progress' });
    expect(result.events!.map((event) => [event.time, event.description, event.location ?? null, event.stage])).toEqual([
      ['2026-10-17T02:30:00Z', 'Delivery is in progress', 'Example City, MB', 'in_transit'],
      ['2026-10-16T20:15:00Z', 'Attempted Delivery', null, 'failed_attempt'],
      ['2026-10-16T13:45:00Z', 'Package will be delivered before 9:00pm', 'Example City, MB', 'out_for_delivery'],
      ['2026-10-15T22:00:00Z', 'An attempt was made to deliver your package-unable to leave package at safe location '
        + '(please e-mail SS@straightship.com to make arrangement)', null, 'failed_attempt'],
      ['2026-10-15T14:00:00Z', 'Package will be delivered before 9:00pm', 'Example City, MB', 'out_for_delivery'],
      ['2026-10-15T12:40:12Z', 'Loading', null, 'in_transit'],
      ['2026-10-15T12:40:10Z', 'Loading', null, 'in_transit'],
      ['2026-10-15T09:30:00Z', 'Package is received at a Straightship station', 'Example City, MB', 'in_transit'],
      ['2026-10-13T04:10:20Z', 'Package is received at a Straightship station', 'Sampleton, ON', 'in_transit'],
      ['2026-10-13T04:10:20Z', 'Package Received with Origin Scan warehouse', 'Sampleton, ON', 'accepted'],
      ['2026-10-09T10:00:01Z', 'Package information is created in the system', null, 'registered'],
    ]);
  });

  it('reads a parcel on its way back as returned', () => {
    const result = parseStraightship(fixture('returned'), RETURNED, NOW);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Package is being returned to shipper',
      last_update: '2026-10-15T01:00:00Z' });
    expect(result.events!.slice(0, 3).map((event) => [event.description, event.location ?? null, event.stage])).toEqual([
      ['Package is being returned to shipper', null, 'returned'],
      ['Package is being returned to shipper', 'Example City, AB', 'returned'],
      ['Your order is in Progress', null, 'in_transit'],
    ]);
  });

  it('keeps the clocks as the page shows them without its UTC note, or with a row after the lookup', () => {
    const local = parseStraightship(withoutNote(fixture('delivered')), DELIVERED, NOW);
    expect(local).toMatchObject({ current_stage: 'delivered', last_update: null, last_update_local: '2026-10-15T20:12:19' });
    expect(local).not.toHaveProperty('delivered_at');
    expect(local.events!.every((event) => event.time === undefined && /^2026-10-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    // Fifteen minutes of clock skew are allowed.
    expect(parseStraightship(fixture('delivered'), DELIVERED, Date.parse('2026-10-15T20:00:00Z')).last_update).toBe('2026-10-15T20:12:19Z');
    const early = parseStraightship(fixture('delivered'), DELIVERED, Date.parse('2026-10-15T19:50:00Z'));
    expect(early).toMatchObject({ last_update: null, last_update_local: '2026-10-15T20:12:19' });
    expect(early.events!.every((event) => event.time === undefined)).toBe(true);
  });

  it('skips a row without wording, a repeated row, and a city with a digit; leaves unknown wording unstaged', () => {
    const result = parseStraightship(withRows(row('2026-10-16 10:00:00', 'Synthetic note', 'Sampleton')
      + row('2026-10-16 09:00:00', 'Package will be delivered before 9:00pm', '1 Sample St')
      + row('2026-10-16 09:00:00', 'Package will be delivered before 9:00pm', '1 Sample St')
      + row('2026-10-16 11:00:00', '', '')), IN_TRANSIT, NOW);
    expect(result).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Synthetic note', last_update: '2026-10-16T10:00:00Z' });
    expect(result.events).toEqual([
      { time: '2026-10-16T10:00:00Z', description: 'Synthetic note', location: 'Sampleton' },
      { time: '2026-10-16T09:00:00Z', description: 'Package will be delivered before 9:00pm', stage: 'out_for_delivery', stage_source: 'carrier_map' },
    ]);
    // A bracket that names no town and province stays in the wording.
    expect(parseStraightship(withRows(row('2026-10-16 10:00:00', 'Delivered (Left at door)')), IN_TRANSIT, NOW).events)
      .toEqual([{ time: '2026-10-16T10:00:00Z', description: 'Delivered (Left at door)', stage: 'delivered', stage_source: 'carrier_map' }]);
    expect(() => parseStraightship(withRows(row('2026-10-16 10:00:00', '')), IN_TRANSIT, NOW))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads the tracker’s notice as not found', () => {
    expect(() => parseStraightship(fixture('not-found'), UNKNOWN, NOW)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('counts a page only for the number it was asked for', () => {
    for (const [name, number] of [['delivered', UNKNOWN], ['not-found', DELIVERED]] as const) {
      expect(() => parseStraightship(fixture(name), number, NOW))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Straightship answered for another number' }));
    }
    // The title asks for the number, and the summary names another.
    expect(() => parseStraightship(fixture('delivered').replace(`<td>${DELIVERED}</td>`, `<td>${UNKNOWN}</td>`), DELIVERED, NOW))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The tracker repeats the number as it was asked, in any case.
    expect(parseStraightship(fixture('delivered').replaceAll(DELIVERED, DELIVERED.toLowerCase()), DELIVERED, NOW).events).toHaveLength(6);
  });

  it('rejects a changed page', () => {
    for (const html of [
      withRows(row('2026-10-16 25:00:00', 'Loading')),
      withRows(row('2026-02-30 10:00:00', 'Loading')),
      withRows(row('16/10/2026 10:00', 'Loading')),
      withRows('<tr><td>2026-10-16 10:00:00</td><td>Loading</td></tr>'),
      withRows(Array.from({ length: 301 }, () => row('2026-10-16 10:00:00', 'Loading')).join('')),
      fixture('in-transit').replace('<th>City</th>', '<th>Location</th>'),
      fixture('in-transit').replace('Canada B2C Shipment Tracking', 'Shipment Tracking'),
      '<html><head><title>Straightship - Tracking STRCA1234560890124</title></head><body><p>Tracking</p></body></html>',
    ]) {
      expect(() => parseStraightship(html, IN_TRANSIT, NOW)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a block page and a broken page apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(page(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page answers an unknown number with HTTP 200 and its notice.
    await expect(lookup('<html><title>404 Not Found</title></html>', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: '/new/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(CHALLENGE, { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHALLENGE)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Straightship</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number with its last scan, the unknown-number notice, and asks nothing for a number Straightship does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page(fixture('in-transit')))
      .mockResolvedValueOnce(page(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: '2026-10-18T08:02:55.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('STSH0000000000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Straightship does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['STRTD00000000', 'STRTD0000000000', 'STRTD000000000000000000', 'STRCA000000000000', 'STRCA00000000000000',
      'STSHYW0000000000', 'STSH0000000000000', 'STRXX000000000', 'STRTD00000000A', 'STRTD000000000%', `STRTD${'0'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeStraightshipNumber('strca 1234 5608 90124')).toBe(IN_TRANSIT);
  });

  it('tries a read that hangs once more, and ends inside the budget', async () => {
    fakeBudgetClock();
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: 50, reply: () => page(fixture('in-transit')) }]);
    const answered = carrier(recovered.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answered).resolves.toMatchObject({ current_stage: 'in_transit' });
    // Half of the budget, then the retry within the rest.
    expect(recovered.ended).toEqual([200, 250]);
    const started = performance.now();
    const hanging = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(hanging.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(hanging.fetcher).toHaveBeenCalledTimes(2);
    expect(hanging.ended.map((at) => at - started)).toEqual([60, 120]);
  });

  it('routes a number filed under Straightship, or detected as one of its numbers, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => page(fixture('in-transit')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: IN_TRANSIT, carrier: 'straightship' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'straightship', source: 'straightship', result: { current_stage: 'in_transit' } });
    await expect(tracker.track({ number: IN_TRANSIT }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'straightship', source: 'straightship' });
    expect(fetcher.mock.calls.some(([url]) => String(url) === straightshipTrackingUrl(IN_TRANSIT))).toBe(true);
  });
});

describe('Straightship numbers', () => {
  it('claims the layouts the adapter accepts', () => {
    for (const number of [DELIVERED, IN_TRANSIT, ATTEMPTED, RETURNED, UNKNOWN, 'STRTD1234567890123456']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'straightship', confidence: 'high' });
      expect(normalizeStraightshipNumber(number)).toBe(number);
    }
  });

  it('offers Straightship for STSH, two letters and eleven digits, and names it once its tracker knows the parcel', async () => {
    const number = 'STSHAB12345078902';
    expect(detectCarrierMatch('stsh ab 1234 5078 902')).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch(number).candidates).toContain('straightship');
    expect(recognitionAskedCarriers(number)[0]).toBe('straightship');
    expect(normalizeStraightshipNumber(number)).toBe(number);
    for (const other of ['STSHAB1234567890', 'STSHAB123456789012', 'STSH1234567890123', 'STSHA123456789012']) {
      expect(detectCarrierMatch(other).candidates, other).not.toContain('straightship');
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => page(fixture('in-transit').replaceAll(IN_TRANSIT, number)));
    await expect(createTracker({ fetcher, providers: [], env: {} }).recognize(number, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'straightship' });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(straightshipTrackingUrl(number));
  });
});

describe('Straightship status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    const entries = statuses.entries as { wording: string; stage: string }[];
    expect(entries.length).toBeGreaterThan(15);
    for (const entry of entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(straightshipStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('reads the wording universal providers relay, with the place still in it', () => {
    for (const [wording, stage] of [
      ['package information is created in the system', 'registered'],
      ['package received with origin scan warehouse (sampleton, bc)', 'accepted'],
      ['package is received at a straightship station (sampleton)', 'in_transit'],
      ['package will be delivered before 9:00pm (testville, ab)', 'out_for_delivery'],
      ['shipped', 'in_transit'],
      ['delivered (testville, ab)', 'delivered'],
    ] as const) {
      expect(statusMapAnswer({ carrier: 'straightship', description: wording }), wording).toEqual({ kind: 'mapped', stage });
    }
    expect(statusMapAnswer({ carrier: 'straightship', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(statusMap.stage('CODE', 'delivered')).toBeUndefined();
    // A wording the map does not know falls to the shared wording rules.
    expect(straightshipStage('Returned to Sender at depot')).toMatchObject({ stage: 'returned' });
    expect(straightshipStage('Synthetic note')).toBeNull();
  });
});
