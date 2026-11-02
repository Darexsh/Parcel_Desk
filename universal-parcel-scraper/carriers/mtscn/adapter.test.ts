import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName, isKnownCarrierName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, MtscnTracker } from './adapter.js';
import { MTSCN_ORIGIN, parseMtscnPage, parseMtscnTrack, splitMtscnRow } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import carrier from './carrier.json' with { type: 'json' };

const NUMBER = 'AMTS990000001FS';
const REFERENCE = 'SHOP-REF-0009';
// Noon in Beijing on 20 March: the script's last three rows are still ahead.
const READ_AT = Date.parse('2026-03-20T04:00:00Z');
const AFTER = Date.parse('2026-04-01T04:00:00Z');
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
/** The record with each row written at its own clock, rather than all at the order's creation. */
const asWritten = (reply: unknown) => {
  const copy = structuredClone(reply) as [{ data: [{ trackDetails: Record<string, string>[] }] }];
  for (const row of copy[0].data[0].trackDetails) row.track_createdate = row.track_date!;
  return copy;
};
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Meiteshun Logistics tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track')));
    await expect(new MtscnTracker({ fetcher, recorder: NOOP_RECORDER }).fetch('amts 990000001 fs')).resolves.toMatchObject({ destination_country: 'US' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${MTSCN_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(MTSCN_ORIGIN).toBe('http://182.254.194.208:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'mtscn', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('holds back the script written at the order’s creation, its delivery included', () => {
    const result = parseMtscnTrack(fixture('track'), NUMBER, AFTER)!;
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'item inbound in sorting center',
      service_name: 'Synthetic Small Parcel', destination_country: 'US' });
    // Rows written within twelve hours of their own clock stand.
    expect(result.events).toEqual([
      { time: '2026-03-02T12:56:49+08:00', description: 'item inbound in sorting center', location: 'ShenZhen', stage: 'in_transit', stage_source: 'carrier_map', written_at: '2026-03-02T05:40:40+08:00' },
      {
        time: '2026-03-01T18:16:00+08:00', description: 'The package has been collected and is ready to be sent to the distribution center',
        stage: 'accepted', stage_source: 'carrier_map', written_at: '2026-03-02T05:40:40+08:00',
      },
    ]);
    // Every row ahead: the order exists, with nothing to show yet.
    expect(() => parseMtscnTrack(fixture('track'), NUMBER, Date.parse('2026-03-01T00:00:00Z'))).toThrow(NoHistoryError);
  });

  it('reads rows written as they happen as wall clocks on Beijing time, holding back the rows still ahead', () => {
    const result = parseMtscnTrack(asWritten(fixture('track')), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Arriving at the mail processing center', last_update: '2026-03-19T09:10:22+08:00',
      service_name: 'Synthetic Small Parcel', destination_country: 'US',
    });
    expect(result.events).toHaveLength(9);
    expect(result.events!.slice(0, 2)).toEqual([
      { time: '2026-03-19T09:10:22+08:00', description: 'Arriving at the mail processing center', location: 'Exampleshire, US', stage: 'in_transit', stage_source: 'carrier_map', written_at: '2026-03-19T09:10:22+08:00' },
      { time: '2026-03-15T14:22:36+08:00', description: 'Customs clearance completed', location: 'US', stage: 'in_transit', stage_source: 'carrier_map', written_at: '2026-03-15T14:22:36+08:00' },
    ]);
    expect(result.events!.slice(-3)).toEqual([
      { time: '2026-03-02T20:02:32+08:00', description: 'item outbound in sorting center', location: 'ShenZhen', stage: 'in_transit', stage_source: 'carrier_map', written_at: '2026-03-02T20:02:32+08:00' },
      { time: '2026-03-02T12:56:49+08:00', description: 'item inbound in sorting center', location: 'ShenZhen', stage: 'in_transit', stage_source: 'carrier_map', written_at: '2026-03-02T12:56:49+08:00' },
      {
        time: '2026-03-01T18:16:00+08:00', description: 'The package has been collected and is ready to be sent to the distribution center',
        stage: 'accepted', stage_source: 'carrier_map', written_at: '2026-03-01T18:16:00+08:00',
      },
    ]);
    expect(result.canonical_tracking_number).toBeUndefined();
    expect(result.delivery_carrier).toBeUndefined();
    // Asked by the shipper's reference, the order's own number comes back.
    expect(parseMtscnTrack(fixture('track'), REFERENCE, READ_AT)!.canonical_tracking_number).toBe(NUMBER);
  });

  it('keeps the recipient’s town from the destination rows, never the postcode or the name', () => {
    const result = parseMtscnTrack(asWritten(fixture('track')), NUMBER, AFTER)!;
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', last_update: '2026-03-27T21:51:15+08:00' });
    expect(result.events!.slice(0, 3)).toEqual([
      { time: '2026-03-27T21:51:15+08:00', description: 'Delivered', location: 'Sampletown', stage: 'delivered', stage_source: 'carrier_map', written_at: '2026-03-27T21:51:15+08:00' },
      { time: '2026-03-25T14:22:41+08:00', description: 'package is on the way', location: 'Sampletown, US', stage: 'in_transit', stage_source: 'carrier_map', written_at: '2026-03-25T14:22:41+08:00' },
      {
        time: '2026-03-22T14:36:40+08:00', description: 'Arrive at the sorting and distribution center', location: 'Sampletown, US',
        stage: 'in_transit', stage_source: 'carrier_map', written_at: '2026-03-22T14:36:40+08:00',
      },
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/99999|0000|Synthetic Recipient/);
  });

  it('splits only a place it can read, and leaves other text whole', () => {
    expect(splitMtscnRow('Hong Kong,Leaving the terminal, the airline will take off', '')).toEqual({ content: 'Leaving the terminal, the airline will take off', location: 'Hong Kong' });
    expect(splitMtscnRow('GB,Arriving at the mail processing centerENG', '')).toEqual({ content: 'Arriving at the mail processing center', location: 'ENG, GB' });
    expect(splitMtscnRow('GB,Delivered Sampletown,AB1 2CD', '')).toEqual({ content: 'Delivered', location: 'Sampletown, GB' });
    expect(splitMtscnRow('Not Delivered', '')).toEqual({ content: 'Not Delivered', location: '' });
    expect(splitMtscnRow('Delivered to a neighbour', '')).toEqual({ content: 'Delivered to a neighbour', location: '' });
    // A wording the script did not have: its country code, without the postcode.
    expect(splitMtscnRow('US,Returned to sender Sampletown,99999', '')).toEqual({ content: 'Returned to sender Sampletown', location: 'US' });
    expect(splitMtscnRow('Returned, address unknown', '')).toEqual({ content: 'Returned, address unknown', location: '' });
  });

  it('settles a number the interface holds no row for on the tracking page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page')));
    const result = await adapter(environment(fetcher)).track({ number: REFERENCE });
    expect(result).toMatchObject({ canonical_tracking_number: NUMBER, destination_country: 'US' });
    expect(JSON.stringify(result)).not.toContain('Synthetic Recipient');
    expect(fetcher.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      [`${MTSCN_ORIGIN}/selectTrack.htm?documentCode=${REFERENCE}`, 'GET'],
      [`${MTSCN_ORIGIN}/trackIndex.htm`, 'POST'],
    ]);
    expect(String(fetcher.mock.calls[1]![1]!.body)).toBe(`documentCode=${REFERENCE}`);
    expect(parseMtscnPage(page('page'), NUMBER, READ_AT).events).toEqual([
      { time: '2026-03-07T10:30:00+08:00', description: 'item outbound in sorting center', stage: 'in_transit', stage_source: 'carrier_map' },
      { time: '2026-03-04T13:20:00+08:00', description: 'item inbound in sorting center', stage: 'in_transit', stage_source: 'carrier_map' },
      {
        time: '2026-03-02T20:30:00+08:00', description: 'The package has been collected and is ready to be sent to the distribution center',
        stage: 'accepted', stage_source: 'carrier_map',
      },
    ]);
  });

  it('reads only the page that echoes the number as not found, and a block page as no answer', async () => {
    const unknown = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(unknown)).track({ number: 'AMTS990000002FS' })).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseMtscnPage(page('page-unknown'), 'AMTS990000003FS', READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const recognized = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(recognized)).recognize!('AMTS990000002FS')).resolves.toEqual({ known: false });
    const blocked = vi.fn<typeof fetch>().mockResolvedValue(html('<html><title>Just a moment...</title></html>'));
    await expect(adapter(environment(blocked)).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(html('<html><body>Service Unavailable</body></html>'));
    await expect(adapter(environment(malformed)).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('maps every wording it lists by wording alone, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'mtscn', providerCode: null, description: 'Customs clearanceisin progress' })).toEqual({ kind: 'mapped', stage: 'customs' });
    expect(statusMapAnswer({ carrier: 'mtscn', providerCode: null, description: '合成的记录' })).toEqual({ kind: 'unknown' });
    expect(carrier.portal).not.toHaveProperty('url');
    expect(carrier.portal).not.toHaveProperty('searchUrl');
  });

  it('is the carrier 17TRACK names MTSCN, and its numbers name it', () => {
    expect(isKnownCarrierName('MTSCN')).toBe(true);
    expect(carrierIdFromName('MTSCN')).toBe('mtscn');
    expect(carrierIdFromName('Meiteshun')).toBe('mtscn');
    expect(carrierIdFromName('MTS')).toBeUndefined();
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'mtscn', confidence: 'high' });
  });
});
