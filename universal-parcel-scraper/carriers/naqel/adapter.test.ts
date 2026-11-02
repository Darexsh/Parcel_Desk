import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, NAQEL_TRACK, NaqelTracker } from './adapter.js';
import { naqelWording, normalizeNaqelNumber, parseNaqel } from './parser.js';
import { naqelStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '100000001';
const IN_TRANSIT = '200000002';
const UNKNOWN = '300000003';
// The in-transit waybill's first piece: the waybill and a five-digit piece counter.
const PIECE = '20000000200001';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const changed = (name: string, from: string | RegExp, to: string) => {
  const html = fixture(name);
  const next = html.replace(from, to);
  if (next === html) throw new Error(`The ${name} fixture has no ${String(from)}`);
  return next;
};
// The page with the scans of its history removed, leaving the shipment's summary.
const withoutScans = (name: string) => fixture(name).replace(/(<div class="card-body">\n)[\s\S]*?(\n {24}<\/div>\n {20}<\/div>\n {20}<br \/>)/, '$1$2');
const page = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Naqel HTTP adapter', () => {
  it('gets the English tracking page of the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(page(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new NaqelTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 200 000 002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${NAQEL_TRACK}${IN_TRANSIT}`);
    expect(String(url)).toBe('https://www.naqelexpress.com/en/Track/TrackShipment/200000002');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'naqel', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each scan’s wall clock local and stages it by its wording, newest first', () => {
    const result = parseNaqel(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-09-14T12:12:00', expected_delivery: null });
    expect(result).not.toHaveProperty('canonical_tracking_number');
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.local_time, event.location, event.stage, event.description])).toEqual([
      // Scans the system records name no place.
      ['2026-09-14T12:12:00', undefined, 'delivered', 'Delivered'],
      ['2026-09-13T21:42:00', undefined, 'ready_for_pickup', 'Loaded to Parcel Locker'],
      ['2026-09-13T11:01:00', 'EASTWICK', 'in_transit', 'Prepared for delivery'],
      ['2026-09-13T10:11:00', 'EASTWICK', 'out_for_delivery', 'Out For Delivery with Courier'],
      ['2026-09-13T02:15:00', 'CENTRAL HUB', 'in_transit', 'Departed to EASTWICK'],
      ['2026-09-12T14:40:00', 'CENTRAL HUB', 'in_transit', 'Customs Clearance Completed'],
      ['2026-09-12T14:30:00', 'CENTRAL HUB', 'customs', 'Arrived at Naqel Clearance Facility'],
      ['2026-09-10T14:06:00', 'WESTPORT', 'accepted', 'Picked up by Naqel'],
      // A delivery option the system records moves nothing.
      ['2026-09-10T08:20:00', undefined, undefined, 'Parcel Locker Request Created'],
      ['2026-09-10T07:29:00', undefined, 'registered', 'Waybill created. Shipment has not been received from the retailer'],
    ]);
    expect(result.events!.every((event) => !event.time && (!event.stage || event.stage_source === 'carrier_map'))).toBe(true);
  });

  it('reads a parcel on its way with its expected delivery day and keeps a repeated scan once', () => {
    const result = parseNaqel(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Departed to NORTHFIELD', last_update_local: '2026-10-14T22:00:00', expected_delivery: '2026-10-18' });
    expect(result.events!.map((event) => event.description)).toEqual(['Departed to NORTHFIELD', 'Arrived at Naqel Facility',
      'Picked up by Naqel', 'Waybill created. Shipment has not been received from the retailer']);
    // An expected day the page words otherwise is left out.
    expect(parseNaqel(changed('in-transit', '<td>18-10-2026</td>', '<td>2026-10-18</td>'), IN_TRANSIT).expected_delivery).toBeNull();
    expect(parseNaqel(changed('in-transit', '<td>18-10-2026</td>', '<td></td>'), IN_TRANSIT).expected_delivery).toBeNull();
  });

  it('keeps no destination, pickup day, payment method, piece count or footer contact', () => {
    const text = JSON.stringify(parseNaqel(fixture('in-transit'), IN_TRANSIT));
    expect(text).not.toMatch(/Prepaid|13-10-2026|8000000000|care@|"NORTHFIELD"/);
  });

  it('takes the stage of a delivered summary over the scans, and an unknown wording keeps no stage', () => {
    const summarized = parseNaqel(changed('delivered', /<p class="text-white trackMobile font-weight-bold">Delivered<\/p>/, '<p class="text-white trackMobile font-weight-bold">Sample notice</p>'), DELIVERED);
    expect(summarized.events![0]).toMatchObject({ description: 'Sample notice' });
    expect(summarized.events![0]).not.toHaveProperty('stage');
    expect(summarized).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Sample notice', expected_delivery: null });
    // Another summary leaves the stage to the scans.
    const scanned = parseNaqel(changed('delivered', /<th>Delivered<\/th>/, '<th>Sample status</th>'), DELIVERED);
    expect(scanned).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered' });
    expect(naqelStage('Sample notice')).toBeNull();
  });

  it('reads a history listed oldest first newest first', () => {
    const html = fixture('in-transit');
    const start = html.indexOf('<div class="card-body">\n', html.indexOf('Shipment Details')) + '<div class="card-body">\n'.length;
    const days = html.slice(start).match(/ {28}\n {28}<div class="row">[\s\S]*?\n {28}<\/div>\n(?= {28}\n)/g)!;
    expect(days).toHaveLength(2);
    const reversed = html.replace(days.join(''), [...days].reverse().map((day) => {
      const scans = day.match(/ {32}\n {32}<div class="col-md-12">[\s\S]*?\n {32}<\/div>\n/g)!;
      return day.replace(scans.join(''), [...scans].reverse().join(''));
    }).join(''));
    expect(parseNaqel(reversed, IN_TRANSIT).events!.map((event) => event.local_time)).toEqual([
      '2026-10-14T22:00:00', '2026-10-14T19:38:00', '2026-10-14T18:58:00', '2026-10-13T11:21:00']);
  });

  it('takes the signer and phone numbers out of a scan’s wording', () => {
    expect(naqelWording('Shipment Delivered – signed by  Sample Person')).toBe('Shipment Delivered');
    expect(naqelWording('\n  Out For Delivery with Courier 0500000000\n')).toBe('Out For Delivery with Courier');
    expect(naqelWording('On Hold : Technical : 2026-9-12')).toBe('On Hold : Technical : 2026-9-12');
    expect(naqelWording('Load to Trip : SAMPLE1 - tripID - 1234')).toBe('Load to Trip : SAMPLE1 - tripID - 1234');
    const signed = parseNaqel(changed('delivered', '>Delivered</p>', '>Shipment Delivered – signed by Sample Person</p>'), DELIVERED);
    expect(signed.events![0]).toMatchObject({ description: 'Shipment Delivered', stage: 'delivered', stage_source: 'carrier_map' });
    expect(JSON.stringify(signed)).not.toContain('Sample Person');
  });

  it('binds a piece label to its waybill and keeps the waybill as the canonical number', () => {
    expect(parseNaqel(fixture('in-transit'), PIECE)).toMatchObject({ current_stage: 'in_transit', canonical_tracking_number: IN_TRANSIT });
    // An eight-digit waybill's piece label is thirteen digits.
    expect(parseNaqel(changed('in-transit', '<td>200000002</td>', '<td>20000000</td>'), '2000000000003'))
      .toMatchObject({ canonical_tracking_number: '20000000' });
  });

  it('counts a shipment only when its summary names the number asked or the waybill of the piece asked', () => {
    for (const number of [DELIVERED, '200000003', '20000000300001', '2000000020001', '20000000']) {
      expect(() => parseNaqel(fixture('in-transit'), number), number)
        .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Naqel answered for another shipment' }));
    }
  });

  it('reads the page’s own answer for a number it has no shipment for as not found, and a summary without scans as no history', () => {
    expect(() => parseNaqel(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseNaqel(withoutScans('in-transit'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects a changed page', () => {
    for (const html of [
      '<html><title>NAQEL Express</title></html>',
      changed('in-transit', '<th>SHIPMENT NO:</th>', '<th>WAYBILL:</th>'),
      changed('in-transit', 'textarea name="waybills"', 'textarea name="numbers"'),
      changed('in-transit', '>Shipment Details</h3>', '>Details</h3>'),
      changed('in-transit', '<td>200000002</td>', '<td>A200000002</td>'),
      changed('in-transit', 'October 14, 2026', '14-10-2026'),
      changed('in-transit', 'October 14, 2026', 'October 32, 2026'),
      changed('in-transit', 'October 13, 2026', ''),
      changed('in-transit', '10:00 PM', '22:00'),
      changed('in-transit', '>Departed to NORTHFIELD</p>', '></p>'),
      changed('in-transit', /<div class="col-md-3 col-sm-12">\s*<p class="text-white"><i class="fa fa-clock-o"[^\n]*10:00 PM<\/p>\s*<\/div>/, ''),
      // A second shipment's summary.
      changed('in-transit', '<th>PIECE COUNT:</th>', '<th>SHIPMENT NO:</th>'),
      // An empty answer that is not the page's own.
      changed('not-found', 'Sorry Tracking information is not available', 'Please try again later'),
    ]) {
      expect(() => parseNaqel(html, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const oversized = fixture('in-transit').replace(/( {32}\n {32}<div class="col-md-12">[\s\S]*?\n {32}<\/div>\n)/, (scan) => scan.repeat(501));
    expect(() => parseNaqel(oversized, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema', message: 'Naqel returned an oversized history' }));
  });

  it('keeps an unknown number, a moved route, a browser check and a broken page apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(page(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page answers a missing shipment with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.naqelexpress.com/en/sa/tracking/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>NAQEL Express</title><body>Maintenance</body></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number Naqel does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page(fixture('delivered')))
      .mockResolvedValueOnce(page(fixture('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-09-14T12:12:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('1000000010')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Naqel does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // Seven, ten, eleven, twelve and fifteen digits, letters.
    for (const number of ['1000000', '1000000010', '10000000100', '100000001000', '100000001000010', 'A10000001', '1'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeNaqelNumber(' 100-000-001 ')).toBe(DELIVERED);
    expect(normalizeNaqelNumber('10000000')).toBe('10000000');
    expect(normalizeNaqelNumber(PIECE)).toBe(PIECE);
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

  it('routes a number filed under Naqel to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => page(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'naqel' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'naqel', source: 'naqel', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${NAQEL_TRACK}${DELIVERED}`)).toBe(true);
  });

  it('leaves Naqel’s numbers to the caller: no rule claims its digit runs', () => {
    for (const number of [DELIVERED, IN_TRANSIT, PIECE, '20000000']) expect(detectCarrierMatch(number).carrier, number).not.toBe('naqel');
  });
});

describe('Naqel status vocabulary', () => {
  it('gives every English scan wording seen on the tracker the stage recorded for it', () => {
    const scans = (statuses.entries as { wording: string; stage?: string; language: string; confirmedBy: string }[])
      .filter((entry) => entry.language === 'en' && entry.confirmedBy !== 'official-doc');
    expect(scans.length).toBeGreaterThan(15);
    for (const entry of scans) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(naqelStage(entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'naqel', providerCode: null, description: 'Departed to EASTWICK' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'naqel', providerCode: null, description: 'Parcel Locker Request Created' }))
      .toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'naqel', providerCode: null, description: 'Sample notice' })).toEqual({ kind: 'unknown' });
  });
});
