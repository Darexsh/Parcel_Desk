import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, PengyouTracker } from './adapter.js';
import { PENGYOU_ORIGIN, parsePengyouPage, parsePengyouTrack, splitPengyouRow } from './parser.js';
import { ENTRIES, statusMap } from './status.js';

const NUMBER = 'ZXA990000001PY';
const UNKNOWN = 'ZXA990000009PY';
// Noon in Beijing on 6 March: after the two rows written at their clocks, among the rows written ahead.
const READ_AT = Date.parse('2026-03-06T04:00:00Z');
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Pengyou numbers', () => {
  it('suggests three letters, nine digits and PY, and recognition asks the tracker about them', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['pengyou'] });
    expect(recognitionCandidates(NUMBER, {}).map((candidate) => candidate.carrier)).toEqual(['pengyou']);
    for (const other of ['ZXA99000001PY', 'ZXA9900000001PY', 'ZX990000001PY', 'ZXA990000001PX', 'ZXA990000001PYX']) {
      expect(detectCarrierMatch(other).candidates ?? [], other).not.toContain('pengyou');
    }
  });
});

describe('Pengyou tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track')));
    await expect(new PengyouTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase())).resolves.toMatchObject({ destination_country: 'FR' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${PENGYOU_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(PENGYOU_ORIGIN).toBe('http://120.77.149.241:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'pengyou', recordsSteps: true, steps: ['direct', 'retry'], recognize: expect.any(Function) });
  });

  it('holds back the timeline written ahead and reads the rows written at their clocks, without the parties', () => {
    const result = parsePengyouTrack(fixture('track'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Shipment arrived at facility',
      last_update: '2026-03-02T18:40:00+08:00', service_name: 'Synthetic Air Line', destination_country: 'FR',
    });
    expect(result.events!.map(({ time, description }) => ({ time, description }))).toEqual([
      { time: '2026-03-02T18:40:00+08:00', description: 'Shipment arrived at facility' },
      { time: '2026-03-01T10:15:01+08:00', description: 'Shipment information received' },
    ]);
    // Rows written two days or more before their clocks never show, even once their clocks pass,
    // and the record's summary, already "Delivered", is not read.
    const later = parsePengyouTrack(fixture('track'), NUMBER, Date.parse('2026-03-12T04:00:00Z'))!;
    expect(later.events).toHaveLength(2);
    expect(later.current_stage).toBe('in_transit');
    const text = JSON.stringify(later);
    for (const value of ['Delivered', 'Out for delivery', 'Departed from facility', 'Synthetic Recipient', 'Synthetic Shop', 'PY-TEST-001', 'PYTEST0000000000001']) {
      expect(text, value).not.toContain(value);
    }
  });

  it('has no history for an order none of whose rows is due yet', () => {
    expect(() => parsePengyouTrack(fixture('track'), NUMBER, Date.parse('2026-03-01T02:00:00Z'))).toThrow('no scans');
  });

  it('reads the page’s unknown-number answer as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${PENGYOU_ORIGIN}/trackIndex.htm`);
    expect(() => parsePengyouPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow('could not locate');
  });

  it('stages a row by its wording without the place in brackets after it', () => {
    const payload = structuredClone(fixture('track')) as [{ data: [{ trackDetails: { track_content: string }[] }] }];
    const scan = 'Shenzhen Processing Center has received it [Shenzhen City]';
    payload[0].data[0].trackDetails.find((row) => row.track_content === 'Shipment arrived at facility')!.track_content = scan;
    expect(parsePengyouTrack(payload, NUMBER, READ_AT)).toMatchObject({
      status: 'in_transit', current_stage: 'accepted', current_stage_source: 'carrier_map', last_status_text: scan,
    });
    expect(statusMapAnswer({ carrier: 'pengyou', providerCode: null, description: scan })).toEqual({ kind: 'mapped', stage: 'accepted' });
  });

  it('reads a delivery’s town as its place, on Beijing’s clock, without the postal code', () => {
    const payload = structuredClone(fixture('track')) as [{ data: [{ trackDetails: { track_content: string; track_location: string }[] }] }];
    // The delivery leaves the row's place empty.
    Object.assign(payload[0].data[0].trackDetails.find((row) => row.track_content === 'Shipment arrived at facility')!,
      { track_content: 'Delivered Sample TownZ9Z 9Z9', track_location: '' });
    const result = parsePengyouTrack(payload, NUMBER, READ_AT)!;
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered' });
    expect(result.events![0]).toMatchObject({ time: '2026-03-02T18:40:00+08:00', description: 'Delivered', location: 'Sample Town' });
    expect(JSON.stringify(result)).not.toContain('Z9Z');
    for (const [content, location] of [['Delivered Sample Town ST 00000', 'Sample Town ST'], ['Delivered Sample Town ZZ9 9ZZ', 'Sample Town'],
      ['Delivered  Sample Town', 'Sample Town']]) expect(splitPengyouRow(content!, ''), content).toEqual({ content: 'Delivered', location });
    for (const content of ['Delivered', 'Delivered to airline DC', 'Delivered 1 Sample Street', 'Delivered Sample 1 Street', 'Shipment arrived at facility']) {
      expect(splitPengyouRow(content, ''), content).toEqual({ content, location: '' });
    }
    expect(splitPengyouRow('Delivered Sample Town', 'Sample City')).toEqual({ content: 'Delivered Sample Town', location: 'Sample City' });
  });

  it('maps every wording it lists by wording alone, and the app reads the map', () => {
    for (const entry of ENTRIES) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    for (const description of ['Delivered Sample Town ST', 'Delivered Sample Town']) {
      expect(statusMapAnswer({ carrier: 'pengyou', providerCode: null, description })).toEqual({ kind: 'mapped', stage: 'delivered' });
    }
    for (const description of ['Delivered to airline DC', 'Delivered at the door', 'Undelivered Sample Town ST']) {
      expect(statusMap.stage(null, normalizeStatusWording(description)), description).toBeUndefined();
    }
    expect(statusMapAnswer({ carrier: 'pengyou', providerCode: null, description: '合成的记录' })).toEqual({ kind: 'unknown' });
  });
});
