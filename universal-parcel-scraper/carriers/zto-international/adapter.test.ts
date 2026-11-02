import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ZTO_INTERNATIONAL_API, ZtoInternationalTracker } from './adapter.js';
import { normalizeZtoInternationalNumber, parseZtoInternational } from './parser.js';
import { statusMap, ztoInternationalStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '77100000000011';
const IN_TRANSIT = '77100000000022';
const OUTBOUND = '77100000000033';
const UNKNOWN = '77100000000044';

type Row = Record<string, unknown>;
type Waybill = Row & { mail: Row; tracks: Row[] };
type Reply = Row & { data: Waybill[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (waybill: Waybill, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data[0]!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: IN_TRANSIT });

describe('ZTO International HTTP adapter', () => {
  it('posts the tracking page’s own body for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ZtoInternationalTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 771 0000 0000 022 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(ZTO_INTERNATIONAL_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', Origin: 'https://m.ztoglobal.com',
      Referer: 'https://m.ztoglobal.com/', 'User-Agent': 'SyntheticHost/1.0',
    } });
    // No signature: the service answers without one.
    expect(init!.headers).not.toHaveProperty('sign');
    expect(JSON.parse(String(init!.body))).toEqual({ data: { data: [IN_TRANSIT], uuid: '', verificationCode: '' },
      timestamp: expect.any(Number), version: '3.78.0', countryCode: 'LA' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'zto-international', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps an import’s history from the overseas warehouse to the delivery, on Shanghai\'s clock', () => {
    const result = parseZtoInternational(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-05-20T16:12:47+08:00', last_update_local: '2026-05-20T16:12:47', expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage ?? null, event.description, event.location ?? null])).toEqual([
      ['2026-05-20T16:12:47', '5', 'delivered', 'Delivered', '样例东区'],
      ['2026-05-20T16:12:46', '15', 'delivered', 'Delivered', '样例市'],
      // The English line says Delivered; the parcel waits at a station for its pickup code.
      ['2026-05-19T15:07:57', '16', 'ready_for_pickup', 'Received on the recipient\'s behalf', '样例市'],
      ['2026-05-19T13:46:38', '4', 'out_for_delivery', 'Physical delivery scheduled.', '样例东区'],
      ['2026-05-19T13:46:32', '3', 'in_transit', 'Arrival at inward office of exchange.', '样例东区'],
      ['2026-05-19T08:29:17', '2', 'in_transit', 'Departure from inward office of exchange.', '样例中转部'],
      ['2026-05-19T08:29:17', '3', 'in_transit', 'Arrival at inward office of exchange.', '样例中转部'],
      ['2026-05-18T19:58:11', '1', 'accepted', 'Parcel scanned by site', '样例口岸部'],
      ['2026-05-18T14:32:27', '371', 'in_transit', 'clearance finish', '中国'],
      ['2026-05-16T14:47:12', '373', 'customs', 'Customs inspection', '中国'],
      ['2026-05-15T09:00:00', '360', 'customs', 'Import customs in progress.', '中国'],
      ['2026-05-15T06:30:00', '231', 'in_transit', 'Ship arrived', '中国'],
      ['2026-05-14T18:00:00', '221', 'in_transit', 'Ship departure', '韩国'],
      ['2026-05-14T16:09:00', '190', 'in_transit', 'Parcel left the warehouse', '样例特别市'],
      ['2026-05-14T15:42:00', '150', 'accepted', 'Parcel entered the warehouse', '样例特别市'],
    ]);
    expect(result.events!.every((event) => event.time === `${event.local_time}+08:00` && event.time_zone === 'Asia/Shanghai'
      && event.time_zone_basis === 'carrier' && event.stage_source === 'carrier_map')).toBe(true);
    // Couriers, signers, collection points, operators and phones stay out.
    expect(JSON.stringify(result)).not.toMatch(/样例驿站|张样例|李样例|家人|yangliuser|操作员|130000/);
  });

  it('keeps a parcel waiting at customs, without the operator code in a line haul', () => {
    const result = parseZtoInternational(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', last_status_text: 'Import customs in progress.',
      last_update: '2026-06-02T06:59:52+08:00', last_update_local: '2026-06-02T06:59:52' });
    expect(result.events!.map((event) => [event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['360', 'customs', '中国'], ['232', 'in_transit', '中国'], ['222', 'in_transit', '中国'],
      ['190', 'in_transit', '中国香港特区'], ['150', 'accepted', '中国香港特区'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/ZTO0000|已揽收/);
  });

  it('takes people, handles, phones and bags out of the lines of ZTO’s networks abroad', () => {
    const result = parseZtoInternational(fixture('outbound'), OUTBOUND);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'The parcel has been scanned' });
    expect(result.events!.map((event) => [event.provider_code, event.description, event.location ?? null])).toEqual([
      ['4', 'The parcel has been scanned', '样例省KK'],
      ['3', 'The parcel has arrived at Sample Province', '样例省KK'],
      ['2', 'The shipment is loaded at Sample Hub and is being sent to Sample Province', '样例分拨中心PP'],
      ['213', 'Package is clearing customs at the China port', null],
      ['1', 'Receipt has been scanned', '中通国际样例仓库'],
      // A line with no English keeps its Chinese, without its people and phone.
      ['900', '进行处理，订单已生成', '样例仓库'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/@|sample_|Sample Name|王样例|赵样例|0000000|130000|电话/);
    // A code the map does not know is staged only by wording the shared rules read.
    expect(result.events!.at(-1)!.stage_source).not.toBe('carrier_map');
  });

  it('dates the scans of a leg abroad on Shanghai\'s clock too', () => {
    // ZTO's scans at a station in Germany, read on Berlin's clock, came after the lookup that
    // returned them; on Shanghai's, each falls at the minute of 17TRACK's copy.
    const scan = (time: string, status: string, message: string, messageEng: string) => ({ time, status, message, messageEng, timeStr: null });
    const abroad = changed('in-transit', (waybill) => {
      waybill.tracks = [
        scan('2026-06-05 14:08:56', '100', '【Sample City01】派件中', 'Arrival at inward office of exchange.'),
        scan('2026-06-03 22:24:00', '230', '干线航班落地', 'Flight arrived'),
        scan('2026-06-02 14:19:00', '220', '干线航班起飞', 'Flight take off'),
        scan('2026-06-01 19:21:31', '150', '进行处理：订单已操作入库', 'Parcel entered the warehouse'),
      ];
    });
    const result = parseZtoInternational(abroad, IN_TRANSIT);
    expect(result.events!.map((event) => [event.provider_code, event.location ?? null, event.time, event.time_zone, event.time_zone_basis])).toEqual([
      ['100', 'Sample City01', '2026-06-05T14:08:56+08:00', 'Asia/Shanghai', 'carrier'],
      ['230', null, '2026-06-03T22:24:00+08:00', 'Asia/Shanghai', 'carrier'],
      ['220', null, '2026-06-02T14:19:00+08:00', 'Asia/Shanghai', 'carrier'],
      ['150', null, '2026-06-01T19:21:31+08:00', 'Asia/Shanghai', 'carrier'],
    ]);
    expect(result.last_update).toBe('2026-06-05T14:08:56+08:00');
  });

  it('reads the bare reply, which an unknown waybill and an unread request share, as inconclusive', async () => {
    for (const body of [fixture('not-found'), { success: true, data: [] }, { success: true, data: null }]) {
      expect(() => parseZtoInternational(body, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    }
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('not-found')))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    // A waybill without scans is known, with no history yet.
    expect(() => parseZtoInternational(changed('in-transit', (waybill) => { waybill.tracks = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
  });

  it('reads the image code the tracker asks for as a challenge, and other refusals as inconclusive', async () => {
    await expect(lookup(fixture('image-code'))).rejects.toMatchObject({ kind: 'challenge' });
    for (const code of [19002, '50003', '60005']) {
      await expect(lookup({ success: false, error: { code, message: 'Synthetic refusal' } }), String(code)).rejects.toMatchObject({ kind: 'challenge' });
    }
    await expect(lookup({ success: false, error: { code: '9999', message: 'Synthetic failure' } })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup({ success: false })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('keeps a browser check, a throttle, a moved route and a broken reply apart from a missing waybill', async () => {
    const waf = '<html><head><title>滑动验证</title></head><body><script src="/_____tmd_____/punish"></script></body></html>';
    await expect(lookup(waf, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>ZTO</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ message: 'Too Many Requests' }, { status: 429 })).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://m.ztoglobal.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ error: 'Bad Request' }, { status: 400 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ error: 'Internal Server Error' }, { status: 500 })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('rejects a changed reply', () => {
    const broken: [string, unknown][] = [
      ['envelope', []],
      ['success', { data: [] }],
      ['waybills', { success: true, data: {} }],
      ['history', changed('in-transit', (waybill) => { waybill.tracks = {} as Row[]; })],
      ['scan', changed('in-transit', (waybill) => { waybill.tracks[0] = 'scan' as unknown as Row; })],
      ['clock', changed('in-transit', (waybill) => { waybill.tracks[0]!.time = '2026-06-02T06:59:52+08:00'; })],
      ['rolled clock', changed('in-transit', (waybill) => { waybill.tracks[0]!.time = '2026-06-02 24:00:00'; })],
      ['code', changed('in-transit', (waybill) => { waybill.tracks[0]!.status = { code: 360 }; })],
      ['size', changed('in-transit', (waybill) => { waybill.tracks = Array.from({ length: 501 }, () => waybill.tracks[0]!); })],
    ];
    for (const [label, body] of broken) expect(() => parseZtoInternational(body, IN_TRANSIT), label).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('counts a waybill only when it and each of its scans name the number asked', () => {
    // The tracker also finds a waybill by its first leg's number, and names the waybill instead.
    const alias = changed('in-transit', (waybill) => { waybill.mail = { mailNo: DELIVERED, startNo: IN_TRANSIT, isSign: 0 }; });
    expect(() => parseZtoInternational(alias, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const twice = changed('in-transit', (waybill, body) => { body.data.push(waybill); });
    expect(() => parseZtoInternational(twice, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const foreign = changed('in-transit', (waybill) => { waybill.tracks[1]!.mailNo = DELIVERED; });
    expect(() => parseZtoInternational(foreign, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseZtoInternational(changed('in-transit', (waybill) => { waybill.mail = 'mail' as unknown as Row; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps one copy of a repeated scan and caps a long history', () => {
    const repeated = parseZtoInternational(changed('in-transit', (waybill) => { waybill.tracks.splice(1, 0, { ...waybill.tracks[1]! }); }), IN_TRANSIT);
    expect(repeated.events).toHaveLength(5);
    const long = parseZtoInternational(changed('in-transit', (waybill) => {
      waybill.tracks = Array.from({ length: 120 }, (_, index) => ({ ...waybill.tracks[1]!, time: `2026-06-01 ${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00` }));
    }), IN_TRANSIT);
    expect(long.events).toHaveLength(100);
    expect(long.history_truncated).toBe(true);
  });

  it('tries once more after a network failure, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('recognizes a known waybill, leaves the bare reply inconclusive, and asks nothing for a number it does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toMatchObject({ known: true });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    await expect(carrier(fetcher).recognize!('75900000000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers ZTO International does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['7710000000001', '771000000000011', '75900000000000', '300000000000001', 'SAMPLETRACKING', `771${'0'.repeat(62)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeZtoInternationalNumber('771-0000-0000-011')).toBe(DELIVERED);
  });

  it('routes a number filed under ZTO International to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'zto-international' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'zto-international', source: 'zto-international', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === ZTO_INTERNATIONAL_API)).toBe(true);
  });
});

describe('ZTO International numbers', () => {
  it('suggests ZTO International first for its waybills, and asks it first', () => {
    for (const number of [DELIVERED, IN_TRANSIT, '77199999999999']) {
      const match = detectCarrierMatch(number);
      expect(match, number).toMatchObject({ carrier: 'unknown', confidence: 'low' });
      expect(match.candidates[0], number).toBe('zto-international');
      expect(recognitionAskedCarriers(number)[0], number).toBe('zto-international');
    }
    for (const number of ['75900000000000', '7710000000001', '771000000000011']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('zto-international');
    }
  });
});

describe('ZTO International status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(ztoInternationalStage(entry.code, entry.wording)?.stage, entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'zto-international', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'zto-international', providerCode: '999', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to the shared wording rules.
    expect(ztoInternationalStage('6', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(ztoInternationalStage('999', 'Synthetic note')).toBeNull();
  });
});
