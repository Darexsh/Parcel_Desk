import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, MayiyinfuTracker } from './adapter.js';
import { MAYIYINFU_ORIGIN, parseMayiyinfuPage, parseMayiyinfuTrack } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import carrier from './carrier.json' with { type: 'json' };

const NUMBER = 'MY9900000001US';
const REFERENCE = 'REFTEST000001';
const UNKNOWN = 'MY9900000002US';
const READ_AT = Date.parse('2026-03-25T04:00:00Z');
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const track = (fetcher: typeof fetch, number = NUMBER) => adapter(environment(fetcher)).track({ number });

describe('Mayi Yinfu tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track')));
    await expect(new MayiyinfuTracker({ fetcher, recorder: NOOP_RECORDER }).fetch('my 9900000001 us')).resolves.toMatchObject({ destination_country: 'ES' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${MAYIYINFU_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(MAYIYINFU_ORIGIN).toBe('http://www.mayiyinfu.com.cn:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'mayiyinfu', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads a parcel in transit, with the rows DHL relays after the hand-off on Beijing time', () => {
    const result = parseMayiyinfuTrack(fixture('track'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_update: '2026-03-20T10:30:00+08:00',
      service_name: '合成专线-全球小包', destination_country: 'ES',
    });
    expect(result.last_update_local).toBeUndefined();
    expect(result.delivered_at).toBeUndefined();
    expect(result.last_status_text).toMatch(/^The shipment has arrived in the destination country\/destination area\. \(Homepage/);
    expect(result.events).toHaveLength(17);
    expect(result.events!.every((event) => Boolean(event.local_time) !== Boolean(event.time) && event.stage)).toBe(true);
    expect(result.events!.slice(1, 3)).toEqual([
      { time: '2026-03-18T14:12:00+08:00', description: 'The international shipment has been processed in the export parcel center', location: 'DE', stage: 'in_transit', stage_source: 'carrier_map', written_at: '2026-03-18T14:12:00+08:00' },
      { time: '2026-03-17T11:47:00+08:00', description: 'The international shipment has been processed in the parcel center of origin', location: 'DE', stage: 'in_transit', stage_source: 'carrier_map', written_at: '2026-03-17T11:47:00+08:00' },
    ]);
    // DHL's rows with a country, and the rows in China, are on Beijing time. The forwarder's rows
    // abroad, its warehouse rows and the rows without a place keep their wall clocks. The scripted
    // rows, coded CO_C_CR, are set aside.
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.location ?? null])).toEqual([
      ['2026-03-20T10:30:00+08:00', 'ES'], ['2026-03-18T14:12:00+08:00', 'DE'], ['2026-03-17T11:47:00+08:00', 'DE'],
      ['2026-03-17T01:05:41', 'AMS'], ['2026-03-16T18:40:12', 'AMS'], ['2026-03-14T08:25:37', 'AMS'],
      ['2026-03-13T22:58:03+08:00', 'CN'], ['2026-03-13T10:21:54+08:00', 'CN'], ['2026-03-12T17:33:18+08:00', 'CN'], ['2026-03-11T14:09:46+08:00', 'CN'],
      ['2026-03-08T22:17:09+08:00', 'CN'], ['2026-03-08T18:04:51+08:00', 'CN'],
      ['2026-03-05T16:44:08', 'SAMPLECITY'], ['2026-03-04T22:51:19', 'SAMPLECITY'],
      ['2026-03-04T19:10:00', null], ['2026-03-04T17:26:45', null], ['2026-03-04T13:20:00', null],
    ]);
    expect(result.events!.find((event) => event.provider_code === 'ARRIVAL')).toEqual({
      local_time: '2026-03-04T22:51:19', description: '已入库,到达收货点', location: 'SAMPLECITY', provider_code: 'ARRIVAL', stage: 'accepted', stage_source: 'carrier_map', written_at: '2026-03-04T22:51:19+08:00',
    });
    // The airport rows' translation reads "delivered"; the step they lead with is a hand-over to the airport.
    const airport = result.events!.filter((event) => /^货物已交机场|^The goods have been delivered to the airport$/.test(event.description!));
    expect(airport.map((event) => [event.stage, event.stage_source])).toEqual([['in_transit', 'carrier_map'], ['in_transit', 'carrier_map']]);
    // A flight row shows its step's English without the day it expects, which is still to come.
    expect(result.events!.slice(6, 11).map((event) => event.description)).toEqual([
      'The second leg has departed', 'The first leg has arrived', 'The first leg has departed', 'The flight has been delayed',
      'The goods have been delivered to the airport',
    ]);
    expect(JSON.stringify(result)).not.toMatch(/预计/);
    expect(result.events!.at(-1)).toMatchObject({ stage: 'registered', stage_source: 'carrier_map' });
    // The record names no channel: DHL takes the transfer number its own rule claims whole.
    expect(detectCarrierMatch('CJ000000005DE')).toMatchObject({ carrier: 'dhl', confidence: 'high' });
    expect(result).toMatchObject({ delivery_carrier: 'dhl', delivery_tracking_number: 'CJ000000005DE' });
    // Shenzhen's "SZ", Eswatini's code, is no place.
    const unscripted = parseMayiyinfuTrack(JSON.parse(JSON.stringify(fixture('track')).replaceAll('"CO_C_CR"', '""')), NUMBER, READ_AT)!;
    expect(unscripted.events!.find((event) => event.local_time === '2026-03-09T06:31:27')).not.toHaveProperty('location');
    expect(deliveryHandoff('mayiyinfu', NUMBER, result)).toMatchObject({ carrier: 'dhl', number: 'CJ000000005DE' });
    // A failed check digit, or a number DHL's rules do not claim, hands nothing over.
    for (const transfer of ['CJ000000004DE', 'LX000000005CN']) {
      const record = JSON.parse(JSON.stringify(fixture('track')).replaceAll('CJ000000005DE', transfer));
      expect(parseMayiyinfuTrack(record, NUMBER, READ_AT)).not.toHaveProperty('delivery_carrier');
    }
    expect(result).not.toHaveProperty('canonical_tracking_number');
    expect(JSON.stringify(result)).not.toMatch(/Synthetic (?:Recipient|Shipper)|Sintética|00000"|1\.2/);
    // Asked by the shipper's reference, the order's own number comes back.
    expect(parseMayiyinfuTrack(fixture('track'), REFERENCE, READ_AT)!.canonical_tracking_number).toBe(NUMBER);
  });

  it('reads the delivery DHL relays, dated on Beijing time', async () => {
    const result = await track(vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track-delivered'))));
    // Spain keeps two clocks, but DHL's rows come on the tracker's, mainland or Canaries alike.
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'The shipment has been delivered',
      last_update: '2026-03-23T12:15:00+08:00', delivered_at: '2026-03-23T12:15:00+08:00' });
    expect(result.last_update_local).toBeUndefined();
    expect(result.events![0]).toEqual({ time: '2026-03-23T12:15:00+08:00', description: 'The shipment has been delivered', location: 'ES',
      stage: 'delivered', stage_source: expect.stringMatching(/^wording:/), written_at: '2026-03-23T12:15:00+08:00' });
  });

  it('keeps the wall clocks whose zone the record does not settle', () => {
    const base = fixture('track-delivered') as [{ data: [Record<string, unknown>] }];
    const record = (rows: readonly [string, string, string, string?][], transfer = 'CJ000000005DE') => {
      const copy = JSON.parse(JSON.stringify(base).replaceAll('CJ000000005DE', transfer)) as typeof base;
      copy[0].data[0].trackDetails = rows.map(([date, location, content, kind = '']) => ({
        track_date: date, track_createdate: date, track_location: location, track_content: content, track_kind: kind,
      }));
      return parseMayiyinfuTrack(copy, NUMBER, READ_AT)!;
    };
    const clocks = (result: ReturnType<typeof record>) => result.events!.map((event) => event.time ?? event.local_time);
    const abroad: [string, string, string][] = [
      ['2026-03-23 12:15:00', 'ES', 'The shipment has been delivered'],
      ['2026-03-23 08:05:00', 'US', 'The shipment has been loaded onto the delivery vehicle'],
      ['2026-03-22 18:00:00', 'RU', 'The international shipment has been processed in the export parcel center'],
      ['2026-03-22 12:00:00', 'AU', 'The international shipment has been processed in the export parcel center'],
      ['2026-03-21 18:00:00', 'BR', 'The international shipment has been processed in the export parcel center'],
      ['2026-03-21 12:00:00', 'MX', 'The international shipment has been processed in the export parcel center'],
      ['2026-03-20 12:00:00', 'China', '货物已交机场，等待安排航班中The goods have been delivered to the airport and are awaiting the arrangement of flights.'],
    ];
    // Without DHL taking the record, nothing proves which clock a copied row keeps, in a country
    // with several zones or one; a place in China is still on Beijing time.
    const unclaimed = record(abroad, 'LX000000005CN');
    expect(unclaimed).not.toHaveProperty('delivery_carrier');
    expect(unclaimed).toMatchObject({ status: 'delivered', last_update: null, last_update_local: '2026-03-23T12:15:00' });
    expect(unclaimed).not.toHaveProperty('delivered_at');
    expect(clocks(unclaimed)).toEqual(['2026-03-23T12:15:00', '2026-03-23T08:05:00', '2026-03-22T18:00:00', '2026-03-22T12:00:00',
      '2026-03-21T18:00:00', '2026-03-21T12:00:00', '2026-03-20T12:00:00+08:00']);
    // Once DHL takes it, DHL's rows with a country are on Beijing time. Its rows without a place
    // have come on its German clock as well, a town is no country code, and the forwarder's rows
    // abroad could be on either clock.
    const claimed = record([
      ['2026-03-23 12:15:00', '', 'The shipment has been delivered'],
      ['2026-03-23 08:05:00', 'Madrid', 'The shipment has been loaded onto the delivery vehicle'],
      ['2026-03-22 18:00:00', 'AMS', '已转运transferred'],
      ['2026-03-22 12:00:00', 'DH', '已到达目的国'],
      ['2026-03-21 12:00:00', 'MX', 'The international shipment has been processed in the export parcel center'],
    ]);
    expect(claimed).toMatchObject({ delivery_carrier: 'dhl', status: 'delivered', last_update: null, last_update_local: '2026-03-23T12:15:00' });
    expect(claimed).not.toHaveProperty('delivered_at');
    expect(clocks(claimed)).toEqual(['2026-03-23T12:15:00', '2026-03-23T08:05:00', '2026-03-22T18:00:00', '2026-03-22T12:00:00',
      '2026-03-21T12:00:00+08:00']);
    // A delivery that is not the newest row gives no delivery time.
    const after = record([
      ['2026-03-24 09:00:00', 'ES', 'The shipment has been processed in the parcel center'],
      ['2026-03-23 12:15:00', 'ES', 'The shipment has been delivered'],
    ]);
    expect(after).toMatchObject({ last_update: '2026-03-24T09:00:00+08:00' });
    expect(after).not.toHaveProperty('delivered_at');
  });

  it('reads only the page that echoes the number as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(track(fetcher, UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      [`${MAYIYINFU_ORIGIN}/selectTrack.htm?documentCode=${UNKNOWN}`, 'GET'],
      [`${MAYIYINFU_ORIGIN}/trackIndex.htm`, 'POST'],
    ]);
    expect(String(fetcher.mock.calls[1]![1]!.body)).toBe(`documentCode=${UNKNOWN}`);
    expect(parseMayiyinfuTrack(fixture('no-track'), UNKNOWN, READ_AT)).toBeNull();
    expect(() => parseMayiyinfuPage(page('page-unknown'), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps blocks, rate limits, changed replies, other shipments and foreign numbers apart from not-found', async () => {
    await expect(track(vi.fn<typeof fetch>().mockResolvedValue(html('<html><head><title>Just a moment...</title></head></html>')))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(track(vi.fn<typeof fetch>().mockResolvedValue(json({}, 429)))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(track(vi.fn<typeof fetch>().mockResolvedValue(html('<html><body>Service Unavailable</body></html>')))).rejects.toMatchObject({ kind: 'schema' });
    await expect(track(vi.fn<typeof fetch>().mockResolvedValue(json({ ack: 'true' })))).rejects.toMatchObject({ kind: 'schema' });
    // A record whose own numbers do not include the one asked is no answer for it.
    await expect(track(vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track'))), UNKNOWN)).rejects.toMatchObject({ kind: 'indeterminate' });
    const unsent = vi.fn<typeof fetch>();
    await expect(track(unsent, 'MY,9900000001')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(unsent).not.toHaveBeenCalled();
  });

  it('maps every wording it lists, the steps whatever follows them, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    const answer = (description: string) => statusMapAnswer({ carrier: 'mayiyinfu', providerCode: null, description });
    expect(answer('货物已交机场，预计21号的航班The goods have been delivered to the airport. The flight is scheduled for the 21st.')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(answer('The shipment has arrived in the destination country/destination area. (Homepage / online shipment tracking: https://example.test/?id=1)'))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(answer('合成的记录')).toEqual({ kind: 'unknown' });
    expect(carrier.portal).not.toHaveProperty('url');
    expect(carrier.portal).not.toHaveProperty('searchUrl');
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'mayiyinfu', confidence: 'high' });
  });
});
