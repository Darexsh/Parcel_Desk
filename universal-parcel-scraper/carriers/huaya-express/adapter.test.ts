import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, HuayaTracker } from './adapter.js';
import { HUAYA_ORIGIN, parseHuayaPage, parseHuayaTrack } from './parser.js';
import { ENTRIES, statusMap } from './status.js';

const NUMBER = 'HYYT990000000001GZ';
const UNKNOWN = 'HYYT990000000009GZ';
// A day after the hand-over row, on Beijing's clock.
const READ_AT = Date.parse('2026-03-15T08:00:00Z');
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Huaya Express numbers', () => {
  it('names Huaya Express for HYYT, twelve digits and GZ only', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'huaya-express', confidence: 'high' });
    for (const other of ['HYYT99000000001GZ', 'HYYT9900000000001GZ', 'HYYT990000000001SZ', 'HYT990000000001GZ', 'HYYT990000000001GZX']) {
      const match = detectCarrierMatch(other);
      expect([match.carrier, ...(match.candidates ?? [])], other).not.toContain('huaya-express');
    }
  });

  it('reads the number out of a link to its tracker', () => {
    expect(parseTrackingInput(`http://193.112.176.17:8082/trackIndex.htm?documentCode=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'huaya-express' });
  });

  it('takes 17TRACK’s name for the forwarder', () => {
    for (const name of ['GZHY', 'Huaya Express', '华亚运通']) expect(carrierIdFromName(name), name).toBe('huaya-express');
  });
});

describe('Huaya Express tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track')));
    await expect(new HuayaTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase())).resolves.toMatchObject({ destination_country: 'GB' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${HUAYA_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(HUAYA_ORIGIN).toBe('http://193.112.176.17:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'huaya-express', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the rows on Beijing time with the stages its map gives, without the parties', () => {
    const result = parseHuayaTrack(fixture('track'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'It has been handed over to the service provider.',
      last_update: '2026-03-14T15:26:01+08:00', service_name: 'Synthetic UK Line', destination_country: 'GB',
    });
    expect(result.events!.map(({ time, description, stage }) => ({ time, description, stage }))).toEqual([
      { time: '2026-03-14T15:26:01+08:00', description: 'It has been handed over to the service provider.', stage: 'in_transit' },
      { time: '2026-03-05T15:55:50+08:00', description: 'Customs import clearance completed, awaiting pickup by local carrier', stage: 'in_transit' },
      { time: '2026-03-05T09:23:26+08:00', description: 'Package arrived at destination country', stage: 'in_transit' },
      { time: '2026-03-03T17:04:14+08:00', description: 'Package in transit to destination country', stage: 'in_transit' },
      { time: '2026-03-03T04:14:26+08:00', description: 'Package handed over to airline', stage: 'in_transit' },
      { time: '2026-03-02T03:37:14+08:00', description: 'Customs export clearance completed', stage: 'in_transit' },
      { time: '2026-03-01T03:08:26+08:00', description: 'Package departed from the warehouse', stage: 'in_transit' },
      { time: '2026-03-01T02:41:26+08:00', description: 'Package received & scanned at warehouse', stage: 'accepted' },
    ]);
    expect(result.delivery_carrier).toBeUndefined();
    const text = JSON.stringify(result);
    for (const value of ['Synthetic Recipient', 'Example Street', 'HY-TEST-001', 'HYTEST0000000000001']) expect(text, value).not.toContain(value);
  });

  it('holds back a row dated after the lookup', () => {
    const result = parseHuayaTrack(fixture('track'), NUMBER, Date.parse('2026-03-10T00:00:00Z'))!;
    expect(result).toMatchObject({ last_status_text: 'Customs import clearance completed, awaiting pickup by local carrier' });
    expect(result.events).toHaveLength(7);
  });

  it('reads the page’s unknown-number answer as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${HUAYA_ORIGIN}/trackIndex.htm`);
    expect(() => parseHuayaPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow('could not locate');
  });

  it('maps every wording it lists by wording alone, and the app reads the map', () => {
    for (const entry of ENTRIES) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'huaya-express', providerCode: null, description: 'Package received & scanned at warehouse' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'huaya-express', providerCode: null, description: '合成的记录' })).toEqual({ kind: 'unknown' });
  });
});
