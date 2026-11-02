import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, WiioTracker } from './adapter.js';
import { parseWiioPage, parseWiioTrack, WIIO_ORIGIN } from './parser.js';
import { ENTRIES, statusMap } from './status.js';

const NUMBER = 'ZLXHC9900000001YQ';
const UNKNOWN = 'ZLXHC9900000009YQ';
const DELIVERY = 'H00SYN0000000001';
// Noon in Beijing on 12 March, after every row.
const READ_AT = Date.parse('2026-03-12T04:00:00Z');
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Wiio numbers', () => {
  it('suggests ZLX, two letters, ten digits and two letters, and recognition asks the tracker about them', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['wiio'] });
    expect(recognitionCandidates(NUMBER, {}).map((candidate) => candidate.carrier)).toEqual(['wiio']);
    for (const other of ['ZLXHC990000001YQ', 'ZLXHC99000000001YQ', 'ZLYHC9900000001YQ', 'ZLXH99900000001YQ', 'ZLXHC9900000001Y']) {
      expect(detectCarrierMatch(other).candidates ?? [], other).not.toContain('wiio');
    }
  });
});

describe('Wiio tracking adapter', () => {
  it('asks PD Express’s Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track')));
    await expect(new WiioTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase())).resolves.toMatchObject({ destination_country: 'GB' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${WIIO_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(WIIO_ORIGIN).toBe('http://www.hzpdex.com:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'wiio', recordsSteps: true, steps: ['direct', 'retry'], recognize: expect.any(Function) });
  });

  it('reads its own rows on Beijing time and the airline’s and delivery carrier’s on their wall clocks, without the parties', () => {
    const result = parseWiioTrack(fixture('track'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2026-03-10T13:20:00', service_name: 'Synthetic UK Line', destination_country: 'GB',
      delivery_tracking_number: DELIVERY,
    });
    expect(result.canonical_tracking_number).toBeUndefined();
    expect(result.delivery_carrier).toBeUndefined();
    expect(result.events!.map(({ time, local_time, description, location, stage }) => ({ at: time ?? local_time, description, location, stage }))).toEqual([
      { at: '2026-03-10T13:20:00', description: 'Delivered', location: undefined, stage: 'delivered' },
      { at: '2026-03-10T07:06:00', description: 'Out for delivery', location: undefined, stage: 'out_for_delivery' },
      { at: '2026-03-10T01:48:00', description: 'At the customers local depot', location: undefined, stage: 'in_transit' },
      { at: '2026-03-09T21:42:00', description: 'Entered the Evri network', location: undefined, stage: 'in_transit' },
      { at: '2026-03-08T16:17:25+08:00', description: 'Released from customs', location: 'LHR', stage: 'in_transit' },
      { at: '2026-03-07T19:21:00', description: 'Shipment arrived at airport', location: 'LHR', stage: 'in_transit' },
      { at: '2026-03-06T16:04:00', description: 'Shipment departed from airport', location: 'PVG', stage: 'in_transit' },
      { at: '2026-03-05T15:09:21+08:00', description: 'Flight delay', location: 'CN', stage: undefined },
      { at: '2026-03-03T05:32:18+08:00', description: 'Shipment departed from facility', location: 'SHANGHAI', stage: 'in_transit' },
      { at: '2026-03-02T20:10:14+08:00', description: 'Shipment arrived at facility', location: 'HANGZHOU', stage: 'in_transit' },
      { at: '2026-03-01T11:17:28+08:00', description: 'Goods information has been received', location: undefined, stage: 'registered' },
      { at: '2026-03-01T11:17:28+08:00', description: 'Shipment information received', location: undefined, stage: 'registered' },
    ]);
    const text = JSON.stringify(result);
    for (const value of ['Synthetic Recipient', 'Synthetic Street', 'XX0 0XX', 'Synthetic Shop', 'Synthetic Signatory', 'SYNTHETICREF0001']) {
      expect(text, value).not.toContain(value);
    }
  });

  it('reads the page’s unknown-number answer as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${WIIO_ORIGIN}/trackIndex.htm`);
    expect(() => parseWiioPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow('could not locate');
  });

  it('maps every wording it lists by wording alone, leaves the flight delay unstaged on purpose, and the app reads the map', () => {
    for (const entry of ENTRIES) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'wiio', providerCode: null, description: 'Entered the Evri network' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'wiio', providerCode: null, description: 'Flight delay' })).toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'wiio', providerCode: null, description: '合成的记录' })).toEqual({ kind: 'unknown' });
  });
});
