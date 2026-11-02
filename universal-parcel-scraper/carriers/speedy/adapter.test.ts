import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SPEEDY_ENDPOINT, SpeedyTracker } from './adapter.js';
import { parseSpeedy, parseSpeedyReply } from './parser.js';
import { speedyOperation, speedyPhase, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const COLLECTED = '69000000001';
const PARTNER = '69000000002';
const RETURNED = '69000000003';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = (name: string): Record<string, unknown> => JSON.parse(text(`${name}.json`)) as Record<string, unknown>;
const reply = (name: string) => new Response(text(`${name}.json`), { headers: { 'Content-Type': 'application/json;charset=UTF-8' } });
const missing = () => new Response(text('not-found.html'), { status: 404, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Speedy HTTP adapter', () => {
  it('asks the public track endpoint once, in English, through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('collected'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SpeedyTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 6900 0000 001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://myspeedy.speedy.bg/rest/public/track?id=${COLLECTED}&language=en`);
    expect(init).toMatchObject({ signal: expect.any(AbortSignal), headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init?.method).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'speedy', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a parcel collected from an office newest first, by the office name only', () => {
    const result = parseSpeedy(fixture('collected'), COLLECTED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-04T17:01:30+02:00', delivered_at: '2026-03-04T17:01:30+02:00',
      expected_delivery: null, pickup_point: '999 - SAMPLE TOWN - EXAMPLE SQUARE' });
    expect(result.events!.map(event => [event.time, event.provider_code, event.stage ?? null, event.location ?? null])).toEqual([
      ['2026-03-04T17:01:30+02:00', '-14', 'delivered', 'Example City'],
      ['2026-03-04T17:01:00+02:00', '195', null, null],
      ['2026-03-03T08:22:00+02:00', '1134', 'ready_for_pickup', null],
      ['2026-03-03T08:20:00+02:00', '134', 'ready_for_pickup', 'Example City'],
      ['2026-03-03T04:10:00+02:00', '1', 'in_transit', 'Example City'],
      ['2026-03-02T22:30:00+02:00', '2', 'in_transit', 'Sample Town'],
      ['2026-03-02T18:05:00+02:00', '11', 'in_transit', 'Sample Town'],
      ['2026-03-02T16:40:00+02:00', '39', 'accepted', 'Sample Town'],
      ['2026-03-02T09:15:00+02:00', '148', 'registered', null],
    ]);
    expect(result.events![1]).toEqual({ time: '2026-03-04T17:01:00+02:00', description: 'Refuse contents check/test', provider_code: '195' });
    const kept = JSON.stringify(result);
    for (const dropped of ['ul. Example', 'ABC**', 'received from', 'SYNTHETIC-POD-TOKEN', 'officesmap', 'Expected Delivery']) {
      expect(kept).not.toContain(dropped);
    }
  });

  it('names the receiving partner, keeps the estimate on the way and drops a partner site code', () => {
    const result = parseSpeedy(fixture('partner'), PARTNER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Departure Scan',
      expected_delivery: '2026-03-13', delivery_carrier: 'acs-courier', delivery_tracking_number: '9900000001' });
    expect(result.events!.map(event => event.location ?? null)).toEqual(['SAMPLEPOLIS, Greece', 'SAMPLEPOLIS, Greece', null]);
    expect(result.pickup_point).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/9999|acscourier\.net/);
    const sender = fixture('partner') as { externalCarriermappings: Record<string, unknown>[] };
    sender.externalCarriermappings[0]!.mappingFor = 'SENDER';
    expect(parseSpeedy(sender, PARTNER).delivery_carrier).toBeUndefined();
    sender.externalCarriermappings[0]!.mappingFor = 'RECEIVER';
    sender.externalCarriermappings[0]!.externalCarrier = 'Example Express';
    expect(parseSpeedy(sender, PARTNER).delivery_tracking_number).toBeUndefined();
  });

  it('reads a parcel sent back after waiting at an office without its pickup point, return waybill or estimate', () => {
    const result = parseSpeedy(fixture('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Delivered Back to Sender',
      last_update: '2026-03-30T11:10:00+03:00', expected_delivery: null });
    expect(result.pickup_point).toBeUndefined();
    expect(result.delivered_at).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/69000000099|awb/);
  });

  it('shows the office a parcel waits at, and keeps unknown codes visible without a stage', () => {
    const payload = fixture('returned') as { events: Record<string, unknown>[] };
    payload.events = payload.events.slice(0, 5);
    expect(parseSpeedy(payload, RETURNED)).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup',
      pickup_point: '999 - SAMPLE TOWN - EXAMPLE SQUARE', expected_delivery: null });
    payload.events.push({ operationCode: 9001, description: 'Example new operation', dateTime: '2026-03-18T09:00:00+0200', place: '', comments: [] });
    const unknown = parseSpeedy(payload, RETURNED);
    expect(unknown).toMatchObject({ current_stage: 'ready_for_pickup', last_status_text: 'Example new operation' });
    expect(unknown.events![0]).toEqual({ time: '2026-03-18T09:00:00+02:00', description: 'Example new operation', provider_code: '9001' });
  });

  it('answers a reply without scans from its phase as an identity-bound summary', () => {
    const payload = fixture('partner');
    payload.events = [];
    expect(parseSpeedy(payload, PARTNER)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', provider_code: 'IN_TRANSIT',
      last_status_text: 'In transit', summary_only: true, last_update: null, events: [] });
    payload.info = { phase: 'SOMETHING_NEW' };
    expect(() => parseSpeedy(payload, PARTNER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('binds the reply to the whole requested number and dated scans', () => {
    expect(() => parseSpeedy(fixture('collected'), '69000000009')).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const change of [{ dateTime: '2026-03-02T09:15:00' }, { dateTime: '' }, { operationCode: null }, { operationCode: { code: 1 } }]) {
      const payload = fixture('collected') as { events: Record<string, unknown>[] };
      Object.assign(payload.events[0]!, change);
      expect(() => parseSpeedy(payload, COLLECTED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseSpeedy({ barcode: COLLECTED, events: {} }, COLLECTED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads MySpeedy’s missing-resource page as not found and other replies by their own kind', () => {
    expect(() => parseSpeedyReply(404, text('not-found.html'), COLLECTED)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseSpeedyReply(404, '<html>Not Found</html>', COLLECTED)).toThrow(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseSpeedyReply(200, '<html><title>Just a moment...</title></html>', COLLECTED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseSpeedyReply(200, '<html><title>MySpeedy - Login</title></html>', COLLECTED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseSpeedyReply(200, `\uFEFF${text('collected.json')}`, COLLECTED)).toMatchObject({ current_stage: 'delivered' });
  });

  it('recognizes a known number and the missing-resource page without a browser or recipient inputs', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('collected')).mockResolvedValueOnce(missing());
    await expect(carrier(fetcher).recognize!(COLLECTED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-04T15:01:30.000Z' });
    await expect(carrier(fetcher).recognize!(COLLECTED)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('6900000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(missing())).track({ number: COLLECTED })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [400, 'transport'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('<html></html>', { status, headers: { 'Retry-After': '120' } }));
      await expect(carrier(fetcher).track({ number: COLLECTED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(COLLECTED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps a 404 that is not MySpeedy’s page and a blocked HTTP 200 apart from missing shipments', async () => {
    for (const [response, kind] of [[new Response('Not Found', { status: 404 }), 'transport'],
      [new Response('<html><title>Just a moment...</title></html>'), 'challenge'], [new Response('{"items":[]}'), 'schema']] as const) {
      await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).recognize!(COLLECTED)).rejects.toMatchObject({ kind });
    }
  });

  it('rejects numbers Speedy does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['6900000000', '690000000011', 'SP690000001']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: COLLECTED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: COLLECTED }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a shipment filed under Speedy to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('collected'));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: COLLECTED, carrier: 'speedy' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'speedy', source: 'speedy', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${SPEEDY_ENDPOINT}?`))).toBe(true);
  });
});

describe('Speedy status vocabulary', () => {
  it('records every code and phase the map knows with the wording and stage the adapter gives it', () => {
    for (const entry of statuses.entries) {
      const known = /^-?\d+$/.test(entry.code) ? speedyOperation(entry.code) : speedyPhase(entry.code);
      expect(known).toEqual({ wording: entry.wording, ...('stage' in entry ? { stage: entry.stage } : {}) });
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase())).toBe('stage' in entry ? entry.stage : undefined);
    }
    expect(statusMapAnswer({ carrier: 'speedy', providerCode: '134', description: 'Prepared for Self-collecting by Consignee' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    expect(statusMapAnswer({ carrier: 'speedy', providerCode: '195', description: 'Refuse contents check/test' }))
      .toMatchObject({ kind: 'intentional_gap' });
  });
});
