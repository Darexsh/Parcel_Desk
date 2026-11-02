import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, WE_WORLD_TRACK } from './adapter.js';
import { normalizeWeWorldNumber, parseWeWorld } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'WWETA9900000001YQ';
const UNKNOWN = 'WWETA9900000009YQ';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as { data: string; success: boolean };
/** The shipment fixture with its rows changed. */
const withRows = (change: (rows: Record<string, unknown>[]) => void) => {
  const reply = fixture('shipment');
  const order = JSON.parse(reply.data) as { events: { event: Record<string, unknown>[] }[] };
  change(order.events[0]!.event);
  return { ...reply, data: JSON.stringify(order) };
};
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json;charset=UTF-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());

describe('We World Express numbers', () => {
  it('takes WWE, two letters, ten digits and YQ and suggests them, without recognition, which the tracker is too slow for', () => {
    expect(normalizeWeWorldNumber(` ${NUMBER.toLowerCase()} `)).toBe(NUMBER);
    for (const other of ['WWETA990000001YQ', 'WWET9900000001YQ', 'WWXTA9900000001YQ', 'WWETA9900000001YX']) {
      expect(() => normalizeWeWorldNumber(other), other).toThrow('WWE, two letters, ten digits and YQ');
    }
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['we-world-express'] });
    expect(recognitionCandidates(NUMBER, {})).toEqual([]);
  });
});

describe('We World Express tracking adapter', () => {
  it('asks the tracking page’s endpoint for the whole number in English', async () => {
    const fetcher = replying(() => json(fixture('shipment')));
    await expect(carrier(fetcher).track({ number: NUMBER.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(WE_WORLD_TRACK);
    expect(WE_WORLD_TRACK).toBe('https://www.weworldexpress.com/wwe/queryTrack2');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(JSON.parse(String(init!.body))).toEqual({ orderIds: [NUMBER], language: 'en_US' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(carrier(fetcher)).toMatchObject({ id: 'we-world-express', recordsSteps: true, steps: ['direct', 'retry'] });
    expect(carrier(fetcher)).not.toHaveProperty('recognize');
  });

  it('reads the scans newest first on their stated offsets, without the rows the page leaves out, and Aras Kargo’s number', () => {
    const result = parseWeWorld(fixture('shipment'), NUMBER);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: '2026-03-11T12:10:00+03:00', delivery_carrier: 'aras-kargo', delivery_tracking_number: '6400000000001',
    });
    expect(result.events!.map(({ time, local_time, description, location, provider_code, stage }) => [time ?? local_time, description, location, provider_code, stage])).toEqual([
      ['2026-03-11T12:10:00+03:00', 'Delivered', 'Turkey', '99', 'delivered'],
      ['2026-03-11T04:41:00+03:00', 'In transit to Delivery Unit', 'Turkey', '15', 'in_transit'],
      ['2026-03-10T17:20:10+03:00', 'Arrived at Transfer Center', 'Turkey', '14', 'in_transit'],
      ['2026-03-10T14:16:04+03:00', 'Loaded to truck to be sent to destination branch', 'Turkey', '13', 'in_transit'],
      ['2026-03-10T08:51:16+03:00', 'Handed over To Aras Cargo', 'TURKEY', '-2058', 'in_transit'],
      ['2026-03-09T15:06:23+03:00', 'Weighted', undefined, '19', 'accepted'],
      // The page's own wording, without the operator its remark names.
      ['2026-03-09T15:06:23+03:00', 'Collected at warehouse', undefined, '07', 'accepted'],
      // The order's row states no offset and keeps its wall clock.
      ['2026-02-18T21:54:13', 'Order Created', 'CN', '00', 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/API|TR-SYN|解绑/);
  });

  it('names Aras Kargo only once a row hands the parcel to it', () => {
    const ordered = parseWeWorld(withRows((rows) => rows.splice(4)), NUMBER);
    expect(ordered).toMatchObject({ current_stage: 'accepted' });
    expect(ordered).not.toHaveProperty('delivery_carrier');
    expect(ordered).not.toHaveProperty('delivery_tracking_number');
  });

  it('reads the tracker’s missing order as not found, and other answers as no answer', async () => {
    await expect(carrier(replying(() => json(fixture('unknown')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseWeWorld({ data: '{"errorMessage":"Too many requests"}', success: false }, NUMBER)).toThrow('did not complete');
    expect(() => parseWeWorld(fixture('shipment'), UNKNOWN)).toThrow('another number');
    expect(() => parseWeWorld(withRows((rows) => rows.splice(0)), NUMBER)).toThrow('without scans');
    expect(() => parseWeWorld({ ...fixture('shipment'), data: '<html>' }, NUMBER)).toThrow('not JSON');
    expect(() => parseWeWorld({ success: true, data: '{"events":[]}' }, NUMBER)).toThrow('without its order');
    expect(() => parseWeWorld(withRows((rows) => { rows[1]!.timeUtc = 'GMT+3'; }), NUMBER)).toThrow('invalid scan time');
    expect(() => parseWeWorld(withRows((rows) => { rows[1]!.eventTime = '09/03/2026 15:06'; }), NUMBER)).toThrow('invalid scan time');
    await expect(carrier(replying(() => json({}, { status: 404 }))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'transport' });
  });

  it('maps each code with its wording, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'we-world-express', providerCode: '-2058', description: 'Handed over To Aras Cargo' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMap.stage('14', normalizeStatusWording('Delivered'))).toBeUndefined();
  });
});
