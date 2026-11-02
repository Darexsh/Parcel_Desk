import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TCI_EXPRESS_TRACKER, TciExpressTracker } from './adapter.js';
import { normalizeTciExpressNumber, parseTciExpress } from './parser.js';
import { statusMap, tciExpressStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '100000001';
const IN_TRANSIT = '1000000002';
const OLD = '300000003';
const UNKNOWN = '900000009';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const edited = (html: string, from: string | RegExp, to: string) => {
  const next = html.replace(from, to);
  if (next === html) throw new Error(`The page has no ${String(from)}`);
  return next;
};
const changed = (name: string, from: string | RegExp, to: string) => edited(fixture(name), from, to);
// The page with the data rows under one table's title and headings edited.
const rows = (html: string, title: string, edit: (found: string[]) => string[]) => {
  const table = html.indexOf(title);
  if (table < 0) throw new Error(`The page has no ${title} table`);
  const start = html.indexOf('</tr>', html.indexOf('</tr>', table) + 5) + 5;
  const end = start + html.slice(start).search(/<\/tbody\s*>/);
  return html.slice(0, start) + edit(html.slice(start, end).match(/<tr>[\s\S]*?<\/tr>/g) ?? []).join('\n') + html.slice(end);
};
const page = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const timeline = (html: string, number: string) => parseTciExpress(html, number).events!
  .map((event) => [event.local_time, event.time ?? null, event.location ?? null, event.stage ?? null, event.description]);

describe('TCI Express HTTP adapter', () => {
  it('gets the tracking page of the whole docket once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(page(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TciExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1000000002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${TCI_EXPRESS_TRACKER}?trackshipment=${IN_TRANSIT}&dwb=dwb`);
    expect(String(url)).toBe('https://www.tciexpress.in/track-your-shipment?trackshipment=1000000002&dwb=dwb');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'tci-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the booking, each leg and the delivery runs as one history, newest first', () => {
    const result = parseTciExpress(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Shipment delivered', last_update: null, last_update_local: '2026-03-13', expected_delivery: null, weight_kg: 12 });
    expect(result).not.toHaveProperty('delivered_at');
    expect(timeline(fixture('delivered'), DELIVERED)).toEqual([
      // Delivery rows carry their day alone and follow the day's timed scans.
      ['2026-03-13', null, null, 'delivered', 'Shipment delivered'],
      ['2026-03-12', null, null, 'failed_attempt', 'Others'],
      // Transhipment clocks are Indian wall clocks, kept with their instant.
      ['2026-03-12T09:40:00', '2026-03-12T04:10:00Z', 'XSDC (SAMPLE CITY)', 'in_transit', 'Arrived'],
      ['2026-03-11T18:20:00', '2026-03-11T12:50:00Z', 'XSSC (SAMPLE SORTING CENTER)', 'in_transit', 'Despatched to XSDC (SAMPLE CITY)'],
      ['2026-03-11T06:30:00', '2026-03-11T01:00:00Z', 'XSSC (SAMPLE SORTING CENTER)', 'in_transit', 'Arrived'],
      ['2026-03-10T23:05:00', '2026-03-10T17:35:00Z', 'XSHB (SAMPLE HUB)', 'in_transit', 'Despatched to XSSC (SAMPLE SORTING CENTER)'],
      ['2026-03-10T02:40:00', '2026-03-09T21:10:00Z', 'XSHB (SAMPLE HUB)', 'in_transit', 'Arrived'],
      ['2026-03-09T21:15:00', '2026-03-09T15:45:00Z', 'XSAB (SAMPLE BKG)', 'in_transit', 'Despatched to XSHB (SAMPLE HUB)'],
      ['2026-03-09', null, 'XSAB (SAMPLE BKG)', 'accepted', 'Booked'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
  });

  it('keeps no pin code, station note, phone number, packet count or proof of delivery', () => {
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', IN_TRANSIT]] as const) {
      const text = JSON.stringify(parseTciExpress(fixture(name), number));
      expect(text, name).not.toMatch(/9000000000|10000[12]|ODA|SAMPLE TOWN|POD|packet|Pin/i);
    }
    const phone = parseTciExpress(changed('delivered', '<td> Others </td>', '<td> Consignee not available 98765 43210 </td>'), DELIVERED);
    expect(phone.events![1]).toMatchObject({ description: 'Consignee not available' });
  });

  it('reads a docket between stations, with the expected delivery the booking gives', () => {
    expect(parseTciExpress(fixture('in-transit'), IN_TRANSIT)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'Arrived', last_update: '2026-09-22T18:25:00Z', last_update_local: '2026-09-22T23:55:00',
      expected_delivery: '2026-09-26', weight_kg: 25 });
    expect(timeline(fixture('in-transit'), IN_TRANSIT).map((event) => event[4])).toEqual(['Arrived',
      'Despatched to XSSC (SAMPLE SORTING CENTER)', 'Arrived', 'Despatched to XSHB (SAMPLE HUB)', 'Booked']);
    // A leg still on the road has no arrival yet.
    const onTheRoad = changed('in-transit', /<td> 22-SEP-2026 <\/td>(\s*)<td>23:55 <\/td>/, '<td> </td>$1<td> </td>');
    expect(parseTciExpress(onTheRoad, IN_TRANSIT)).toMatchObject({ last_status_text: 'Despatched to XSSC (SAMPLE SORTING CENTER)',
      last_update: '2026-09-20T22:40:00Z', last_update_local: '2026-09-21T04:10:00' });
    // A booking without an estimate or a weight gives neither.
    const bare = parseTciExpress(edited(changed('in-transit', '<td> 26-SEP-2026 </td>', '<td> </td>'), '<td> 25 </td>', '<td> 0 </td>'), IN_TRANSIT);
    expect(bare.expected_delivery).toBeNull();
    expect(bare).not.toHaveProperty('weight_kg');
  });

  it('reads a docket booked but not despatched yet, and one known only by its delivery rows', () => {
    const booked = parseTciExpress(rows(fixture('in-transit'), 'Transhipment Information', () => []), IN_TRANSIT);
    expect(booked).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'Booked',
      last_update: null, last_update_local: '2026-09-20' });
    const delivered = parseTciExpress(rows(rows(fixture('delivered'), 'Booking Information', () => []), 'Transhipment Information', () => []), DELIVERED);
    expect(delivered).toMatchObject({ status: 'delivered', last_update_local: '2026-03-13', expected_delivery: null });
    expect(delivered.events).toHaveLength(2);
  });

  it('keeps a delivery row it has no stage for without one, and takes the stage from the newest that has one', () => {
    const result = parseTciExpress(changed('delivered', '<td> Shipment delivered </td>', '<td> Sample Reason </td>'), DELIVERED);
    expect(result.events![0]).toMatchObject({ description: 'Sample Reason', local_time: '2026-03-13' });
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: 'Sample Reason' });
    expect(tciExpressStage('Sample Reason')).toBeNull();
  });

  it('reads an empty result as not found, and a result without scans as no history', () => {
    expect(() => parseTciExpress(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const empty = changed('in-transit', /<table class='table table-custom[\s\S]*<\/table>/, '');
    expect(() => parseTciExpress(empty, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('counts a docket only when the page names the docket asked', () => {
    expect(() => parseTciExpress(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'TCI Express answered for another docket' }));
    // An older docket keeps its delivery rows without its number, so they cannot be told from another docket's.
    expect(() => parseTciExpress(fixture('old-docket'), OLD))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'TCI Express answered without the docket number' }));
  });

  it('rejects a changed page', () => {
    for (const html of [
      '<html><title>TCI Express</title></html>',
      changed('in-transit', 'Docket Number:', 'Docket:'),
      changed('in-transit', '<b>1000000002</b>', '<b></b>'),
      changed('in-transit', 'Transhipment Information', 'Transit Information'),
      changed('in-transit', '<th> Despatch Date </th>', '<th> Dispatch Date </th>'),
      changed('in-transit', '<td> 20-SEP-2026 </td>', '<td> 2026-09-20 </td>'),
      changed('in-transit', '<td> 20-SEP-2026 </td>', '<td> 31-SEP-2026 </td>'),
      changed('in-transit', '<td> 19:45 </td>', '<td> 24:00 </td>'),
      changed('in-transit', '<td> 19:45 </td>', '<td> 7:45 </td>'),
      changed('in-transit', '<td> XSAB (SAMPLE BKG) </td>', '<td> SAMPLE BKG </td>'),
      changed('in-transit', '<td> 1 </td>', ''),
      // An arrival time without its day.
      changed('in-transit', '<td> 22-SEP-2026 </td>', '<td> </td>'),
      rows(fixture('in-transit'), 'Booking Information', (found) => [...found, ...found]),
      changed('in-transit', "<div class='col-lg-12 col-md-12'>", "<div class='col-lg-12 col-md-12'></div><div class='col-lg-12 col-md-12'>"),
    ]) {
      expect(() => parseTciExpress(html, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseTciExpress(rows(fixture('in-transit'), 'Transhipment Information', (found) => Array.from({ length: 501 }, () => found[0]!)), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    // A delivery row without its wording.
    expect(() => parseTciExpress(changed('delivered', '<td> Shipment delivered </td>', '<td> </td>'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown docket, a moved route, a browser check and a broken page apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(page(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page answers an unknown docket with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.tciexpress.in/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>TCI Express</title><body>Under maintenance</body></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('rejects numbers TCI Express does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['10000000', '10000000003', 'A00000001', '1'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTciExpressNumber(' 1000000002 ')).toBe(IN_TRANSIT);
    expect(carrier(fetcher)).not.toHaveProperty('recognize');
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(page(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a docket filed under TCI Express to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => page(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'tci-express' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'tci-express', source: 'tci-express', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${TCI_EXPRESS_TRACKER}?trackshipment=${DELIVERED}&dwb=dwb`)).toBe(true);
  });

  it('leaves dockets to the caller: no rule claims nine or ten digits for TCI Express', () => {
    for (const number of [DELIVERED, IN_TRANSIT]) expect(detectCarrierMatch(number).carrier, number).not.toBe('tci-express');
  });
});

describe('TCI Express status vocabulary', () => {
  // The docket's status line above the tables, which the adapter does not read.
  const STATUS_LINE = new Set(['Arrived At.', 'Docket Delivered On']);

  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      if (STATUS_LINE.has(entry.wording)) continue;
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(tciExpressStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'tci-express', description: 'Shipment delivered' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'tci-express', description: 'Despatched to XSHB (SAMPLE HUB)' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'tci-express', description: 'Sample Reason' })).toEqual({ kind: 'unknown' });
    expect(statusMap.stage('X1', 'booked')).toBeUndefined();
  });
});
