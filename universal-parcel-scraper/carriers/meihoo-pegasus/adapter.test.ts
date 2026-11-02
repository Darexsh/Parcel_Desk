import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, MeihooPegasusTracker } from './adapter.js';
import { MEIHOO_PEGASUS_ORIGIN, parseMeihooPegasusPage, parseMeihooPegasusTrack, splitMeihooPegasusRow } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import carrier from './carrier.json' with { type: 'json' };

const NUMBER = 'MYH900000001CN';
const REFERENCE = 'MH0000000000001';
const UNKNOWN = 'MYH900000009CN';
// Noon in Beijing on 25 March, after the fixture's rows.
const READ_AT = Date.parse('2026-03-25T04:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
// The fixture's Chinese characters as the tracker's GBK reply writes them.
const GBK: Readonly<Record<string, readonly number[]>> = { 单: [0xb5, 0xa5], 号: [0xba, 0xc5], 签: [0xc7, 0xa9], 收: [0xca, 0xd5], 未: [0xce, 0xb4],
  查: [0xb2, 0xe9], 询: [0xd1, 0xaf], 到: [0xb5, 0xbd], 轨: [0xb9, 0xec], 迹: [0xbc, 0xa3] };
const gbk = (body: unknown) => new Response(new Uint8Array([...JSON.stringify(body)].flatMap((char) => {
  if (char.charCodeAt(0) < 0x80) return [char.charCodeAt(0)];
  if (!Object.hasOwn(GBK, char)) throw new Error(`no GBK bytes for ${char}`);
  return [...GBK[char]!];
})), { headers: { 'Content-Type': 'text/html;charset=GBK' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('MeiHoo Pegasus tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP and decodes its GBK reply', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(gbk(fixture('track')));
    await expect(new MeihooPegasusTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase()))
      .resolves.toMatchObject({ current_stage: 'delivered', service_name: 'MYH-17单号' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${MEIHOO_PEGASUS_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(MEIHOO_PEGASUS_ORIGIN).toBe('http://129.204.184.34:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'meihoo-pegasus', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads every row on Beijing time, with the delivery’s town as its place and without its postcode or the parties', () => {
    const result = parseMeihooPegasusTrack(fixture('track'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered to mailbox',
      last_update: '2026-03-24T17:02:12+08:00', service_name: 'MYH-17单号', destination_country: 'IT',
    });
    expect(result.events!.map(({ time, description, location, stage, stage_source }) => [time, description, location, stage, stage_source])).toEqual([
      ['2026-03-24T17:02:12+08:00', 'Delivered to mailbox', 'Sampletown ST', 'delivered', 'carrier_map'],
      ['2026-03-24T15:47:21+08:00', 'Arriving at Sampletown, and wait for delivery', 'Sampletown', 'in_transit', 'carrier_map'],
      ['2026-03-23T05:22:55+08:00', 'Your package has been sorted.', 'IT', 'in_transit', 'carrier_map'],
      ['2026-03-21T20:04:58+08:00', 'The package has been sorted at the warehouse.', 'IT', 'in_transit', 'carrier_map'],
      ['2026-03-19T22:28:22+08:00', 'The package has been sorted at the sorting center and sent to the warehouse', 'IT', 'in_transit', 'carrier_map'],
      ['2026-03-17T21:06:48+08:00', 'Customs released, arrived at the sorting center', 'IT', 'in_transit', 'carrier_map'],
      ['2026-03-15T03:55:14+08:00', 'Customs is preparing to release', 'IT', 'customs', 'carrier_map'],
      ['2026-03-13T17:58:44+08:00', 'Customs inspection', 'IT', 'customs', 'carrier_map'],
      ['2026-03-11T07:38:33+08:00', 'Item is being presented to customs.', 'IT', 'customs', 'carrier_map'],
      ['2026-03-09T04:49:49+08:00', 'Arrived at the designated destination', 'IT', 'in_transit', 'carrier_map'],
      ['2026-03-08T19:00:11+08:00', 'In transit.', undefined, 'in_transit', 'carrier_map'],
      ['2026-03-07T18:45:38+08:00', 'Arrived at the transit airport, transferring goods', undefined, 'in_transit', 'carrier_map'],
      ['2026-03-07T07:24:47+08:00', 'Waiting for takeoff', undefined, 'in_transit', 'carrier_map'],
      ['2026-03-06T10:10:03+08:00', 'Air traffic control', undefined, 'in_transit', 'carrier_map'],
      ['2026-03-05T22:28:19+08:00', 'In transit.', undefined, 'in_transit', 'carrier_map'],
      ['2026-03-05T00:10:27+08:00', 'Departing from Hong Kong original airport', undefined, 'in_transit', 'carrier_map'],
      ['2026-03-04T18:58:40+08:00', 'Handed over to the airline, waiting for takeoff', undefined, 'in_transit', 'carrier_map'],
      ['2026-03-04T12:23:18+08:00', 'Arrived at the airline, the airport is checking the goods', undefined, 'in_transit', 'carrier_map'],
      ['2026-03-03T03:37:15+08:00', 'Leaving Hong Kong Operation Center', undefined, 'in_transit', 'carrier_map'],
      ['2026-03-02T03:34:06+08:00', 'Preparing to leave Hong Kong Operation Center', undefined, 'in_transit', 'carrier_map'],
      ['2026-03-01T22:07:35+08:00', 'Operation Center is processing package information', 'Hong Kong', 'registered', 'carrier_map'],
      ['2026-03-01T10:12:40+08:00', 'order created', 'Hong Kong', 'registered', 'carrier_map'],
    ]);
    expect(result.canonical_tracking_number ?? result.delivery_tracking_number ?? result.delivery_carrier).toBeUndefined();
    const text = JSON.stringify(result);
    for (const value of ['00000', 'Synthetic', 'Example Street', REFERENCE, '签收']) expect(text, value).not.toContain(value);
  });

  it('holds back the rows dated after the lookup on Beijing time', () => {
    // 16:00 in Beijing on 24 March: the town's row is due, the delivery is not.
    const result = parseMeihooPegasusTrack(fixture('track'), NUMBER, Date.parse('2026-03-24T08:00:00Z'))!;
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Arriving at Sampletown, and wait for delivery' });
    expect(result.events).toHaveLength(21);
  });

  it('finds the parcel by the shipper’s reference and names its own number', () => {
    expect(parseMeihooPegasusTrack(fixture('track'), REFERENCE, READ_AT)?.canonical_tracking_number).toBe(NUMBER);
  });

  it('takes the place a placeless row leads with before a known wording, without its postcode', () => {
    expect(splitMeihooPegasusRow('Sampletown ST 00000 Delivered to mailbox', '')).toEqual({ content: 'Delivered to mailbox', location: 'Sampletown ST' });
    expect(splitMeihooPegasusRow('San Sample d’Ouest 00000-000 Delivered to mailbox', '')).toEqual({ content: 'Delivered to mailbox', location: 'San Sample d’Ouest' });
    expect(splitMeihooPegasusRow('Sampletown 00-000 Delivered to mailbox', '')).toEqual({ content: 'Delivered to mailbox', location: 'Sampletown' });
    // A row with its own place, a wording without a postcode, a postcode at the end or one before a wording the map does not know stays whole.
    expect(splitMeihooPegasusRow('Sampletown ST 00000 Delivered to mailbox', 'IT')).toEqual({ content: 'Sampletown ST 00000 Delivered to mailbox', location: 'IT' });
    expect(splitMeihooPegasusRow('Customs inspection', '')).toEqual({ content: 'Customs inspection', location: '' });
    expect(splitMeihooPegasusRow('Delivered to Sampletown 00000', '')).toEqual({ content: 'Delivered to Sampletown 00000', location: '' });
    expect(splitMeihooPegasusRow('Flight 00000 departed', '')).toEqual({ content: 'Flight 00000 departed', location: '' });
  });

  it('reads the page’s unknown-number answer as not found, after the interface’s GBK answer that it has no row', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(gbk(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${MEIHOO_PEGASUS_ORIGIN}/trackIndex.htm`);
    expect(() => parseMeihooPegasusPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow('could not locate');
  });

  it('maps every wording it lists, the town’s by any town, and the app reads the map', () => {
    for (const entry of statuses.entries) {
      const wording = entry.wording.replace('<town>', 'Sample-Town d’Ouest');
      expect(statusMap.stage(null, normalizeStatusWording(wording)), wording).toBe(entry.stage);
    }
    expect(statusMap.stage(null, 'arriving at , and wait for delivery')).toBeUndefined();
    expect(statusMap.stage(null, 'arriving at sampletown, and wait for delivery to the neighbour')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'meihoo-pegasus', providerCode: null, description: 'Arriving at Sampletown, and wait for delivery' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'meihoo-pegasus', providerCode: null, description: 'Air traffic control' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(carrier.portal).not.toHaveProperty('url');
    expect(carrier.links).toEqual([]);
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'meihoo-pegasus', confidence: 'high' });
  });
});
