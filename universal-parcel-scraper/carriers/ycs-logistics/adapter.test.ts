import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, YCS_API, YcsTracker } from './adapter.js';
import { normalizeYcsNumber, parseYcs } from './parser.js';
import { statusMap, ycsMappedStage, ycsRelayedPlace, ycsStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const UNKNOWN = '00000000000';
const DELIVERED = '00000000001';
const IN_TRANSIT = '00000000002';
const BILL = '00000000003';

type Row = Record<string, unknown>;
type Shipment = Row & { info: Row; status: Row[]; batchs: Record<string, Row[]> };
type Reply = Row & { data: Record<string, Shipment> };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (shipment: Shipment, reply: Reply) => void) => {
  const reply = fixture(name);
  change(Object.values(reply.data)[0]!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The same reply under the number asked, as the service keys it.
const keyed = (name: string, number: string) => {
  const body = fixture(name);
  return { ...body, data: { [number]: Object.values(body.data)[0]! } };
};

describe('YCS Logistics HTTP adapter', () => {
  it('posts the whole number to the tracking page’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new YcsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 0000-0000-002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(YCS_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ cargoNumbers: [IN_TRANSIT] });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ycs-logistics', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('lists a delivery HCT relays newest first, in Taipei time, at the branch each sentence names', () => {
    const result = parseYcs(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '貨件已由樣本二營業所送達。貨物件數共1件。', last_update: '2026-05-13T13:45:00+08:00',
      expected_delivery: null, delivered_at: '2026-05-13T13:45:00+08:00', sender_name: '樣本商店' });
    // The delivery listed twice is kept once.
    expect(result.events!.map((event) => [event.time, event.location ?? null, event.provider_code, event.stage])).toEqual([
      ['2026-05-13T13:45:00+08:00', '樣本二營業所', '999', 'delivered'],
      ['2026-05-13T08:20:00+08:00', '樣本二營業所', '601', 'out_for_delivery'],
      ['2026-05-13T07:10:00+08:00', '樣本二營業所', '201', 'in_transit'],
      ['2026-05-12T22:30:00+08:00', '樣本轉運', '601', 'in_transit'],
      ['2026-05-12T18:05:00+08:00', '樣本一營業所', '101', 'in_transit'],
      ['2026-05-12T17:15:00+08:00', '樣本一營業所', '601', 'in_transit'],
      ['2026-05-12T17:10:30+08:00', '總公司', '502', 'in_transit'],
      ['2026-05-12T16:40:05+08:00', '樣本站', '101', 'accepted'],
      ['2026-05-11T04:20:15+08:00', null, '0', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.local_time === undefined)).toBe(true);
    // Who entered each scan, the merchant's order number, the weight and the size are not kept.
    expect(JSON.stringify(result)).not.toMatch(/樣本人員|HCT樣本|C00000000000000|\(30,20,5\)|weight|來回件/);
  });

  it('reads a parcel on its way with YCS’s own stations and the day it expects to deliver', () => {
    const result = parseYcs(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: '貨到站所',
      last_update: '2026-06-03T07:30:00+08:00', expected_delivery: '2026-06-04', sender_name: '樣本公司' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.description, event.location ?? null, event.stage])).toEqual([
      ['貨到站所', '樣本二站', 'in_transit'],
      ['轉運中', '總公司', 'in_transit'],
      ['已取件', '樣本站', 'accepted'],
      ['檔案上傳成功', null, 'registered'],
    ]);
  });

  it('takes the page’s clock in its order, keeps an unknown label without a stage and the newest staged scan’s stage', () => {
    const result = parseYcs(changed('in-transit', (shipment) => {
      shipment.status[0]!.currentDate = null;
      shipment.status[0]!.Date1 = '2026-06-01 09:05:00';
      shipment.status[1]!.Date1 = '';
      shipment.status[1]!.Date2 = '2026-06-02 15:25:00';
      shipment.status.push({ ...shipment.status[3], status_type: '樣本備註', code: 700, Date1: '2026-06-03 09:00:00' });
    }), IN_TRANSIT);
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: '樣本備註', last_update: '2026-06-03T09:00:00+08:00' });
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(result.events!.slice(-2).map((event) => event.time)).toEqual(['2026-06-02T15:25:00+08:00', '2026-06-01T09:05:00+08:00']);
  });

  it('places a relayed sentence it cannot read nowhere, rather than at the station that handed the parcel over', () => {
    const result = parseYcs(changed('delivered', (shipment) => {
      shipment.status = shipment.status.slice(0, 4);
      shipment.status[3]!.status_type = '樣本轉交訊息';
    }), DELIVERED);
    expect(result.events![0]).toMatchObject({ description: '樣本轉交訊息' });
    expect(result.events![0]).not.toHaveProperty('location');
    expect(result.expected_delivery).toBe('2026-05-14');
  });

  it('reads a bill of several pieces whole by its number, and one piece by the piece’s', () => {
    const whole = parseYcs(fixture('pieces'), BILL);
    expect(whole).toMatchObject({ current_stage: 'delivered', last_status_text: '配完', delivered_at: '2026-07-02T11:40:00+08:00' });
    // The scans the pieces share are kept once.
    expect(whole.events!.map((event) => event.description)).toEqual(['配完', '已配達', '人員配送中', '已取件', '檔案上傳成功']);
    const piece = parseYcs(keyed('pieces', `${BILL}01`), `${BILL}01`);
    expect(piece).toMatchObject({ current_stage: 'delivered', last_status_text: '已配達', delivered_at: '2026-07-02T11:15:00+08:00' });
    expect(piece.events).toHaveLength(4);
    expect(() => parseYcs(keyed('pieces', `${BILL}03`), `${BILL}03`)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads a one-piece bill by its number with the piece’s two digits', () => {
    expect(parseYcs(keyed('delivered', `${DELIVERED}00`), `${DELIVERED}00`)).toMatchObject({ current_stage: 'delivered' });
    expect(() => parseYcs(keyed('delivered', `${DELIVERED}01`), `${DELIVERED}01`))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'YCS answered for another shipment' }));
  });

  it('counts a shipment only when it is listed under the number asked and names it', () => {
    expect(() => parseYcs(fixture('delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'YCS answered for another number' }));
    expect(() => parseYcs(keyed('delivered', IN_TRANSIT), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'YCS answered for another shipment' }));
    const twice = fixture('delivered');
    twice.data[IN_TRANSIT] = fixture('in-transit').data[IN_TRANSIT]!;
    expect(() => parseYcs(twice, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseYcs(keyed('pieces', IN_TRANSIT), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads an unknown number as not found, a refused request as inconclusive and a bill without scans as no history', () => {
    expect(() => parseYcs(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseYcs({ success: false, msg: '樣本錯誤' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseYcs(changed('delivered', (shipment) => { shipment.status = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_shipment: Shipment, body: Reply) => { delete (body as Row).success; },
      (_shipment: Shipment, body: Reply) => { body.data = [] as never; },
      (_shipment: Shipment, body: Reply) => { body.data[DELIVERED] = 'shipment' as never; },
      (shipment: Shipment) => { delete (shipment as Row).info; },
      (shipment: Shipment) => { shipment.info.systemNumber = null; },
      (shipment: Shipment) => { shipment.search_status = 7; },
      (shipment: Shipment) => { shipment.status = 'scans' as never; },
      (shipment: Shipment) => { shipment.status = Array.from({ length: 501 }, () => shipment.status[1]!); },
      (shipment: Shipment) => { shipment.status[1] = 'scan' as never; },
      (shipment: Shipment) => { shipment.status[1]!.status_type = ''; },
      (shipment: Shipment) => { shipment.status[1]!.status_type = ['已取件']; },
      (shipment: Shipment) => { shipment.status[1]!.company = 7; },
      (shipment: Shipment) => { shipment.status[1]!.Date1 = '2026/05/12 16:40'; },
      (shipment: Shipment) => { shipment.status[1]!.Date1 = '2026-02-30 16:40:05'; },
      (shipment: Shipment) => { shipment.status[1]!.Date1 = '2026-05-12 24:00:00'; },
      (shipment: Shipment) => { shipment.status[0]!.currentDate = undefined; },
    ]) {
      expect(() => parseYcs(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const change of [
      (shipment: Shipment) => { shipment.batchs = [] as never; },
      (shipment: Shipment) => { shipment.batchs = {}; },
      (shipment: Shipment) => { shipment.batchs = { [`${IN_TRANSIT}01`]: shipment.batchs[`${BILL}01`]! }; },
      (shipment: Shipment) => { shipment.batchs[`${BILL}01`] = 'scans' as never; },
    ]) {
      expect(() => parseYcs(changed('pieces', change), BILL)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The lookup answers a missing parcel with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://system.ycs-express.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>YCS</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [405, 'transport'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number YCS does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-05-13T05:45:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('C00000000000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers YCS does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // A sender's order number finds a parcel on the page too, but it is not YCS's, and a short one is shared.
    for (const number of ['0', '0000000000', '000000000000', '00000000000000', 'C00000000000000', `0${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeYcsNumber(' 0000 0000 001-00 ')).toBe(`${DELIVERED}00`);
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const started = Date.now();
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 60.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a number filed under YCS to the adapter, and leaves its plain digit run unclaimed', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'ycs-logistics' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'ycs-logistics', source: 'ycs-logistics', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === YCS_API)).toBe(true);
    expect(detectCarrierMatch(DELIVERED).carrier).not.toBe('ycs-logistics');
    expect(detectCarrierMatch(`${DELIVERED}00`).carrier).not.toBe('ycs-logistics');
  });
});

describe('YCS Logistics status vocabulary', () => {
  it('maps every recorded label and sentence to the stage it records', () => {
    const entries = statuses.entries as { code?: string; wording: string; stage: string; confirmedBy: string }[];
    expect(entries.filter((entry) => entry.confirmedBy === 'live').length).toBeGreaterThanOrEqual(6);
    for (const entry of entries) {
      expect(ycsStage(entry.wording)?.stage, entry.wording).toBe(entry.stage);
      expect(ycsMappedStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(entry.code ?? null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'ycs-logistics', providerCode: entry.code, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'ycs-logistics', providerCode: '601', description: '樣本貨態' })).toEqual({ kind: 'unknown' });
    expect(ycsStage('樣本貨態')).toBeNull();
  });

  it('reads the branch a relayed sentence names, whichever branch it is', () => {
    expect(ycsRelayedPlace('貨件已抵達樣本營業所，貨件整理中。貨物件數共3件。')).toBe('樣本營業所');
    expect(ycsRelayedPlace('貨件已由樣本轉運發出，前往配送站途中。')).toBe('樣本轉運');
    expect(ycsRelayedPlace('已取件')).toBeUndefined();
    expect(ycsMappedStage('貨件已由樣本營業所送達。貨物件數共2件。')).toBe('delivered');
  });
});
