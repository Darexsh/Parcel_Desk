import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CJ_TRACE_API, CjLogisticsTracker } from './adapter.js';
import { cjBranch, cjWording, normalizeCjNumber, parseCjScans, readCjWaybill } from './parser.js';
import { cjStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '000000000101';
const IN_TRANSIT = '000000000202';
const UNKNOWN = '000000000303';
const REGISTERED = '000000000404';
const SCANS = `${CJ_TRACE_API}selectTrackingDetailList.do`;
const WAYBILL = `${CJ_TRACE_API}selectTrackingWaybil.do`;

type Row = Record<string, unknown>;
type Reply = Row & { data: Row & { svcOutList: Row[] } };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (rows: Row[], reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data.svcOutList, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** The tracker's two lookups, answered with these replies. */
const service = (scans: () => Response, waybill: () => Response = () => reply(fixture('waybill-unknown'))) =>
  vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url) === SCANS ? scans() : waybill()));
const rows = (name: string, number: string) => parseCjScans(fixture(name), number)!.events!
  .map((event) => [event.time, event.provider_code, event.stage ?? null, event.location ?? null]);

describe('CJ Logistics HTTP adapter', () => {
  it('posts the whole number to the tracker’s scan lookup once, through the supplied transport', async () => {
    const fetcher = service(() => reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CjLogisticsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 0000-0000-0202 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(SCANS);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: `wblNo=${IN_TRANSIT}`,
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'cj-logistics', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads each scan on the branch’s Korean clock and keeps the delivery past a later departure scan', () => {
    const result = parseCjScans(fixture('delivered'), DELIVERED)!;
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '배송완료: 고객님의 상품이 배송완료 되었습니다.', last_update: '2026-05-13T11:20:00+09:00',
      delivered_at: '2026-05-13T11:20:00+09:00', expected_delivery: null });
    expect(rows('delivered', DELIVERED)).toEqual([
      // The courier's departure scan recorded after the delivery leaves it delivered.
      ['2026-05-13T11:25:00+09:00', '82', 'out_for_delivery', '경기샘플동'],
      ['2026-05-13T11:20:00+09:00', '91', 'delivered', '경기샘플동'],
      ['2026-05-13T08:30:00+09:00', '82', 'out_for_delivery', '경기샘플동'],
      ['2026-05-13T07:50:00+09:00', '21', 'in_transit', '샘플MP'],
      // The repeated unloading scan is kept once.
      ['2026-05-13T07:30:00+09:00', '42', 'in_transit', '샘플서Sub'],
      ['2026-05-12T22:40:00+09:00', '41', 'in_transit', '샘플Hub'],
      ['2026-05-12T22:10:00+09:00', 'R1', 'in_transit', '샘플Hub'],
      ['2026-05-12T22:05:00+09:00', '43', 'in_transit', '샘플Hub'],
      ['2026-05-12T22:00:00+09:00', '42', 'in_transit', '샘플Hub'],
      ['2026-05-12T14:20:00+09:00', '41', 'in_transit', '샘플BSub'],
      // A direct route's label loses the driver it names.
      ['2026-05-11T19:10:00+09:00', '11', 'accepted', '샘플1직영'],
    ]);
    expect(result.events!.slice(0, 3).map((event) => event.description)).toEqual([
      '배송출발: 고객님의 상품을 배송할 예정입니다.(19~21시)',
      '배송완료: 고객님의 상품이 배송완료 되었습니다.',
      '배송출발: 고객님의 상품을 배송할 예정입니다.(11~13시)',
    ]);
    expect(result.events!.find((event) => event.provider_code === '43')?.description).toBe('소분류');
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.local_time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/홍길동|010-0000|김샘플|샘플사원|인수자|홍\*|02-0000|031-000|100001|V90/);
  });

  it('reads a parcel still between terminals', () => {
    const result = parseCjScans(fixture('in-transit'), IN_TRANSIT)!;
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: '간선하차: 접수하신 물품이 중계점에 도착하였습니다', last_update: '2026-05-22T00:30:00+09:00', expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    expect(rows('in-transit', IN_TRANSIT).map(([time, code, stage]) => [time, code, stage])).toEqual([
      ['2026-05-22T00:30:00+09:00', '42', 'in_transit'],
      ['2026-05-21T22:50:00+09:00', '41', 'in_transit'],
      ['2026-05-21T07:20:00+09:00', '63', 'in_transit'],
      ['2026-05-20T23:10:00+09:00', '42', 'in_transit'],
      ['2026-05-20T17:40:00+09:00', '41', 'in_transit'],
      ['2026-05-20T17:00:00+09:00', '11', 'accepted'],
    ]);
  });

  it('lets a failed attempt or an unknown scan after a delivery stand as they are, whatever the rows’ order', () => {
    const attempt = parseCjScans(changed('delivered', (scans) => {
      Object.assign(scans.at(-1)!, { crgStDcd: '84', crgStDnm: '미배송', crgStDcdVal: '물품배송이 지연되고 있습니다' });
    }), DELIVERED)!;
    expect(attempt).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: '미배송: 물품배송이 지연되고 있습니다',
      last_update: '2026-05-13T11:25:00+09:00' });
    expect(attempt).not.toHaveProperty('delivered_at');
    // A scan the map does not know keeps its wording and moves nothing.
    const unknown = parseCjScans(changed('in-transit', (scans) => {
      scans.push({ ...scans.at(-1)!, crgStDcd: 'Z9', crgStDnm: '샘플처리', crgStDcdVal: '', workHms: '09:00:00', workDt: '2026-05-22' });
    }), IN_TRANSIT)!;
    expect(unknown.events![0]).toEqual({ time: '2026-05-22T09:00:00+09:00', location: '샘플ASub', description: '샘플처리', provider_code: 'Z9' });
    expect(unknown).toMatchObject({ current_stage: 'in_transit', last_update: '2026-05-22T00:30:00+09:00' });
    const reversed = parseCjScans(changed('delivered', (scans) => { scans.reverse(); }), DELIVERED)!;
    expect(reversed).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-05-13T11:20:00+09:00' });
    expect(reversed.events!.at(-1)).toMatchObject({ provider_code: '11' });
  });

  it('takes couriers, receivers and phone numbers out of the wording and drivers out of branch names', () => {
    expect(cjWording('배송출발', '고객님의 상품을 배송할 예정입니다.(11~13시)(배송담당 : 홍길동 010-0000-0000)'))
      .toBe('배송출발: 고객님의 상품을 배송할 예정입니다.(11~13시)');
    expect(cjWording('배송완료', '고객님의 상품이 배송완료 되었습니다.(담당사원 : 홍길동 010-0000-0000)'))
      .toBe('배송완료: 고객님의 상품이 배송완료 되었습니다.');
    expect(cjWording('배송출발', '고객님의 상품을 배송할 예정입니다.(익일 )(배송예정:홍길동 010 0000 0000)'))
      .toBe('배송출발: 고객님의 상품을 배송할 예정입니다.(익일)');
    expect(cjWording('배송완료', '고객님의 상품이 배송완료 되었습니다. 인수자 : 홍*')).toBe('배송완료: 고객님의 상품이 배송완료 되었습니다.');
    expect(cjWording('미배송', '물품배송이 지연되고 있습니다 (02-000-0000)')).toBe('미배송: 물품배송이 지연되고 있습니다');
    // A line that repeats its scan's name is not doubled.
    expect(cjWording('간선하차', '간선하차 완료')).toBe('간선하차 완료');
    expect(cjWording('소분류', '')).toBe('소분류');
    expect(cjWording('', '샘플 안내')).toBe('샘플 안내');
    expect(cjBranch('샘플1직영(김샘플)')).toBe('샘플1직영');
    expect(cjBranch(' 샘플1직영 ( 김샘플 ) ')).toBe('샘플1직영');
    // A place in brackets stays.
    expect(cjBranch('샘플(의정부)')).toBe('샘플(의정부)');
  });

  it('reads a number without scans from the waybill’s own record', async () => {
    const unknown = service(() => reply(fixture('no-scans')));
    await expect(carrier(unknown).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(unknown.mock.calls.map(([url, init]) => [String(url), init?.body])).toEqual([[SCANS, `wblNo=${UNKNOWN}`], [WAYBILL, `wblNo=${UNKNOWN}`]]);
    // A waybill registered before its first scan has no history yet.
    const registered = service(() => reply(fixture('no-scans')), () => reply(fixture('waybill-registered')));
    await expect(carrier(registered).track({ number: REGISTERED }))
      .rejects.toMatchObject({ kind: 'indeterminate', name: 'NoHistoryError' });
    await expect(carrier(registered).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'indeterminate', message: 'CJ Logistics answered for another shipment' });
    expect(() => readCjWaybill(fixture('waybill-unknown'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => readCjWaybill({ data: 'waybill', resultCode: 200 }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => readCjWaybill({ data: { wblNo: null }, resultCode: 200 }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => readCjWaybill({ data: null }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseCjScans(fixture('no-scans'), UNKNOWN)).toBeNull();
  });

  it('counts scans only when they name the number asked', () => {
    expect(() => parseCjScans(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'CJ Logistics answered for another shipment' }));
    expect(() => parseCjScans(changed('in-transit', (scans) => { scans[3]!.wblNo = DELIVERED; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseCjScans(changed('in-transit', (scans) => { scans[0]!.wblNo = '0000-0000-0202'; }), IN_TRANSIT)!.events).toHaveLength(6);
  });

  it('reads a lookup the service did not complete as inconclusive', () => {
    for (const resultCode of [500, '9999']) {
      expect(() => parseCjScans({ data: null, resultCode, resultMessage: '샘플 오류' }, IN_TRANSIT))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'CJ Logistics did not complete the lookup' }));
      expect(() => readCjWaybill({ data: null, resultCode, resultMessage: '샘플 오류' }, UNKNOWN))
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(parseCjScans({ ...fixture('in-transit'), resultCode: '200' }, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit' });
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_scans: Row[], body: Reply) => { delete (body as Row).data; },
      (_scans: Row[], body: Reply) => { delete (body as Row).resultCode; },
      (_scans: Row[], body: Reply) => { body.data = 'scans' as never; },
      (_scans: Row[], body: Reply) => { delete (body.data as Row).svcOutList; },
      (_scans: Row[], body: Reply) => { body.data.svcOutList = 'scans' as never; },
      (scans: Row[], body: Reply) => { body.data.svcOutList = Array.from({ length: 2001 }, () => scans[0]!); },
      (scans: Row[]) => { scans[0] = 'scan' as never; },
      (scans: Row[]) => { delete scans[0]!.wblNo; },
      (scans: Row[]) => { scans[0]!.wblNo = Number(IN_TRANSIT); },
      (scans: Row[]) => { scans[0]!.workDt = '2026/05/20'; },
      (scans: Row[]) => { scans[0]!.workDt = '2026-02-30'; },
      (scans: Row[]) => { scans[0]!.workHms = '18:14'; },
      (scans: Row[]) => { scans[0]!.workHms = '24:00:00'; },
      (scans: Row[]) => { delete scans[0]!.workHms; },
      (scans: Row[]) => { scans[0]!.crgStDcdVal = ['인수']; },
      (scans: Row[]) => { scans[0]!.crgStDcd = 11; },
      (scans: Row[]) => { scans[0]!.crgStDnm = ''; scans[0]!.crgStDcdVal = null; },
    ]) {
      expect(() => parseCjScans(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps a browser check, a page and a broken reply apart from a missing parcel', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(service(() => reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><script>AwsWafIntegration.getToken()</script></html>')).rejects.toMatchObject({ kind: 'challenge' });
    for (const body of ['', '<html><head><title>CJ대한통운</title></head><body></body></html>', '{"data":{"svcOutList":[']) {
      await expect(lookup(body), body).rejects.toMatchObject({ kind: 'schema' });
    }
    const waybill = carrier(service(() => reply(fixture('no-scans')), () => reply('<html><title>Access Denied</title></html>')));
    await expect(waybill.track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'challenge' });
    const large = carrier(service(() => new Response(new Uint8Array(1_100_000))));
    await expect(large.track({ number: UNKNOWN })).rejects.toThrow('unexpectedly large');
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance'],
    [404, 'transport'], [405, 'transport'], [410, 'transport'], [302, 'transport']] as const)(
    'keeps a lookup answered with HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = service(() => status === 302 ? new Response(null, { status, headers: { Location: '/' } }) : reply('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and an unknown one, and asks nothing for a number CJ Logistics does not issue', async () => {
    const known = service(() => reply(fixture('delivered')));
    // The newest scan dates the parcel's last activity.
    await expect(carrier(known).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-05-13T02:25:00.000Z' });
    const unknown = service(() => reply(fixture('no-scans')));
    await expect(carrier(unknown).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(unknown).recognize!('00000000012')).resolves.toEqual({ known: false });
    expect(known).toHaveBeenCalledTimes(1);
    expect(unknown).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers CJ Logistics does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['000000101', '00000000012', '0000000001012', 'CJ0000000101', '', '0'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeCjNumber('0000-0000-0101')).toBe(DELIVERED);
    expect(normalizeCjNumber('0000 000 101')).toBe('0000000101');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    let calls = 0;
    const flaky = vi.fn<typeof fetch>().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return reply(fixture('delivered'));
    });
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 60 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a waybill to the adapter when the caller names CJ Logistics, which detection never offers', async () => {
    for (const number of [DELIVERED, '0000000101']) {
      expect(detectCarrierMatch(number)?.carrier, number).not.toBe('cj-logistics');
      expect(recognitionAskedCarriers(number), number).not.toContain('cj-logistics');
    }
    for (const link of [`https://trace.cjlogistics.com/next/tracking.html?wblNo=${DELIVERED}`,
      `https://trace.cjlogistics.com/web/detail.jsp?slipno=${DELIVERED}`,
      `https://www.cjlogistics.com/ko/tool/parcel/tracking?gnbInvcNo=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'cj-logistics', source: 'link' });
    }
    const fetcher = service(() => reply(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'cj-logistics' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'cj-logistics', source: 'cj-logistics', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(CJ_TRACE_API))).toBe(true);
  });
});

describe('CJ Logistics status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording)), entry.code).toBe(entry.stage);
      expect(cjStage(entry.code, entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'cj-logistics', providerCode: '91', description: '배송완료: 고객님의 상품이 배송완료 되었습니다.' }))
      .toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'cj-logistics', providerCode: 'Z9', description: '샘플처리' })).toEqual({ kind: 'unknown' });
    expect(cjStage('rmn', 'HUB 도착')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(cjStage('Z9', '샘플처리')).toBeNull();
  });
});
