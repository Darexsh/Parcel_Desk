import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, YilongTracker } from './adapter.js';
import { parseYilongPage, parseYilongTrack, YILONG_ORIGIN } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import carrier from './carrier.json' with { type: 'json' };

const NUMBER = 'YIL990000001WL';
const UNKNOWN = 'YIL990000009WL';
// Noon in Beijing on 6 March, after the fixture's rows.
const READ_AT = Date.parse('2026-03-06T04:00:00Z');
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Yilong Logistics numbers', () => {
  it('claims YIL, nine digits and WL, and nothing shorter, longer or under another prefix or suffix', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'yilong-logistics', confidence: 'high', candidates: ['yilong-logistics'] });
    for (const other of ['YIL99000001WL', 'YIL9900000001WL', 'YIX990000001WL', 'YIL990000001WX', 'XYIL990000001WL']) {
      expect(detectCarrierMatch(other).candidates ?? [], other).not.toContain('yilong-logistics');
    }
  });
});

describe('Yilong Logistics tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track')));
    await expect(new YilongTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase())).resolves.toMatchObject({ current_stage: 'in_transit' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${YILONG_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(YILONG_ORIGIN).toBe('http://www.yxhlexpress.com:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'yilong-logistics', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads its warehouse, customs and airline rows on Beijing time, without the parties', () => {
    const result = parseYilongTrack(fixture('track'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Package handed over to airline',
      last_update: '2026-03-05T08:12:26+08:00', service_name: 'Synthetic Line', destination_country: 'US',
    });
    expect(result.events).toEqual([
      { time: '2026-03-05T08:12:26+08:00', description: 'Package handed over to airline', stage: 'in_transit', stage_source: 'carrier_map', written_at: '2026-03-05T08:12:26+08:00' },
      { time: '2026-03-04T23:12:16+08:00', description: 'Customs export clearance completed', stage: 'in_transit', stage_source: 'carrier_map', written_at: '2026-03-04T23:12:16+08:00' },
      { time: '2026-03-03T19:32:51+08:00', description: 'Package departed from the warehouse', location: 'Shenzhen', provider_code: 'SHIPMENT',
        stage: 'in_transit', stage_source: 'carrier_map', written_at: '2026-03-03T19:32:51+08:00' },
      { time: '2026-03-03T05:00:18+08:00', description: 'Package received and scanned at warehouse', location: 'Shenzhen', provider_code: 'ARRIVAL',
        stage: 'accepted', stage_source: 'carrier_map', written_at: '2026-03-03T05:00:18+08:00' },
    ]);
    expect(result.canonical_tracking_number ?? result.delivery_tracking_number).toBeUndefined();
    const text = JSON.stringify(result);
    for (const value of ['Synthetic Recipient', 'Synthetic Shop', 'YL-TEST-001', 'YLTEST0000000000001']) expect(text, value).not.toContain(value);
  });

  it('reads the page’s unknown-number answer as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${YILONG_ORIGIN}/trackIndex.htm`);
    expect(() => parseYilongPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow('could not locate');
  });

  it('maps every wording it lists by wording alone, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'yilong-logistics', providerCode: 'ARRIVAL', description: 'Package received and scanned at warehouse' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'yilong-logistics', providerCode: null, description: '合成的记录' })).toEqual({ kind: 'unknown' });
    expect(carrier.portal).not.toHaveProperty('url');
  });
});
