import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SHIPROCKET_API, ShiprocketTracker, shiprocketTrackingUrl } from './adapter.js';
import { normalizeShiprocketNumber, parseShiprocket, parseShiprocketEstimate } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '8320000000001';
const UNKNOWN = '8329999999999';
const READ_AT = Date.parse('2026-01-05T00:00:00Z');
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const transit = fixture('in-transit.html');
const abroad = fixture('delivered-abroad.html');
const archived = fixture('archived.html');
const absent = fixture('not-found.html');
const estimate = fixture('estimate.json');
const edit = (body: string, change: ($: ReturnType<typeof load>) => void) => { const $ = load(body); change($); return $.html(); };
const page = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...headers } });
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
/** The tracker's page for the in-transit fixture, and its estimate. */
const site = (body = transit, answer: () => Response | Promise<Response> = () => json(estimate)) => vi.fn<typeof fetch>(async (input) =>
  String(input).startsWith(SHIPROCKET_API) ? answer() : page(body));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Shiprocket numbers', () => {
  it('takes any AWB of letters and digits, and reads one out of a link to its tracker', () => {
    expect(normalizeShiprocketNumber(' 8320-0000 0000 1 ')).toBe(NUMBER);
    expect(normalizeShiprocketNumber('srx00000001')).toBe('SRX00000001');
    for (const link of [`https://shiprocket.co/tracking/${NUMBER}`, `https://example-store.shiprocket.co/tracking/${NUMBER}/`]) {
      expect(parseTrackingInput(link)).toMatchObject({ trackingNumber: NUMBER, carrier: 'shiprocket', source: 'link' });
    }
    expect(shiprocketTrackingUrl(NUMBER)).toBe(`https://shiprocket.co/tracking/${NUMBER}`);
  });

  it('names the carrier for the names providers report', () => {
    for (const name of ['Shiprocket', 'ShipRocket', 'ShiprocketX', 'Shiprocket X']) expect(carrierIdFromName(name), name).toBe('shiprocket');
  });

  it('puts ShiprocketX’s 832 AWBs first among the 13-digit carriers, and asks its tracker', () => {
    for (const number of [NUMBER, UNKNOWN, '8325550000000']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['shiprocket'] });
      expect(detectCarrierMatch(number).candidates).toEqual(expect.arrayContaining(['shiprocket', 'la-poste']));
      expect(recognitionCandidates(number)[0]).toMatchObject({ carrier: 'shiprocket', preferred: true });
    }
  });

  it('claims none of the neighbouring Indian shapes', () => {
    for (const number of [
      // Delhivery's 13- and 14-digit waybills, Xpressbees' AWBs, Blue Dart's 11 digits.
      '8600000000001', '8609900000001', '86099000000001', '1319000000001', '14110000000001', '90000000001',
      // Other prefixes and lengths around 832.
      '8310000000001', '8330000000001', '7320000000001', '832000000001', '83200000000001', 'SRX0000000001',
    ]) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('shiprocket');
    }
  });
});

describe('Shiprocket tracking page', () => {
  it('reads the history on India’s clock, the order’s day setting the year', () => {
    const { result, orderId } = parseShiprocket(transit, NUMBER, READ_AT);
    expect(orderId).toBe('1000000001');
    expect(normalizeCarrierResult(result)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Order Departed from Facility', last_update: '2026-01-02T10:16:00+05:30', expected_delivery: null,
      service_name: 'SRX Economy' });
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.description, event.location ?? null, event.stage])).toEqual([
      ['2026-01-02T10:16:00+05:30', 'Order Departed from Facility', null, 'in_transit'],
      ['2026-01-01T12:22:00+05:30', 'Order Arrived at Facility', 'Exampur_Central_D (Delhi)', 'in_transit'],
      ['2026-01-01T12:10:00+05:30', 'Order Arrived at Facility', 'DELHI', 'in_transit'],
      ['2026-01-01T08:46:00+05:30', 'Dispatched - Delivering At Shiprocket Warehouse', 'Exampur_Central_D (Delhi)', 'in_transit'],
      ['2026-01-01T08:16:00+05:30', 'Pending - Shipment Received at Facility', 'Exampur_Central_D (Delhi)', 'in_transit'],
      ['2026-01-01T05:59:00+05:30', 'In Transit - Bag Received at Facility', 'Exampur_Central_D (Delhi)', 'in_transit'],
      ['2026-01-01T05:49:00+05:30', 'In Transit - Trip Arrived', 'Exampur_Central_D (Delhi)', 'in_transit'],
      ['2026-01-01T03:53:00+05:30', 'In Transit - Bag Added To Trip', 'Exampur_Industrial_I (Delhi)', 'in_transit'],
      ['2026-01-01T00:43:00+05:30', 'In Transit - Bag Received at Facility', 'Exampur_Industrial_I (Delhi)', 'in_transit'],
      ['2026-01-01T00:19:00+05:30', 'In Transit - Trip Arrived', 'Exampur_Industrial_I (Delhi)', 'in_transit'],
      ['2025-12-31T18:32:00+05:30', 'In Transit - Bag Added To Trip', 'Sampleganj_Hub_H (Haryana)', 'in_transit'],
      ['2025-12-31T11:46:00+05:30', 'In Transit - Shipment Received at Facility', 'Sampleganj_Hub_H (Haryana)', 'in_transit'],
      ['2025-12-31T07:35:00+05:30', 'In Transit - Bag Received at Facility', 'Sampleganj_Hub_H (Haryana)', 'in_transit'],
      ['2025-12-31T07:17:00+05:30', 'In Transit - Trip Arrived', 'Sampleganj_Hub_H (Haryana)', 'in_transit'],
      ['2025-12-30T21:51:00+05:30', 'In Transit - Bag Added To Trip', 'Demonagar_Depot_I (Uttar Pradesh)', 'in_transit'],
      ['2025-12-30T18:35:00+05:30', 'In Transit - Added to Bag', 'Demonagar_Depot_I (Uttar Pradesh)', 'in_transit'],
      ['2025-12-30T18:03:00+05:30', 'In Transit - Shipment Recieved at Origin Center', 'Demonagar_Depot_I (Uttar Pradesh)', 'in_transit'],
      ['2025-12-30T14:26:00+05:30', 'In Transit - Shipment picked up', 'Demonagar_Depot_I (Uttar Pradesh)', 'accepted'],
      // The pickup is planned, not done: the shared rules would read a trip out.
      ['2025-12-30T09:34:00+05:30', 'Manifested - Out for Pickup', 'Demonagar_Depot_I (Uttar Pradesh)', 'registered'],
      // The order's row is written at midnight of the order's day.
      ['2025-12-28', 'Order Received', null, 'registered'],
    ]);
    // The merchant, the order's reference, the buyer's place and the page's tokens are never read.
    expect(JSON.stringify(result)).not.toMatch(/Example Store|\*{3}|Exampleland|00000,|1000001|0{64}/);
  });

  it('reads the older page template some merchants keep, with its ordinal order day', () => {
    const older = edit(transit, ($) => {
      $('.delievery_list_wrap li > span > b').each((_index, node) => { $(node).replaceWith($(node).text()); });
      $('.date_info_wrap').attr('class', 'date_for_activities');
      $('.information_block .pull-left b').each((_index, node) => { $(node).replaceWith($(node).text()); });
      $('.information_block .right_info').filter((_index, node) => $(node).text() === '28 Dec 2025').text('28th Dec 2025');
      $('.courier_info .pull-left').last().replaceWith('<div class="pull-left courier-name"><span>SRX Economy</span></div>');
    });
    expect(older).not.toMatch(/date_info_wrap|<b>(?:SRX Economy|Activity :|Order Placed On)|>28 Dec 2025/);
    // Read long after, the order's day still sets the year.
    const late = Date.parse('2027-06-01T00:00:00Z');
    expect(parseShiprocket(older, NUMBER, late).result).toEqual(parseShiprocket(transit, NUMBER, READ_AT).result);
  });

  it('keeps India’s clock for every row of a courier within India', () => {
    const domestic = edit(abroad, ($) => { $('.courier_info .pull-left span b').text('Xpressbees Surface 2kg'); });
    const { result } = parseShiprocket(domestic, '8320000000002', Date.parse('2026-10-01T00:00:00Z'));
    expect(result).toMatchObject({ last_update: '2026-09-16T11:06:00+05:30', delivered_at: '2026-09-16T11:06:00+05:30', service_name: 'Xpressbees Surface 2kg' });
    expect(result.events!.filter((event) => !event.time).map((event) => event.local_time)).toEqual(['2026-09-11']);
  });

  it('dates rows without the order’s day by the read, and holds back rows written ahead of it', () => {
    const undated = edit(transit, ($) => { $('.information_block .clearfix').eq(1).remove(); });
    const { result } = parseShiprocket(undated, NUMBER, READ_AT);
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2025-12-28' });
    expect(result.events![0]).toMatchObject({ time: '2026-01-02T10:16:00+05:30' });
    // Read on the first of January in India, the second's rows are not scans yet.
    const early = parseShiprocket(transit, NUMBER, Date.parse('2026-01-01T07:00:00Z')).result;
    expect(early).toMatchObject({ last_update: '2026-01-01T12:22:00+05:30' });
    expect(early.events).toHaveLength(19);
  });

  it('counts the page only for the AWB asked', () => {
    expect(() => parseShiprocket(transit, UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseShiprocket(edit(transit, ($) => { $('.tracking_id').text(UNKNOWN); }), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseShiprocket(edit(transit, ($) => { $('input#awb').attr('value', UNKNOWN); }), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed page', () => {
    for (const change of [
      ($: ReturnType<typeof load>) => { $('.delievery_list_wrap').remove(); },
      ($: ReturnType<typeof load>) => { $('.delievery_list_wrap li .time').first().text('10:16'); },
      ($: ReturnType<typeof load>) => { $('.delievery_list_wrap li .time').first().text('13:16 PM'); },
      ($: ReturnType<typeof load>) => { $('.delievery_list_wrap li .date').first().text('2 January'); },
      ($: ReturnType<typeof load>) => { $('.delievery_list_wrap li .date').first().text('30 Feb'); },
      ($: ReturnType<typeof load>) => { $('.delievery_list_wrap li activity').first().text(''); },
      ($: ReturnType<typeof load>) => { $('input#awb').remove(); },
    ]) {
      expect(() => parseShiprocket(edit(transit, change), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseShiprocket(edit(transit, ($) => { $('.delievery_list_wrap li').remove(); }), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('keeps India’s clock for rows in India and Shiprocket’s own, and wall clocks abroad', () => {
    const { result } = parseShiprocket(abroad, '8320000000002', Date.parse('2026-10-01T00:00:00Z'));
    expect(normalizeCarrierResult(result)).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2026-09-16T11:06:00', service_name: 'SRX Premium' });
    // A delivery abroad has no instant to give.
    expect(result.delivered_at).toBeUndefined();
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.description, event.location ?? null, event.stage ?? null])).toEqual([
      ['2026-09-16T11:06:00', 'Delivered', 'FL, US', 'delivered'],
      ['2026-09-16T07:09:00', 'Out for Delivery', 'FL, US', 'out_for_delivery'],
      ['2026-09-15T07:15:00', 'Arrived at USPS Regional Facility', 'SAMPLEVILLE FL DISTRIBUTION CENTER', 'in_transit'],
      ['2026-09-11T11:25:00', 'Arrived at origin facility', 'EXAMPLETOWN, NEWYORK, US', 'in_transit'],
      ['2026-09-11', 'CUSTOM CLEARED OVERSEAS', null, 'customs'],
      // Unplaced, and not Shiprocket's: its zone is unknown.
      ['2026-09-10T02:20:00', 'AWB Handed over to Flight', null, 'in_transit'],
      ['2026-09-09T23:58:00+05:30', 'Connection Aligned', 'DELHI', 'in_transit'],
      ['2026-09-09T22:30:00+05:30', 'Order Departed from Facility', null, 'in_transit'],
      ['2026-09-08T16:31:00+05:30', 'Received At DC', 'DELHI', 'in_transit'],
      ['2026-09-08T10:12:00+05:30', 'Dispatched - Delivering At Shiprocket Warehouse', 'Exampur_Central_D (Delhi)', 'in_transit'],
      ['2026-09-04T15:39:00+05:30', 'In Transit - Shipment picked up', 'Demonagar_Depot_I (Uttar Pradesh)', 'accepted'],
      ['2026-09-03T22:49:00', 'Shipping Label Created, USPS Awaiting Item', null, 'registered'],
      // The order's place is the buyer's town: it is left out.
      ['2026-09-03T11:40:00+05:30', 'Order Received', null, 'registered'],
    ]);
    // A wall clock abroad may be ahead of India's: read just after it in India's time, it still counts.
    const early = parseShiprocket(abroad, '8320000000002', Date.parse('2026-09-16T04:00:00Z')).result;
    expect(early.events![0]).toMatchObject({ description: 'Delivered' });
  });

  it('reads the archived view of an older shipment as its last status, without rows', () => {
    const number = '8320000000003';
    const { result, orderId } = parseShiprocket(archived, number, READ_AT);
    expect(orderId).toBeNull();
    expect(normalizeCarrierResult(result)).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'DELIVERED',
      last_update: null, last_update_local: '2026-10-02', service_name: 'SRX Economy Pro', summary_only: true, events: [] });
    expect(JSON.stringify(result)).not.toMatch(/Example Store|\*{3}/);
    const returned = parseShiprocket(edit(archived, ($) => { $('.status-value').attr('class', 'status-value rto').text('RTO DELIVERED'); }), number, READ_AT);
    expect(returned.result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'RTO DELIVERED' });
    expect(parseShiprocket(edit(archived, ($) => { $('.status-value').text('FULFILLED'); }), number, READ_AT).result)
      .toMatchObject({ current_stage: 'delivered' });
    expect(parseShiprocket(edit(archived, ($) => { $('.status-value').text('Synthetic state'); }), number, READ_AT).result)
      .toMatchObject({ status: 'unknown', last_status_text: 'Synthetic state', summary_only: true });
    // The AWB it holds and the part it shows must be the one asked.
    expect(() => parseShiprocket(archived, '8320000000004', READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseShiprocket(edit(archived, ($) => { $('.tracking-id-value').text('83210000*****'); }), number, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const change of [
      ($: ReturnType<typeof load>) => { $('.tracking-id-value').text('8320*********'); },
      ($: ReturnType<typeof load>) => { $('#verifyContext').remove(); },
      ($: ReturnType<typeof load>) => { $('.status-value').remove(); },
    ]) {
      expect(() => parseShiprocket(edit(archived, change), number, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads the estimate’s day', () => {
    expect(parseShiprocketEstimate(JSON.parse(estimate))).toBe('2026-01-09');
    for (const payload of [{}, { current_etd_1: null }, { current_etd_1: { date: '' } }, { current_etd_1: { date: '2026-02-30 00:00:00' } }, []]) {
      expect(parseShiprocketEstimate(payload)).toBeNull();
    }
  });
});

describe('Shiprocket HTTP adapter', () => {
  it('reads the tracking page once, then its estimate, through the supplied transport', async () => {
    const fetcher = site();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ShiprocketTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 8320-0000-0000-1 ', { budgetMs: 10_000 }))
      .resolves.toMatchObject({ current_stage: 'in_transit', expected_delivery: '2026-01-09' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[url, init], [estimateUrl, estimateInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(url).toBe(`https://shiprocket.co/tracking/${NUMBER}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(estimateUrl).toBe(`${SHIPROCKET_API}/pocx/tracking-order-edd/1000000001`);
    expect(estimateInit).toMatchObject({ signal: expect.any(AbortSignal), headers: { Origin: 'https://shiprocket.co', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'shiprocket', step: 'direct', outcome: 'ok' }));
  });

  it('keeps the history when the estimate fails or says nothing', async () => {
    for (const answer of [
      () => json('', 500), () => json('{}'), () => json('<html></html>'), () => Promise.reject(new TypeError('fetch failed')),
    ]) {
      const fetcher = site(transit, answer);
      await expect(carrier(fetcher).track({ number: NUMBER })).resolves.toMatchObject({ current_stage: 'in_transit', expected_delivery: null });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });

  it('asks for no estimate without the order’s id', async () => {
    const fetcher = site(edit(transit, ($) => { $('input#order_id').attr('value', ''); }));
    await expect(carrier(fetcher).track({ number: NUMBER })).resolves.toMatchObject({ expected_delivery: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reads the not-found page as not found only with its HTTP 400', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: UNKNOWN });
    await expect(lookup(page(absent, 400))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(page(absent))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(page('<html><title>400 Bad Request</title></html>', 400))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(page('<html><head><title>ERROR: The request could not be satisfied</title></head></html>', 400)))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(page('<html><head><title>Just a moment...</title></head></html>'))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(page('<html><title>Shiprocket</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(page('', 302, { Location: 'https://shiprocket.co/' }))).rejects.toMatchObject({ kind: 'transport' });
    // The route answers every AWB: without it, the tracker moved.
    await expect(lookup(page('', 404))).rejects.toMatchObject({ kind: 'transport' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => page('', status));
      await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('rejects inputs that are no AWB and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['1234567', 'ABCDEFGHIJ', '1'.repeat(31), '8320000000001/../1']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: NUMBER }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementation(async (input) => (String(input).startsWith(SHIPROCKET_API) ? json(estimate) : page(transit)));
    await expect(carrier(fetcher).track({ number: NUMBER }, { budgetMs: 10_000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher.mock.calls.filter(([url]) => !String(url).startsWith(SHIPROCKET_API))).toHaveLength(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: NUMBER }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('recognizes an AWB from the page alone, and an unknown one from its HTTP 400', async () => {
    const fetcher = site();
    await expect(carrier(fetcher).recognize!(NUMBER)).resolves.toMatchObject({ known: true, lastActivityAt: '2026-01-02T04:46:00.000Z' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(page(archived))).recognize!('8320000000003')).resolves.toMatchObject({ known: true });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(page(absent, 400))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(page('', 429))).recognize!(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('routes an AWB filed under Shiprocket to the adapter', async () => {
    const fetcher = site();
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: NUMBER, carrier: 'shiprocket' }, { budgetMs: 5000 });
    expect(answer).toMatchObject({ carrier: 'shiprocket', source: 'shiprocket', result: { current_stage: 'in_transit' } });
  });
});

describe('Shiprocket status vocabulary', () => {
  it('records every row the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording))).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'shiprocket', providerCode: '', description: entry.wording })).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'shiprocket', providerCode: '', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // RTO, return to origin, is the way back to the merchant.
    expect(statusMap.stage(null, normalizeStatusWording('RTO In Transit'))).toBe('returned');
  });
});
