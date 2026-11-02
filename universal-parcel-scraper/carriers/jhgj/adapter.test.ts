import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, JhgjTracker } from './adapter.js';
import { JHGJ_ORIGIN, parseJhgjPage, parseJhgjTrack, splitJhgjRow } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import carrier from './carrier.json' with { type: 'json' };

const NUMBER = 'JH9900000001CN';
const REFERENCE = 'SHOP-REF-0007';
const UNKNOWN = 'JH9900000002CN';
// Noon in Beijing on 14 March: the script's rows from the destination's customs on are still ahead.
const READ_AT = Date.parse('2026-03-14T04:00:00Z');
const AFTER = Date.parse('2026-03-21T04:00:00Z');
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
/** The record with each row written at its own clock, rather than at the order's creation. */
const asWritten = (reply: unknown) => {
  const copy = structuredClone(reply) as [{ data: [{ trackDetails: Record<string, string>[] }] }];
  for (const row of copy[0].data[0].trackDetails) row.track_createdate = row.track_date!;
  return copy;
};
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const track = (fetcher: typeof fetch, number = NUMBER) => adapter(environment(fetcher)).track({ number });

describe('Jiuhao International tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track')));
    await expect(new JhgjTracker({ fetcher, recorder: NOOP_RECORDER }).fetch('jh 9900000001 cn')).resolves.toMatchObject({ destination_country: 'PL' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${JHGJ_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(JHGJ_ORIGIN).toBe('http://119.29.157.172:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'jhgj', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('holds back the script written at the order’s creation, and reads the delivery written after it', () => {
    expect(parseJhgjTrack(fixture('track'), NUMBER, AFTER)!.events).toEqual([
      { local_time: '2026-03-01T21:10:05', description: '广州处理中心已收寄', location: '广州市', stage: 'accepted', stage_source: 'carrier_map', written_at: '2026-03-01T19:00:00+08:00' },
    ]);
    const result = parseJhgjTrack(fixture('track-delivered'), NUMBER, AFTER)!;
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update_local: '2026-03-20T11:20:00' });
    expect(result.events!.map((event) => event.description)).toEqual(['Delivered', '广州处理中心已收寄']);
    // Every row ahead: the order exists, with nothing to show yet.
    expect(() => parseJhgjTrack(fixture('track'), NUMBER, Date.parse('2026-03-01T00:00:00Z'))).toThrow(NoHistoryError);
  });

  it('reads rows written as they happen as wall clocks, holding back the rows still ahead', () => {
    const result = parseJhgjTrack(asWritten(fixture('track')), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Arrive at Airport',
      last_update: null, last_update_local: '2026-03-13T08:42:36', service_name: 'JH合成专线PD', destination_country: 'PL',
    });
    expect(result.events).toHaveLength(10);
    expect(result.events!.every((event) => event.local_time && !event.time && event.stage_source === 'carrier_map')).toBe(true);
    expect(result.events!.slice(0, 2)).toEqual([
      { local_time: '2026-03-13T08:42:36', description: 'Arrive at Airport', stage: 'in_transit', stage_source: 'carrier_map', written_at: '2026-03-13T08:42:36+08:00' },
      { local_time: '2026-03-12T14:45:18', description: '启运', location: 'HK International Airport', stage: 'in_transit', stage_source: 'carrier_map', written_at: '2026-03-12T14:45:18+08:00' },
    ]);
    expect(result.events!.slice(-2)).toEqual([
      { local_time: '2026-03-02T13:20:11', description: '邮件已完成分拣，准备发出', location: '广州市', stage: 'in_transit', stage_source: 'carrier_map', written_at: '2026-03-02T13:20:11+08:00' },
      { local_time: '2026-03-01T21:10:05', description: '广州处理中心已收寄', location: '广州市', stage: 'accepted', stage_source: 'carrier_map', written_at: '2026-03-01T21:10:05+08:00' },
    ]);
    expect(result.events!.find((event) => event.description === '出口海关/放行')).toMatchObject({ stage: 'in_transit' });
    expect(result).not.toHaveProperty('canonical_tracking_number');
    expect(result).not.toHaveProperty('delivery_carrier');
    // Asked by the shipper's reference, the order's own number comes back.
    expect(parseJhgjTrack(fixture('track'), REFERENCE, READ_AT)!.canonical_tracking_number).toBe(NUMBER);
  });

  it('reads the delivery added later, keeping the recipient’s town and never the postcode, name or signatory', async () => {
    const result = parseJhgjTrack(asWritten(fixture('track-delivered')), NUMBER, AFTER)!;
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', last_update_local: '2026-03-20T11:20:00' });
    expect(result.events).toHaveLength(16);
    expect(result.events!.slice(0, 5)).toEqual([
      { local_time: '2026-03-20T11:20:00', description: 'Delivered', location: 'Sampletown', stage: 'delivered', stage_source: 'carrier_map', written_at: '2026-03-20T11:20:00+08:00' },
      { local_time: '2026-03-19T09:58:41', description: 'Out for Delivery', location: 'Sampletown', stage: 'out_for_delivery', stage_source: 'carrier_map', written_at: '2026-03-19T09:58:41+08:00' },
      { local_time: '2026-03-18T13:25:19', description: 'Arrive at the mail processing center', location: 'Sampletown', stage: 'in_transit', stage_source: 'carrier_map', written_at: '2026-03-18T13:25:19+08:00' },
      { local_time: '2026-03-17T13:44:02', description: 'Customs clearance completed', stage: 'in_transit', stage_source: 'carrier_map', written_at: '2026-03-17T13:44:02+08:00' },
      { local_time: '2026-03-16T15:50:44', description: 'The import customs keep it for inspection', stage: 'customs', stage_source: 'carrier_map', written_at: '2026-03-16T15:50:44+08:00' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/00-000|Synthetic (?:Recipient|Shipper)|SYNTHETIC SIGNER|Example Street|SHOP-REF|JH-TEST|0\.8/);
    await expect(track(vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track-delivered'))))).resolves.toMatchObject({ status: 'delivered' });
  });

  it('splits only a place it can read, and never keeps a postcode', () => {
    expect(splitJhgjRow('航空公司接收【Hong Kong】', '')).toEqual({ content: '航空公司接收', location: 'Hong Kong' });
    expect(splitJhgjRow('Delivered Sampletown 00-000', '')).toEqual({ content: 'Delivered', location: 'Sampletown' });
    expect(splitJhgjRow('Out for Delivery Nowy Dwór 00-000', '')).toEqual({ content: 'Out for Delivery', location: 'Nowy Dwór' });
    expect(splitJhgjRow('Arrive at the mail processing center Sampletown AB1 2CD', '')).toEqual({ content: 'Arrive at the mail processing center', location: 'Sampletown' });
    expect(splitJhgjRow('Delivered 00-000', 'PL')).toEqual({ content: 'Delivered', location: 'PL' });
    expect(splitJhgjRow('Arrive at Airport', '')).toEqual({ content: 'Arrive at Airport', location: '' });
    // Text after a wording that is not a town leaves the row whole, still without a postcode.
    expect(splitJhgjRow('Delivered to a neighbour Sampletown 00-000', '')).toEqual({ content: 'Delivered to a neighbour Sampletown', location: '' });
    expect(splitJhgjRow('Deliveredx', '')).toEqual({ content: 'Deliveredx', location: '' });
    // A wording the script did not have yet.
    expect(splitJhgjRow('Returned to sender Sampletown 1234 AB', '')).toEqual({ content: 'Returned to sender Sampletown', location: '' });
  });

  it('settles a number the interface holds no row for on the tracking page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page')));
    const result = await track(fetcher, 'SHOP-REF-0008');
    expect(result).toMatchObject({ status: 'pending', current_stage: 'registered', canonical_tracking_number: 'JH9900000003CN', destination_country: 'PL' });
    expect(result.events).toEqual([{ local_time: '2026-03-02T18:40:00', description: '货物电子信息已经收到', stage: 'registered', stage_source: 'carrier_map' }]);
    expect(JSON.stringify(result)).not.toContain('Synthetic Recipient');
    expect(fetcher.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      [`${JHGJ_ORIGIN}/selectTrack.htm?documentCode=SHOP-REF-0008`, 'GET'],
      [`${JHGJ_ORIGIN}/trackIndex.htm`, 'POST'],
    ]);
    expect(String(fetcher.mock.calls[1]![1]!.body)).toBe('documentCode=SHOP-REF-0008');
  });

  it('reads only the page that echoes the number as not found, and recognizes by the same lookup', async () => {
    const unknown = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(track(unknown, UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    expect(parseJhgjTrack(fixture('no-track'), UNKNOWN, READ_AT)).toBeNull();
    expect(() => parseJhgjPage(page('page-unknown'), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const unrecognized = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(unrecognized)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const recognized = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track')));
    await expect(adapter(environment(recognized)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('keeps blocks, rate limits, changed replies, other shipments and foreign numbers apart from not-found', async () => {
    await expect(track(vi.fn<typeof fetch>().mockResolvedValue(html('<html><head><title>Just a moment...</title></head></html>')))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(track(vi.fn<typeof fetch>().mockResolvedValue(json({}, 429)))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(track(vi.fn<typeof fetch>().mockResolvedValue(html('<html><body>Service Unavailable</body></html>')))).rejects.toMatchObject({ kind: 'schema' });
    await expect(track(vi.fn<typeof fetch>().mockResolvedValue(json({ ack: 'true' })))).rejects.toMatchObject({ kind: 'schema' });
    // A record whose own numbers do not include the one asked is no answer for it.
    await expect(track(vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track'))), UNKNOWN)).rejects.toMatchObject({ kind: 'indeterminate' });
    const unsent = vi.fn<typeof fetch>();
    await expect(track(unsent, 'JH,9900000001CN')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(unsent).not.toHaveBeenCalled();
  });

  it('maps every wording it lists by wording alone, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'jhgj', providerCode: null, description: 'Customs clearanceisin progress' })).toEqual({ kind: 'mapped', stage: 'customs' });
    expect(statusMapAnswer({ carrier: 'jhgj', providerCode: null, description: '出口海关/放行' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'jhgj', providerCode: null, description: '合成的记录' })).toEqual({ kind: 'unknown' });
    expect(carrier.portal).not.toHaveProperty('url');
    expect(carrier.portal).not.toHaveProperty('searchUrl');
  });

  it('is the carrier 17TRACK names JHGJ, and its numbers only suggest it, for the tracker to confirm', () => {
    expect(carrierIdFromName('JHGJ')).toBe('jhgj');
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['jhgj'] });
    expect(recognitionCandidates(NUMBER).map((candidate) => candidate.carrier)).toContain('jhgj');
  });
});
