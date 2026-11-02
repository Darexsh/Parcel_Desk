import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ILYANG_API, IlyangLogisTracker } from './adapter.js';
import { ilyangHandover, ilyangWording, normalizeIlyangNumber, parseIlyang } from './parser.js';
import { ilyangStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '1000000002';
const IN_TRANSIT = '2000000004';
const HANDED_OVER = '3000000006';
const UNKNOWN = '0000000000';

type Row = Record<string, unknown>;
type Parcel = Row & { tracking: Row[] };
type Reply = Row & { rows: Parcel[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (parcel: Parcel, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.rows[0]!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'Application/json;charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// What the lookup answers for input that is not a waybill.
const REFUSED = { msg: '해당 정보가 없습니다.', res: false, auth: true };

describe('Ilyang Logis HTTP adapter', () => {
  it('posts the whole number to the tracking page’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new IlyangLogisTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 2000-0000-04 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(ILYANG_API);
    expect(String(url)).toBe('https://www.ilyanglogis.co.kr/tracking/trackingByDeliNo.do');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: `trackingType=0&blNum=${IN_TRANSIT}`,
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ilyang-logis', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads Korean wall clocks at UTC+9 and stages each checkpoint by its label, newest first', () => {
    const result = parseIlyang(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '배달완료', last_update: '2026-10-07T06:25:00Z', delivered_at: '2026-10-07T06:25:00Z', expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.location, event.provider_code, event.stage, event.description])).toEqual([
      ['2026-10-07T06:25:00Z', '마바지점', '70', 'delivered', '배달완료'],
      ['2026-10-06T23:52:00Z', '마바지점', '50', 'out_for_delivery', '직원 배송중'],
      // The remark gives the reason, without its phone number.
      ['2026-10-06T12:00:00Z', '마바지점', '88', 'failed_attempt', '미배달(기타): 배송 기사 결원 문의'],
      // The repeated arrival is kept once.
      ['2026-10-05T22:35:00Z', '마바지점', '20', 'in_transit', '배송경유지 도착'],
      ['2026-10-05T14:31:00Z', '다라터미널', '40', 'in_transit', '배송경유지 출고'],
      ['2026-10-05T14:30:00Z', '다라터미널', '20', 'in_transit', '배송경유지 도착'],
      ['2026-10-05T07:57:00Z', '가나사무소', '40', 'in_transit', '배송경유지 출고'],
      ['2026-10-05T06:48:00Z', '가나사무소', '10', 'accepted', '발송사무소 인수'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !event.local_time)).toBe(true);
    expect(result).not.toHaveProperty('delivery_carrier');
  });

  it('keeps no sender, recipient, address, phone number, goods, order number or staff', () => {
    const text = JSON.stringify(parseIlyang(fixture('delivered'), DELIVERED));
    expect(text).not.toMatch(/홍길동|샘플|가상시|예시로|010-|02-000|031-|ORDER|AB01|GA01|DA99|고객님/);
  });

  it('reads a parcel that has reached its delivering branch', () => {
    const result = parseIlyang(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: '배송경유지 도착',
      last_update: '2026-10-13T21:49:00Z', expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.location])).toEqual([
      ['2026-10-13T21:49:00Z', '사아지점'],
      ['2026-10-13T15:05:00Z', '다라터미널'],
      ['2026-10-13T15:02:00Z', '다라터미널'],
      ['2026-10-13T06:39:00Z', '가나사무소'],
    ]);
    expect(result).not.toHaveProperty('delivered_at');
    // A history listed newest first reads the same.
    expect(parseIlyang(changed('in-transit', (parcel) => { parcel.tracking.reverse(); }), IN_TRANSIT)).toEqual(result);
  });

  it('keeps scans of one instant in the carrier’s order', () => {
    const result = parseIlyang(changed('in-transit', (parcel) => { parcel.tracking[2]!.actTime = '0002'; }), IN_TRANSIT);
    expect(result.events!.map((event) => [event.time, event.provider_code])).toEqual([
      ['2026-10-13T21:49:00Z', '20'], ['2026-10-13T15:02:00Z', '40'], ['2026-10-13T15:02:00Z', '20'], ['2026-10-13T06:39:00Z', '40'],
    ]);
  });

  it('names CJ Logistics and its waybill for a parcel handed over, and a late acceptance does not take it back', () => {
    const result = parseIlyang(fixture('handed-over'), HANDED_OVER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: '미배달(인계): CJ 1111-2222-3333',
      last_update: '2026-10-16T08:56:00Z', delivery_carrier: 'cj-logistics', delivery_tracking_number: '111122223333' });
    expect(result.events!.map((event) => [event.provider_code, event.stage])).toEqual([
      ['10', 'accepted'], ['88', 'in_transit'], ['40', 'in_transit'], ['20', 'in_transit'], ['40', 'in_transit'],
    ]);
    // An acceptance with nothing before it is the parcel's stage.
    const first = parseIlyang(changed('handed-over', (parcel) => { parcel.tracking = parcel.tracking.slice(-1); }), HANDED_OVER);
    expect(first).toMatchObject({ current_stage: 'accepted', last_status_text: '발송사무소 인수' });
    expect(first).not.toHaveProperty('delivery_carrier');
  });

  it('reads a hand-over’s remark and takes phone numbers out of other remarks', () => {
    expect(ilyangHandover('CJ 1111-2222-3333')).toBe('111122223333');
    expect(ilyangHandover('CJ1111222233')).toBe('1111222233');
    for (const remark of ['CJ 1111-2222-333', '우체국 1111222233334', '배송 기사 결원', '']) expect(ilyangHandover(remark), remark).toBeNull();
    expect(ilyangWording('미배달(인계)', 'CJ 1111-2222-3333')).toBe('미배달(인계): CJ 1111-2222-3333');
    expect(ilyangWording('미배달(기타)', '연락주세요 010-0000-0000')).toBe('미배달(기타): 연락주세요');
    expect(ilyangWording('미배달(기타)', '010-0000-0000')).toBe('미배달(기타)');
    expect(ilyangWording('미배달(기타)', '')).toBe('미배달(기타)');
  });

  it('keeps an unknown checkpoint without a stage', () => {
    const unknown = parseIlyang(changed('in-transit', (parcel) => {
      Object.assign(parcel.tracking[3]!, { chkPointCd: '99', chkPointDesc: '가상상태', chkPointDesc2: '가상상태' });
    }), IN_TRANSIT);
    expect(unknown.events![0]).toMatchObject({ provider_code: '99', description: '가상상태' });
    expect(unknown.events![0]).not.toHaveProperty('stage');
    expect(unknown).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: '배송경유지 출고' });
    // A known label under a new code, and a known code under a new label, keep their stage.
    expect(ilyangStage('99', '배달완료')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(ilyangStage('88', '미배달(부재)')).toEqual({ stage: 'failed_attempt', source: 'carrier_map' });
    expect(ilyangStage(null, '가상상태')).toBeNull();
    // The summary label stands in for a missing page label.
    const summary = parseIlyang(changed('in-transit', (parcel) => { parcel.tracking[3]!.chkPointDesc2 = ''; }), IN_TRANSIT);
    expect(summary.events![0]).toMatchObject({ description: '배송경유지 도착', stage: 'in_transit' });
  });

  it('reads the tracker’s “not taken in” answer as not found, and other empty answers as inconclusive', () => {
    expect(() => parseIlyang(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseIlyang(changed('not-found', (parcel) => { parcel.tracking = []; }), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseIlyang(changed('not-found', (parcel) => { parcel.lastTrackingDesc = '잠시 후 다시 이용해 주시기 바랍니다'; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseIlyang(REFUSED, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseIlyang(changed('in-transit', (_parcel, body) => { (body.result as Row).returnCode = 'R9'; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseIlyang(changed('in-transit', (parcel) => { parcel.ilyErrorType = 'E'; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Ilyang Logis reported an error for the lookup' }));
  });

  it('counts a parcel only when it names the number asked', () => {
    expect(() => parseIlyang(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Ilyang Logis answered for another parcel' }));
    expect(() => parseIlyang(changed('not-found', (parcel) => { parcel.blNum = DELIVERED; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Ilyang Logis answered for another parcel' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_parcel: Parcel, body: Reply) => { delete (body as Row).res; },
      (_parcel: Parcel, body: Reply) => { body.res = 'true'; },
      (_parcel: Parcel, body: Reply) => { delete (body as Row).rows; },
      (_parcel: Parcel, body: Reply) => { body.rows = []; },
      (parcel: Parcel, body: Reply) => { body.rows = [parcel, parcel]; },
      (_parcel: Parcel, body: Reply) => { body.rows = ['parcel'] as never; },
      (parcel: Parcel) => { delete (parcel as Row).blNum; },
      (parcel: Parcel) => { parcel.blNum = Number(IN_TRANSIT); },
      (parcel: Parcel) => { parcel.tracking = 'scans' as never; },
      (parcel: Parcel) => { parcel.tracking = Array.from({ length: 301 }, () => parcel.tracking[0]!); },
      (parcel: Parcel) => { parcel.tracking[0] = 'scan' as never; },
      (parcel: Parcel) => { parcel.tracking[0]!.actDate = '2026-10-13'; },
      (parcel: Parcel) => { parcel.tracking[0]!.actDate = '20260230'; },
      (parcel: Parcel) => { parcel.tracking[0]!.actTime = '2400'; },
      (parcel: Parcel) => { parcel.tracking[0]!.actTime = '15:39'; },
      (parcel: Parcel) => { parcel.tracking[0]!.actTime = '153'; },
      (parcel: Parcel) => { delete parcel.tracking[0]!.actTime; },
      (parcel: Parcel) => { Object.assign(parcel.tracking[0]!, { chkPointDesc: '', chkPointDesc2: '' }); },
      (parcel: Parcel) => { parcel.tracking[0]!.chkPointDesc2 = ['배송경유지 출고']; },
      (parcel: Parcel) => { parcel.tracking[0]!.chkPointCd = 'A-2'; },
      (parcel: Parcel) => { parcel.tracking[0]!.chkPointCd = { code: '40' }; },
      (parcel: Parcel) => { parcel.tracking[0]!.stationName = 12; },
    ]) {
      expect(() => parseIlyang(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A clock with seconds is read to the second.
    const seconds = parseIlyang(changed('in-transit', (parcel) => { parcel.tracking[3]!.actTime = '064912'; }), IN_TRANSIT);
    expect(seconds.events![0]!.time).toBe('2026-10-13T21:49:12Z');
  });

  it('keeps an unknown number, a refused lookup, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(REFUSED)).rejects.toMatchObject({ kind: 'indeterminate' });
    // The lookup answers an unknown number with HTTP 200: a 404, a 405 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>HTTP Status 405 – Method Not Allowed</title></html>', { status: 405 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.ilyanglogis.co.kr/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>일양로지스</title><body>점검 중</body></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number Ilyang Logis does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toMatchObject({ known: true });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('1000000003')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Ilyang Logis does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // A wrong check digit, one Ilyang Logis never gives, eight or eleven digits, letters.
    for (const number of ['1000000003', '1000000009', '10000002', '10000000006', 'A000000002', '1'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeIlyangNumber('2000-0000-04')).toBe(IN_TRANSIT);
    expect(normalizeIlyangNumber(' 200 000 0004 ')).toBe(IN_TRANSIT);
    // Nine digits, as older waybills have.
    expect(normalizeIlyangNumber('100000003')).toBe('100000003');
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a number filed under Ilyang Logis to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: '1000-0000-02', carrier: 'ilyang-logis' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'ilyang-logis', source: 'ilyang-logis', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url, init]) => String(url) === ILYANG_API && init?.body === `trackingType=0&blNum=${DELIVERED}`)).toBe(true);
  });

  it('leaves Ilyang Logis’ numbers to the caller: no rule claims nine or ten digits', () => {
    for (const number of [DELIVERED, IN_TRANSIT, HANDED_OVER]) expect(detectCarrierMatch(number).carrier, number).not.toBe('ilyang-logis');
  });
});

describe('Ilyang Logis status vocabulary', () => {
  it('records every checkpoint the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string }[]) {
      expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(ilyangStage(entry.code ?? null, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'ilyang-logis', providerCode: '88', description: '미배달(인계): CJ 1111-2222-3333' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'ilyang-logis', providerCode: '88', description: '미배달(기타): 배송 기사 결원' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'ilyang-logis', providerCode: '99', description: '가상상태' })).toEqual({ kind: 'unknown' });
  });
});
