import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, GzylTracker } from './adapter.js';
import { GZYL_ORIGIN, normalizeGzylNumber, parseGzylPage, parseGzylTrack, splitGzylRow } from './parser.js';
import { PLACED_WORDINGS, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import carrier from './carrier.json' with { type: 'json' };

const NUMBER = 'GZTEST00000001';
// Noon in Beijing on the fixture's last day: its last row is still ahead.
const READ_AT = Date.parse('2026-03-06T04:00:00Z');
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('GZYL tracking adapter', () => {
  it('asks GZYL’s Hualei tracker for the whole number over plain HTTP and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new GzylTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' gztest00000001 ', { budgetMs: 4000 }))
      .resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${GZYL_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(GZYL_ORIGIN).toBe('http://134.175.243.207:8082');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: expect.stringContaining('application/json'), 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'gzyl', step: 'direct', outcome: 'ok' }));
    const instance = adapter(environment(fetcher));
    expect(instance).toMatchObject({ id: 'gzyl', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the English timeline GZYL writes, up to the lookup', () => {
    const result = parseGzylTrack(fixture('track'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map',
      last_status_text: 'local carrier Agent Import customs clearance', last_update: '2026-03-05T09:31:20+08:00',
      expected_delivery: null, service_name: 'Synthetic Line PD', destination_country: 'CH',
    });
    expect(result.events).toEqual([
      { time: '2026-03-05T09:31:20+08:00', description: 'local carrier Agent Import customs clearance', stage: 'customs', stage_source: 'carrier_map', written_at: '2026-03-05T09:31:20+08:00' },
      { time: '2026-03-04T14:40:05+08:00', description: 'Item arrives at destination airport', stage: 'in_transit', stage_source: 'carrier_map', written_at: '2026-03-04T14:40:05+08:00' },
      { time: '2026-03-03T14:02:11+08:00', description: 'Departing from the airport', stage: 'in_transit', stage_source: 'carrier_map', written_at: '2026-03-03T14:02:11+08:00' },
      { time: '2026-03-03T08:55:39+08:00', description: 'Goods leave the operation center', stage: 'in_transit', stage_source: 'carrier_map', written_at: '2026-03-03T08:55:39+08:00' },
      { time: '2026-03-02T15:07:14+08:00', description: 'Arrive at the cross border receiving point', stage: 'accepted', stage_source: 'carrier_map', written_at: '2026-03-02T15:07:14+08:00' },
      { time: '2026-03-01T22:36:51+08:00', description: 'Order information received', stage: 'registered', stage_source: 'carrier_map', written_at: '2026-03-01T22:36:51+08:00' },
    ]);
  });

  it('recognizes a waybill the tracker holds and the page’s unknown answer', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('track')))
      .mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
    await expect(adapter(environment(fetcher)).recognize!('NOTFOUND000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('settles the interface’s no-row answer with the page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: 'NOTFOUND000001' })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${GZYL_ORIGIN}/trackIndex.htm`);
    expect(parseGzylPage(page('page'), NUMBER, READ_AT)).toMatchObject({ current_stage: 'customs', destination_country: 'CH' });
    expect(normalizeGzylNumber('shop-ref-0001')).toBe('SHOP-REF-0001');
  });

  it('maps every wording it lists, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'gzyl', providerCode: null, description: 'Goods leave the operation center' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'gzyl', providerCode: null, description: 'Synthetic wording' })).toEqual({ kind: 'unknown' });
    // The destination network writes its distribution centre's town into the wording.
    expect(statusMapAnswer({ carrier: 'gzyl', providerCode: null, description: 'Arrival sorting, distribution center Sampletown' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'gzyl', providerCode: null, description: 'Arrival sorting, distribution centers' })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'gzyl', providerCode: null, description: 'Leaving the sorting center Sampletown' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'gzyl', providerCode: null, description: 'Package is on the way' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'gzyl', providerCode: null, description: 'Delivered Sampletown' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'gzyl', providerCode: null, description: 'Delivered Sample ?own 00-000' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'gzyl', providerCode: null, description: 'Delivered to the parcel locker' })).toEqual({ kind: 'unknown' });
    // Or its city after the wording, in brackets.
    expect(statusMapAnswer({ carrier: 'gzyl', providerCode: null, description: 'Los Angeles Processing Center has received it [Los Angeles]' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    for (const wording of PLACED_WORDINGS) expect(statuses.entries.map((entry) => entry.wording)).toContain(wording);
  });

  it('reads the town GZYL writes after a wording as the scan’s place', () => {
    expect(splitGzylRow('Package is on the way Sampletown', '')).toEqual({ content: 'Package is on the way', location: 'Sampletown' });
    expect(splitGzylRow('leaving the  sorting center Sample-Town 00000', '')).toEqual({ content: 'leaving the sorting center', location: 'Sample-Town 00000' });
    expect(splitGzylRow('Arrival sorting, distribution center Sampletown', 'Sampletown')).toEqual({ content: 'Arrival sorting, distribution center', location: 'Sampletown' });
    expect(splitGzylRow('Arrival sorting, distribution centers', '')).toEqual({ content: 'Arrival sorting, distribution centers', location: '' });
    expect(splitGzylRow('Package is on the way, see the partner', '')).toEqual({ content: 'Package is on the way, see the partner', location: '' });
    expect(splitGzylRow('Goods leave the operation center', '')).toEqual({ content: 'Goods leave the operation center', location: '' });
    expect(splitGzylRow('Delivered Sampletown', '')).toEqual({ content: 'Delivered', location: 'Sampletown' });
    expect(splitGzylRow('Delivered Sample ?own 00-000', '')).toEqual({ content: 'Delivered', location: 'Sample ?own 00-000' });
    expect(splitGzylRow('Delivered to the neighbour', '')).toEqual({ content: 'Delivered to the neighbour', location: '' });

    const reply = structuredClone(fixture('track')) as [{ data: [{ trackDetails: Record<string, string>[] }] }];
    const details = reply[0].data[0].trackDetails;
    details.splice(1, 0, { ...details[1]!, track_content: 'Package is on the way Sampletown 00000', track_date: '2026-03-06 10:00:00',
      track_createdate: '2026-03-06 10:00:00' });
    const result = parseGzylTrack(reply, NUMBER, READ_AT)!;
    expect(result.events![0]).toMatchObject({ description: 'Package is on the way', location: 'Sampletown', stage: 'in_transit' });
    expect(result.last_status_text).toBe('Package is on the way');
  });

  it('links no plain-HTTP page', () => {
    expect(carrier.portal).not.toHaveProperty('url');
    expect(carrier.portal).not.toHaveProperty('searchUrl');
    expect(carrier.portal.canaryUrl).toMatch(/^https:\/\//);
  });
});
