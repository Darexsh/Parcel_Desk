import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { InvalidInputError, NoHistoryError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, BESTFULFILL_API } from './adapter.js';
import { normalizeBestfulfillNumber, parseBestfulfill } from './parser.js';
import { bestfulfillStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'BEST00000000000001';
type Reply = { number: string; localNumber: string; destCountry: string; events: Record<string, string>[] };
const fixture = (): Reply => JSON.parse(readFileSync(new URL('./fixtures/found.json', import.meta.url), 'utf8')) as Reply;
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const MISSING = { error: 'tracking not found' };

describe('BestFulfill Packet numbers', () => {
  it('takes BEST and fourteen digits', () => {
    for (const raw of [NUMBER, 'best00000000000001', 'BEST 0000 0000 0000 01']) expect(normalizeBestfulfillNumber(raw), raw).toBe(NUMBER);
    for (const raw of ['BEST0000000000001', 'BEST000000000000001', 'BES000000000000001', '']) {
      expect(() => normalizeBestfulfillNumber(raw), raw).toThrow('BEST and fourteen digits');
    }
  });

  it('refuses another shape before asking', async () => {
    const fetcher = replying(() => json(fixture()));
    await expect(carrier(fetcher).track({ number: 'BEST1' })).rejects.toThrow(InvalidInputError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('BestFulfill Packet tracking', () => {
  it('asks the open service for the number once', async () => {
    const fetcher = replying(() => json(fixture()));
    await carrier(fetcher).track({ number: NUMBER });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(`${BESTFULFILL_API}?number=${NUMBER}`);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'GET' });
  });

  it('reads the scans newest first, with their offsets, places without the ZIP code and the last-mile number', async () => {
    const result = await carrier(replying(() => json(fixture()))).track({ number: NUMBER });
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: '2026-01-12T13:03:18-05:00', destination_country: 'US', delivery_tracking_number: '9200000000000000000001',
    });
    const events = result.events ?? [];
    expect(events).toHaveLength(11);
    expect(events[0]).toEqual({ time: '2026-01-12T13:03:18-05:00', description: 'Delivered', location: 'SAMPLE TOWN, NY',
      provider_code: 'Delivered_Other', stage: 'delivered', stage_source: 'carrier_map' });
    // Scans of one instant keep the service's order.
    expect(events.slice(1, 3).map((event) => event.description)).toEqual(['Out for Delivery, Expected Delivery Between 11:15am and 1:15pm', 'Out for Delivery']);
    expect(events.at(-1)).toEqual({ time: '2026-01-05T07:25:20+00:00', description: 'order received',
      provider_code: 'InfoReceived_InfoReceived', stage: 'registered', stage_source: 'carrier_map' });
    expect(events.find((event) => event.description === 'PICK UP')).toMatchObject({ location: 'Sample Origin', stage: 'accepted' });
  });

  it('prefers the last-mile number the reply names', () => {
    const reply = { ...fixture(), localNumber: 'synthetic9200000000000000000002' };
    expect(parseBestfulfill(reply, NUMBER).delivery_tracking_number).toBe('SYNTHETIC9200000000000000000002');
  });

  it('reads customs done as transit, a customs hold as customs, and a delivery code only with a delivery\'s wording', () => {
    expect(bestfulfillStage('InTransit_CustomsProcessing', 'Export customs clearance completed')?.stage).toBe('in_transit');
    expect(bestfulfillStage('InTransit_CustomsProcessing', 'customs cleared')?.stage).toBe('in_transit');
    expect(bestfulfillStage('InTransit_CustomsProcessing', 'Synthetic import processing')).toEqual({ stage: 'customs', source: 'carrier_map' });
    expect(bestfulfillStage('Delivered_Other', 'Synthetic scan')?.stage).not.toBe('delivered');
    expect(bestfulfillStage(null, 'Synthetic scan')).toBeNull();
  });

  it('reads a scan the map does not know as unknown, not as a stage', () => {
    const reply = fixture();
    reply.events = [{ time: '2026-01-05T07:25:20+00:00', location: '', content: 'Synthetic scan', status: '' }];
    expect(parseBestfulfill(reply, NUMBER)).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic scan' });
    expect(parseBestfulfill(reply, NUMBER).current_stage).toBeUndefined();
  });

  it('reads the service\'s own 404 as not found, and no scans as no history', async () => {
    await expect(carrier(replying(() => json(MISSING, { status: 404 }))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(replying(() => json({ ...fixture(), events: [] }))).track({ number: NUMBER })).rejects.toThrow(NoHistoryError);
  });

  it('keeps another number, a changed reply, a bot check, a moved service, a rate limit and an outage apart from a missing parcel', async () => {
    const scan = fixture();
    scan.events[0]!.time = '2026-01-05 07:25:20';
    const cases: [Response, string][] = [
      [json({ ...fixture(), number: 'BEST00000000000002' }), 'indeterminate'],
      [json({ ...fixture(), events: null }), 'schema'],
      [json(scan), 'schema'],
      [json('<html><body>not json</body></html>'), 'schema'],
      [json('<html><head><title>Just a moment...</title></head></html>'), 'challenge'],
      [json('<!DOCTYPE html><html><body>404</body></html>', { status: 404 }), 'transport'],
      [json({ error: 'Missing tracking number.' }, { status: 404 }), 'transport'],
      [json('', { status: 302, headers: { Location: 'https://www.bestfulfillpacket.com/' } }), 'transport'],
      [json('', { status: 429 }), 'rate_limited'],
      [json('{"error":"Internal Server Error"}', { status: 500 }), 'indeterminate'],
    ];
    for (const [response, kind] of cases) {
      await expect(carrier(replying(() => response.clone())).track({ number: NUMBER }), kind).rejects.toMatchObject({ kind });
    }
  });

  it('recognizes a number the service holds, and not one it does not', async () => {
    await expect(carrier(replying(() => json(fixture()))).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
    await expect(carrier(replying(() => json(MISSING, { status: 404 }))).recognize!(NUMBER)).resolves.toEqual({ known: false });
  });
});

describe('BestFulfill Packet status map', () => {
  it('stages every row it lists, and the app reads it', () => {
    for (const { code, wording, stage } of statuses.entries) expect(statusMap.stage(code, wording), wording).toBe(stage);
    expect(statusMapAnswer({ carrier: 'bestfulfill', providerCode: 'OutForDelivery_Other', description: 'Out for Delivery' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
  });
});
