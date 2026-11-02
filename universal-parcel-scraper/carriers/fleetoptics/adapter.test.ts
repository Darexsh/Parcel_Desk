import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, FleetopticsTracker, fleetopticsTrackingUrl } from './adapter.js';
import { normalizeFleetopticsNumber, parseFleetoptics } from './parser.js';
import { fleetopticsStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'FOAESH1234567';
const IN_TRANSIT = 'FDYNS00000000001';
const OUT = 'FCLR000000000000';
const UNKNOWN = 'FOAESH0000000';
// A Monday morning in Toronto, after every fixture's rows.
const NOW = Date.parse('2026-10-19T14:00:00Z');

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const page = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A history row as the page writes it.
const row = (clock: string, day: string, wording: string, place = '') => `<li class=" "><div class="fo-date-month">
  <div class="fo-time"><p>${clock}</p></div><div class="fo-month"><p>${day}</p></div></div>
  <div class="fo-track-status"><p class="fo-status-title">${wording}</p><p class="fo-sub-status">${place}</p></div></li>`;
const withRows = (rows: string) => fixture('delivered')
  .replace(/(<ul class="fo-tracking-history-list">)[\s\S]*?(<\/ul>)/, `$1${rows}$2`);
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:"managed"};</script></body></html>';

describe('FleetOptics HTTP adapter', () => {
  it('opens the tracking page for the whole number in capitals once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(page(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new FleetopticsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0', now: () => NOW })
      .fetch(' foaesh 123-4567 ', { budgetMs: 1000.5 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://track.fleetopticsinc.com/?tracking_number=${DELIVERED}`);
    expect(fleetopticsTrackingUrl('foaesh1234567')).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'fleetoptics', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps an Eastern history newest first as instants, without the repeated row', () => {
    const result = normalizeCarrierResult(parseFleetoptics(fixture('delivered'), DELIVERED, NOW));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered - To Consumer', last_update: '2026-10-15T15:16:00-04:00', expected_delivery: null,
      delivered_at: '2026-10-15T15:16:00-04:00' });
    expect(result).not.toHaveProperty('timezone');
    expect(result.events!.map((event) => [event.time, event.description, event.location ?? null, event.stage ?? null])).toEqual([
      ['2026-10-15T15:16:00-04:00', 'Delivered - To Consumer', 'SAMPLETON, ON', 'delivered'],
      ['2026-10-15T07:03:00-04:00', 'Out for Delivery', 'SAMPLETON, ON', 'out_for_delivery'],
      ['2026-10-14T22:30:00-04:00', 'Scanned at Delivery Terminal', 'EXAMPLE CITY, ON', 'in_transit'],
      ['2026-10-14T18:51:00-04:00', 'Unable to Deliver - Business Closed', 'SAMPLETON, ON', 'failed_attempt'],
      ['2026-10-14T09:04:00-04:00', 'Out for Delivery', 'SAMPLETON, ON', 'out_for_delivery'],
      ['2026-10-13T23:08:00-04:00', 'Scanned at Delivery Terminal', 'EXAMPLE CITY, ON', 'in_transit'],
      ['2026-10-13T19:32:00-04:00', 'Received Order Details', null, 'registered'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.stage_source === 'carrier_map')).toBe(true);
  });

  it('keeps neither the postal code, the proof of delivery nor the page’s links', () => {
    const result = JSON.stringify(parseFleetoptics(fixture('delivered'), DELIVERED, NOW));
    expect(result).not.toMatch(/A0A0A0|example\.invalid|Proof|photo|\.jpg|postal|Sender|Destination/i);
    expect(JSON.stringify(parseFleetoptics(fixture('in-transit'), IN_TRANSIT, NOW))).not.toMatch(/example\.invalid|Preferences|A0A0A0/);
  });

  it('keeps another zone’s clocks local in that zone and reads the estimated day by its weekday', () => {
    const result = parseFleetoptics(fixture('in-transit'), IN_TRANSIT, NOW);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'In Transit - Scanned at Transfer Terminal', last_update: null, last_update_local: '2026-10-18T13:27:00',
      expected_delivery: '2026-10-21', timezone: 'America/Vancouver' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events).toEqual([
      { local_time: '2026-10-18T13:27:00', description: 'In Transit - Scanned at Transfer Terminal', location: 'EXAMPLEVILLE, QC',
        stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-10-18T07:19:00', description: 'Received Order Details', stage: 'registered', stage_source: 'carrier_map' },
    ]);
    // A weekday no nearby year gives that day is no estimate; one past the new year is next year's.
    expect(parseFleetoptics(fixture('in-transit').replace('Wed, Oct 21', 'Mon, Oct 21'), IN_TRANSIT, NOW).expected_delivery).toBeNull();
    expect(parseFleetoptics(fixture('in-transit').replace('Wed, Oct 21', 'Sometime soon'), IN_TRANSIT, NOW).expected_delivery).toBeNull();
    expect(parseFleetoptics(fixture('in-transit').replaceAll('Oct 18', 'Dec 29').replace('Wed, Oct 21', 'Mon, Jan 4'), IN_TRANSIT,
      Date.parse('2026-12-30T20:00:00Z')).expected_delivery).toBe('2027-01-04');
  });

  it('expects a parcel out for delivery today', () => {
    const result = parseFleetoptics(fixture('out-for-delivery'), OUT, NOW);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Out for Delivery',
      last_update: '2026-10-19T06:17:00-04:00', expected_delivery: '2026-10-19' });
    expect(result.events!.map((event) => event.time)).toEqual(['2026-10-19T06:17:00-04:00', '2026-10-19T02:51:00-04:00', '2026-10-18T17:52:00-04:00']);
  });

  it('dates rows across the new year, in winter time', () => {
    const html = fixture('delivered').replaceAll('Oct 15', 'Jan 1').replaceAll('Oct 14', 'Dec 31').replaceAll('Oct 13', 'Dec 30');
    const result = parseFleetoptics(html, DELIVERED, Date.parse('2027-01-02T15:00:00Z'));
    expect(result.events!.map((event) => event.time)).toEqual([
      '2027-01-01T15:16:00-05:00', '2027-01-01T07:03:00-05:00', '2026-12-31T22:30:00-05:00', '2026-12-31T18:51:00-05:00',
      '2026-12-31T09:04:00-05:00', '2026-12-30T23:08:00-05:00', '2026-12-30T19:32:00-05:00',
    ]);
    // A clock the lookup has not reached is last year's.
    expect(parseFleetoptics(withRows(row('09:00 ET', 'Oct 21', 'Out for Delivery')), DELIVERED, NOW).events![0]!.time)
      .toBe('2025-10-21T09:00:00-04:00');
  });

  it('reads a row without a stage, keeps the latest stage, and drops a place with digits', () => {
    const result = parseFleetoptics(withRows(row('10:00 ET', 'Oct 16', 'Synthetic note') + row('09:00 ET', 'Oct 16', 'Out for Delivery', '1 SAMPLE ST, ON')),
      DELIVERED, NOW);
    expect(result).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Synthetic note', last_update: '2026-10-16T10:00:00-04:00' });
    expect(result.events).toEqual([
      { time: '2026-10-16T10:00:00-04:00', description: 'Synthetic note' },
      { time: '2026-10-16T09:00:00-04:00', description: 'Out for Delivery', stage: 'out_for_delivery', stage_source: 'carrier_map' },
    ]);
    // An oldest-first page is turned round, and a label the page has not been seen to use stays local without a zone.
    const reversed = parseFleetoptics(withRows(row('09:00 ZT', 'Oct 15', 'Out for Delivery') + row('10:00 ZT', 'Oct 16', 'Delivered - Safe Drop')),
      DELIVERED, NOW);
    expect(reversed).toMatchObject({ current_stage: 'delivered', last_update: null, last_update_local: '2026-10-16T10:00:00' });
    expect(reversed).not.toHaveProperty('timezone');
    expect(reversed).not.toHaveProperty('delivered_at');
  });

  it('reads the tracker’s notice as not found, and another notice as inconclusive', () => {
    expect(() => parseFleetoptics(fixture('not-found'), UNKNOWN, NOW)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // Older pages gave the same notice other words.
    expect(() => parseFleetoptics(fixture('not-found').replace('Tracking number not found.', 'Please Enter Valid Tracking Number'), UNKNOWN, NOW))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseFleetoptics(fixture('not-found').replace('Tracking number not found.', 'Service temporarily unavailable'), UNKNOWN, NOW))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('counts a page only for the number it was asked for', async () => {
    expect(() => parseFleetoptics(fixture('delivered'), UNKNOWN, NOW))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'FleetOptics answered for another number' }));
    expect(() => parseFleetoptics(fixture('not-found'), DELIVERED, NOW)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseFleetoptics(fixture('delivered').replace(`value="${DELIVERED}"`, 'value=""'), DELIVERED, NOW))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseFleetoptics(fixture('delivered').replace(`value="${DELIVERED}"`, `value="${DELIVERED.toLowerCase()}"`), DELIVERED, NOW).events)
      .toHaveLength(7);
    // The service sends a number filed under another barcode to that barcode's page.
    const lookup = (location: string) => carrier(vi.fn<typeof fetch>().mockResolvedValue(page('', { status: 302, headers: { Location: location } })))
      .track({ number: DELIVERED });
    await expect(lookup(`index.php?tracking_number=${OUT}&searched_id=${DELIVERED}`))
      .rejects.toMatchObject({ kind: 'indeterminate', message: 'FleetOptics answered for another number' });
    await expect(lookup(`index.php?tracking_number=${DELIVERED}&searched_id=${DELIVERED}`)).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('https://fleetopticsinc.com/')).rejects.toMatchObject({ kind: 'transport' });
  });

  it('rejects a changed page', () => {
    for (const html of [
      withRows(row('25:00 ET', 'Oct 15', 'Out for Delivery')),
      withRows(row('09:60 ET', 'Oct 15', 'Out for Delivery')),
      withRows(row('9 AM ET', 'Oct 15', 'Out for Delivery')),
      withRows(row('09:00 ET', 'Oct 32', 'Out for Delivery')),
      withRows(row('09:00 ET', 'Foo 15', 'Out for Delivery')),
      withRows(row('09:00 ET', '2026-10-15', 'Out for Delivery')),
      withRows(row('09:00 ET', 'Oct 15', ' ')),
      withRows(Array.from({ length: 201 }, () => row('09:00 ET', 'Oct 15', 'Out for Delivery')).join('')),
      fixture('delivered').replace('fo-tracking-history-list', 'fo-history'),
      '<html><head><title>FleetOptics - Tracking</title></head><body><p>Tracking</p></body></html>',
    ]) {
      expect(() => parseFleetoptics(html, DELIVERED, NOW)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseFleetoptics(withRows(''), DELIVERED, NOW)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('keeps an unknown number, a moved route, a block page and a broken page apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(page(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page answers an unknown number with HTTP 200 and its notice: a 404 is a moved route.
    await expect(lookup('<html><title>404 Not Found</title></html>', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(CHALLENGE, { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHALLENGE)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>FleetOptics</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number notice, and asks nothing for a number FleetOptics does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page(fixture('in-transit')))
      .mockResolvedValueOnce(page(fixture('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-10-18T13:27:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('F0000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers FleetOptics does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['F00000000000', 'FOAESH', 'FOAESH000000', 'FOAESHABCDEFG', 'IND0000000000000', 'SON0000000000', 'FOAESH0000000%',
      `FOAESH${'0'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    // Other shippers' codes, and the package IDs the tracker files as barcodes.
    expect(normalizeFleetopticsNumber('fabc 0000000')).toBe('FABC0000000');
    expect(normalizeFleetopticsNumber('SON10000000000')).toBe('SON10000000000');
  });

  it('tries a read that hangs once more, and ends inside the budget', async () => {
    fakeBudgetClock();
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: 50, reply: () => page(fixture('in-transit')) }]);
    const answered = carrier(recovered.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answered).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(recovered.fetcher).toHaveBeenCalledTimes(2);
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

  it('routes a number filed under FleetOptics, or detected as one of its numbers, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => page(fixture('in-transit')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: IN_TRANSIT, carrier: 'fleetoptics' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'fleetoptics', source: 'fleetoptics', result: { current_stage: 'in_transit' } });
    await expect(tracker.track({ number: IN_TRANSIT }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'fleetoptics', source: 'fleetoptics' });
    expect(fetcher.mock.calls.some(([url]) => String(url) === fleetopticsTrackingUrl(IN_TRANSIT))).toBe(true);
  });
});

describe('FleetOptics numbers', () => {
  it('claims the seven shippers’ layouts and leaves the package IDs unclaimed', () => {
    for (const number of [DELIVERED, IN_TRANSIT, OUT, UNKNOWN]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'fleetoptics', confidence: 'high' });
    }
    for (const number of ['FABC0000000', 'SON10000000000']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('fleetoptics');
    }
  });
});

describe('FleetOptics status vocabulary', () => {
  it('records every row wording the map knows with the stage it gives', () => {
    const rows = (statuses.entries as { wording: string; stage: string; language: string; note?: string }[])
      .filter((entry) => entry.language === 'en' && !/^(?:Summary text|Status (?:of the first event )?in an archived reply)/.test(entry.note ?? ''));
    expect(rows.length).toBeGreaterThan(5);
    for (const entry of rows) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(fleetopticsStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'fleetoptics', description: 'Delivered - Left at Side Door' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'fleetoptics', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(statusMap.stage('CODE', 'out for delivery')).toBeUndefined();
    // A wording the map does not know falls to the shared wording rules.
    expect(fleetopticsStage('Returned to Sender')).toEqual({ stage: 'returned', source: 'wording:language' });
    expect(fleetopticsStage('Synthetic note')).toBeNull();
  });
});
