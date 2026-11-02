import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, MesoGlobalTracker } from './adapter.js';
import { MESO_GLOBAL_ORIGIN, parseMesoGlobalPage, parseMesoGlobalTrack } from './parser.js';
import { mesoGlobalEnglish, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'ZZZZ0000000001';
const UNKNOWN = 'ZZZZ0000000009';
// A day after the last flight row, on Beijing's clock.
const READ_AT = Date.parse('2026-03-12T08:00:00Z');
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Meso-global numbers', () => {
  it('reads the number out of a link to its tracker', () => {
    expect(parseTrackingInput(`http://www.mesoglobal.cc:8082/trackIndex.htm?documentCode=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'meso-global' });
  });

  it('takes 17TRACK’s name for the forwarder, and its Chinese one', () => {
    for (const name of ['Meso-global', 'Meso Global', '中际跨境']) expect(carrierIdFromName(name), name).toBe('meso-global');
  });
});

describe('Meso-global tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track')));
    await expect(new MesoGlobalTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase())).resolves.toMatchObject({ destination_country: 'DE' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${MESO_GLOBAL_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(MESO_GLOBAL_ORIGIN).toBe('http://www.mesoglobal.cc:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'meso-global', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the rows on Beijing time in English with the stages its map gives, without the parties', () => {
    const result = parseMesoGlobalTrack(fixture('track'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Connecting flight departed, not yet landed',
      last_update: '2026-03-11T02:32:10+08:00', service_name: 'Synthetic EU Line', destination_country: 'DE',
    });
    expect(result.events!.map(({ time, description, stage }) => ({ time, description, stage }))).toEqual([
      { time: '2026-03-11T02:32:10+08:00', description: 'Connecting flight departed, not yet landed', stage: 'in_transit' },
      { time: '2026-03-07T01:55:40+08:00', description: 'First flight landed, connecting flight booked', stage: 'in_transit' },
      { time: '2026-03-06T01:40:05+08:00', description: 'Flight departed, not yet landed', stage: 'in_transit' },
      { time: '2026-03-04T01:57:30+08:00', description: 'Flight booked', stage: 'in_transit' },
      { time: '2026-03-02T06:35:15+08:00', description: 'Left the warehouse', stage: 'in_transit' },
      { time: '2026-03-01T08:56:20+08:00', description: 'Arrived at the receiving point', stage: 'accepted' },
      { time: '2026-03-01T06:43:00+08:00', description: 'Shipment information received', stage: 'registered' },
    ]);
    expect(result.delivery_carrier).toBeUndefined();
    const text = JSON.stringify(result);
    for (const value of ['Synthetic Recipient', 'Example Street', 'MG-TEST-001', 'MGTEST0000000000001']) expect(text, value).not.toContain(value);
  });

  it('holds back a row dated after the lookup', () => {
    const result = parseMesoGlobalTrack(fixture('track'), NUMBER, Date.parse('2026-03-08T00:00:00Z'))!;
    expect(result).toMatchObject({ last_status_text: 'First flight landed, connecting flight booked' });
    expect(result.events).toHaveLength(6);
  });

  it('reads the page’s unknown-number answer as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${MESO_GLOBAL_ORIGIN}/trackIndex.htm`);
    expect(() => parseMesoGlobalPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow('could not locate');
  });

  it('maps every wording it lists by wording alone, a flight or hand-over row whatever day it names, and the app reads the map', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      if (entry.english) expect(statusMap.stage(null, normalizeStatusWording(entry.english)), entry.english).toBe(entry.stage);
    }
    expect(statusMap.stage(null, '10-31 已交仓 留意官网更新')).toBe('in_transit');
    expect(mesoGlobalEnglish(null, '1-5 已交仓 留意官网更新')).toBe("Handed over to the delivery carrier's depot; watch its website for updates");
    for (const wording of ['预计10-22飞', '预计1-5飞']) {
      expect(statusMap.stage(null, wording), wording).toBe('in_transit');
      expect(mesoGlobalEnglish(null, wording), wording).toBe('Flight booked');
    }
    expect(mesoGlobalEnglish(null, '一程已落地 二程预计10-27飞')).toBe('First flight landed, connecting flight booked');
    expect(statusMap.stage(null, '预计飞机')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'meso-global', providerCode: null, description: '到达收货点' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'meso-global', providerCode: null, description: '合成的记录' })).toEqual({ kind: 'unknown' });
  });
});
