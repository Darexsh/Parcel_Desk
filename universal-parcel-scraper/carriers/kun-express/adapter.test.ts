import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, KunExpressTracker } from './adapter.js';
import { KUN_EXPRESS_ORIGIN, kunExpressClock, parseKunExpressPage, parseKunExpressTrack, repeatsKunExpressRow, splitKunExpressRow } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import carrier from './carrier.json' with { type: 'json' };

const NUMBER = 'KUN9900000001';
const REFERENCE = '890000000000001';
const UNKNOWN = 'KUN9900000009';
// Noon in Beijing on 11 March, after the fixture's rows.
const READ_AT = Date.parse('2026-03-11T04:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const row = (clock: string, content = 'Row', location = '') => ({ clock, content, location, code: '' });

describe('Kun Express numbers', () => {
  it('claims KUN and ten digits, and nothing shorter, longer or under another prefix', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'kun-express', confidence: 'high', candidates: ['kun-express'] });
    for (const other of ['KUN990000001', 'KUN99000000001', 'KUNX9900000001', 'XKUN9900000001', 'KUN9900000001X', 'KUM9900000001']) {
      expect(detectCarrierMatch(other).candidates ?? [], other).not.toContain('kun-express');
    }
  });
});

describe('Kun Express tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track')));
    await expect(new KunExpressTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase())).resolves.toMatchObject({ current_stage: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${KUN_EXPRESS_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(KUN_EXPRESS_ORIGIN).toBe('http://1.117.249.36:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'kun-express', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads its own rows on Beijing time and the USPS rows it copies as wall clocks, each once, without the parties', () => {
    const result = parseKunExpressTrack(fixture('track'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language', last_status_text: 'Delivered, In/At Mailbox',
      last_update: null, last_update_local: '2026-03-10T11:55:00', service_name: 'KUN美国专线', destination_country: 'US',
    });
    expect(result.events!.map(({ time, local_time, description, location, provider_code, stage, stage_source }) =>
      [time ?? local_time, description, location, provider_code, stage, stage_source])).toEqual([
      ['2026-03-10T11:55:00', 'Delivered, In/At Mailbox', 'SAMPLETOWN, NY', undefined, 'delivered', 'wording:language'],
      ['2026-03-10T08:30:00', 'Out for Delivery', 'SAMPLETOWN, NY', undefined, 'out_for_delivery', 'wording:language'],
      ['2026-03-09', 'In Transit to Next Facility', undefined, undefined, 'in_transit', 'wording:language'],
      ['2026-03-08T21:07:00', 'Arrived at USPS Regional Facility', 'EXAMPLE NY DISTRIBUTION CENTER', undefined, 'in_transit', 'wording:language'],
      ['2026-03-07T09:04:00', 'Accepted at USPS Origin Facility', 'SAMPLE CITY, CA', undefined, 'accepted', 'wording:language'],
      ['2026-03-07T02:24:00', 'custom clearance completed', 'US', undefined, 'in_transit', 'carrier_map'],
      ['2026-03-06T05:06:55+08:00', 'arrived at airport of destination', 'LAX', undefined, 'in_transit', 'carrier_map'],
      ['2026-03-05T15:16:01+08:00', 'departed from airport of origin', 'PVG', undefined, 'in_transit', 'carrier_map'],
      ['2026-03-04T20:07:59+08:00', 'Arrive at the sorting center for operation and transfer', 'HANGZHOU', undefined, 'in_transit', 'carrier_map'],
      ['2026-03-03T09:09:05+08:00', 'KUN Warehouse', undefined, 'SHIPMENT', 'in_transit', 'carrier_map'],
      ['2026-03-03T08:59:32+08:00', 'Arrived at the receiving point', 'KUN Warehouse', 'ARRIVAL', 'accepted', 'carrier_map'],
      ['2026-03-02T20:12:17+08:00', 'Shipment information received', undefined, undefined, 'registered', 'carrier_map'],
    ]);
    // Only the forwarder's own rows carry an offset.
    expect(result.events!.filter((event) => event.time).every((event) => event.stage_source === 'carrier_map')).toBe(true);
    expect(result.canonical_tracking_number ?? result.delivery_tracking_number ?? result.delivery_carrier).toBeUndefined();
    const text = JSON.stringify(result);
    for (const value of ['Synthetic Recipient', 'Synthetic Shop', 'Example Street', '00001', '00002', '->', 'Your item', 'OK.', 'On the Way']) {
      expect(text, value).not.toContain(value);
    }
  });

  it('finds the parcel by the shipper’s reference and names its own number', () => {
    expect(parseKunExpressTrack(fixture('track'), REFERENCE, READ_AT)?.canonical_tracking_number).toBe(NUMBER);
  });

  it('reads a row to the second on Beijing time, one to the minute as a wall clock and midnight as a day', () => {
    expect(kunExpressClock(row('2026-03-03 08:59:32'))).toBe('platform');
    expect(kunExpressClock(row('2026-03-03 08:59:00'))).toBe('wall');
    expect(kunExpressClock(row('2026-03-03 00:00:00'))).toBe('day');
    // A row to the second at midnight is still the forwarder's.
    expect(kunExpressClock(row('2026-03-03 00:00:07'))).toBe('platform');
  });

  it('cuts the place a copied row leads with, USPS’s explanation and the ZIP code', () => {
    expect(splitKunExpressRow('SAMPLETOWN, NY 00001, Out for Delivery', 'SAMPLETOWN,NY 00001'))
      .toEqual({ content: 'Out for Delivery', location: 'SAMPLETOWN, NY' });
    expect(splitKunExpressRow('SAMPLETOWN,NY 00001-0001, Delivered -> Your item was delivered in SAMPLETOWN, NY 00001-0001.', 'SAMPLETOWN, NY 00001-0001'))
      .toEqual({ content: 'Delivered', location: 'SAMPLETOWN, NY' });
    // A wording that does not lead with the row's place stays whole.
    expect(splitKunExpressRow('In Transit to Next Facility, Arriving On Time ->', 'US'))
      .toEqual({ content: 'In Transit to Next Facility, Arriving On Time', location: 'US' });
    expect(splitKunExpressRow('U.S. Postal Service, The goods are in transit', 'JFK'))
      .toEqual({ content: 'U.S. Postal Service, The goods are in transit', location: 'JFK' });
    expect(splitKunExpressRow('', 'KUN Warehouse')).toEqual({ content: '', location: 'KUN Warehouse' });
  });

  it('takes a wording that ends with another after a comma as that scan again, at one clock and place only', () => {
    expect(repeatsKunExpressRow('On the Way, Arrived at USPS Facility', 'Arrived at USPS Facility')).toBe(true);
    expect(repeatsKunExpressRow('Arrived at USPS Facility', 'On the Way, Arrived at USPS Facility')).toBe(false);
    expect(repeatsKunExpressRow('Arrived at USPS Facility', 'Arrived at USPS Facility')).toBe(false);
    expect(repeatsKunExpressRow('Shipping Label Created, USPS Awaiting Item', 'Item')).toBe(false);
    const payload = fixture('track');
    const record = payload[0].data[0];
    const copy = (track_date: string, track_location: string, track_content: string) => ({ ...record.trackDetails[5], track_date, track_location, track_content });
    record.trackDetails = [
      copy('2026-03-08 21:07:00', 'EXAMPLE NY DISTRIBUTION CENTER', 'On the Way, Departed USPS Facility'),
      copy('2026-03-08 21:07:00', 'OTHER NY DISTRIBUTION CENTER', 'Departed USPS Facility'),
      copy('2026-03-08 20:07:00', 'EXAMPLE NY DISTRIBUTION CENTER', 'Departed USPS Facility'),
    ];
    // Another place or another clock is another scan, so a lone category stays.
    expect(parseKunExpressTrack(payload, NUMBER, READ_AT)!.events!.map((event) => event.description))
      .toEqual(['On the Way, Departed USPS Facility', 'Departed USPS Facility', 'Departed USPS Facility']);
  });

  it('reads the page’s unknown-number answer as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${KUN_EXPRESS_ORIGIN}/trackIndex.htm`);
    expect(() => parseKunExpressPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow('could not locate');
  });

  it('maps every wording it lists by wording alone, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'kun-express', providerCode: 'ARRIVAL', description: 'Arrived at the receiving point' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    // USPS's wordings are left to the shared rules.
    expect(statusMapAnswer({ carrier: 'kun-express', providerCode: null, description: 'Arrived at USPS Regional Facility' })).toEqual({ kind: 'unknown' });
    expect(carrier.portal).not.toHaveProperty('url');
    expect(carrier.links).toEqual([]);
  });
});
