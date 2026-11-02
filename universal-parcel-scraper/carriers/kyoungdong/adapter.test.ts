import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, KYOUNGDONG_API, KyoungdongTracker } from './adapter.js';
import { kyoungdongSite, normalizeKyoungdongNumber, parseKyoungdong } from './parser.js';
import { kyoungdongStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '1000000000001';
const IN_TRANSIT = '2000000000002';
const UNKNOWN = '0000000000000';

type Row = Record<string, unknown>;
type Parcel = Row & { scanList: Row[] };
type Reply = Row & { data: Parcel };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (data: Parcel, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'text/json;charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Kyungdong Express HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new KyoungdongTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 2000-0000-00002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${KYOUNGDONG_API}${IN_TRANSIT}`);
    expect(String(url)).toBe('https://kdexp.com/service/delivery/new/ajax_basic.do?barcode=2000000000002');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'kyoungdong', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads Korean wall clocks at UTC+9 and stages each scan by its type, newest first', () => {
    const result = parseKyoungdong(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '배송완료', last_update: '2026-10-06T06:47:08Z', delivered_at: '2026-10-06T06:47:08Z', expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.location ?? null, event.provider_code, event.stage, event.description])).toEqual([
      // The delivery names the driver, not a place.
      ['2026-10-06T06:47:08Z', null, '0007', 'delivered', '배송완료'],
      ['2026-10-06T04:30:12Z', '마바사34', '0008', 'out_for_delivery', '배송중'],
      // The repeated arrival is kept once.
      ['2026-10-05T21:02:59Z', '마바사34', '0006', 'in_transit', '도착'],
      // A line-haul load can name its masked driver.
      ['2026-10-05T16:15:40Z', null, '0004', 'in_transit', '노선상차'],
      ['2026-10-05T13:41:03Z', '차카타5678', '0004', 'in_transit', '노선상차'],
      ['2026-10-05T07:20:11Z', '가나다12', '0002', 'in_transit', '발송'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !event.local_time)).toBe(true);
  });

  it('keeps no sender, recipient, address, phone number, goods or driver', () => {
    const text = JSON.stringify(parseKyoungdong(fixture('delivered'), DELIVERED));
    expect(text).not.toMatch(/샘플|홍|최\*|010-|02-000|031-|박스|아파트/);
  });

  it('reads a parcel at its delivering branch, which the summary names without a number', () => {
    const result = parseKyoungdong(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: '도착',
      last_update: '2026-10-13T20:48:30Z', expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.location])).toEqual([
      ['2026-10-13T20:48:30Z', '하나둘'],
      ['2026-10-13T16:12:09Z', '타파하1234'],
      ['2026-10-13T09:05:44Z', '자차카9'],
    ]);
    expect(result).not.toHaveProperty('delivered_at');
    // The same site without the summary naming it is not taken for a branch.
    const unnamed = parseKyoungdong(changed('in-transit', (data) => { data.branArvlNm = null; }), IN_TRANSIT);
    expect(unnamed.events![0]).not.toHaveProperty('location');
  });

  it('keeps a branch, terminal or hub as a scan’s site, and never a person', () => {
    const branches = new Set(['하나둘']);
    expect(kyoungdongSite('가나다12', branches, 'in_transit')).toBe('가나다12');
    expect(kyoungdongSite('아자터미널', branches, 'in_transit')).toBe('아자터미널');
    expect(kyoungdongSite('하나둘', branches, 'out_for_delivery')).toBe('하나둘');
    expect(kyoungdongSite(' 하나둘 ', branches)).toBe('하나둘');
    for (const [site, stage] of [['홍길동', 'in_transit'], ['최**', 'in_transit'], ['홍길동(배송기사)', 'delivered'], ['홍길동2', 'delivered'],
      ['가나다12', 'out_for_delivery'], ['-', 'in_transit'], ['', 'in_transit']] as const) {
      expect(kyoungdongSite(site, branches, stage), site).toBe('');
    }
  });

  it('reads a history listed newest first, and keeps an unknown type without a stage', () => {
    const reversed = parseKyoungdong(changed('in-transit', (data) => { data.scanList.reverse(); }), IN_TRANSIT);
    expect(reversed.events!.map((event) => event.provider_code)).toEqual(['0006', '0004', '0002']);
    const unknown = parseKyoungdong(changed('in-transit', (data) => { Object.assign(data.scanList[2]!, { scanType: '0099', scanTypeNm: '가상상태' }); }), IN_TRANSIT);
    expect(unknown.events![0]).toMatchObject({ provider_code: '0099', description: '가상상태' });
    expect(unknown.events![0]).not.toHaveProperty('stage');
    expect(unknown).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: '가상상태' });
    // A known label under a new code, and a known code under a new label, keep their stage.
    expect(kyoungdongStage('0099', '배송완료')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(kyoungdongStage('0008', '가상상태')).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
    expect(kyoungdongStage(null, '가상상태')).toBeNull();
  });

  it('reads the lookup’s failure without data as inconclusive, and a parcel without scans as no history', () => {
    expect(() => parseKyoungdong(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    expect(() => parseKyoungdong({ result: 'fail', data: null }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    expect(() => parseKyoungdong(changed('in-transit', (data) => { data.scanList = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseKyoungdong(changed('in-transit', (data) => { delete (data as Row).scanList; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a parcel only when it names the number asked', () => {
    expect(() => parseKyoungdong(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Kyungdong Express answered for another parcel' }));
    expect(parseKyoungdong(changed('in-transit', (data) => { data.prodCode = '2000-0000-00002'; }), IN_TRANSIT).events).toHaveLength(3);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_data: Parcel, body: Reply) => { delete (body as Row).result; },
      (_data: Parcel, body: Reply) => { body.result = 'error'; },
      (_data: Parcel, body: Reply) => { body.result = 'fail'; },
      (_data: Parcel, body: Reply) => { delete (body as Row).data; },
      (_data: Parcel, body: Reply) => { body.data = 'parcel' as never; },
      (data: Parcel) => { delete data.prodCode; },
      (data: Parcel) => { data.prodCode = { code: IN_TRANSIT }; },
      (data: Parcel) => { data.scanList = 'scans' as never; },
      (data: Parcel) => { data.scanList = Array.from({ length: 501 }, () => data.scanList[0]!); },
      (data: Parcel) => { data.scanList[0] = 'scan' as never; },
      (data: Parcel) => { data.scanList[0]!.scanDt = '2026.10.13 18:05'; },
      (data: Parcel) => { data.scanList[0]!.scanDt = '2026-10-13 18:05'; },
      (data: Parcel) => { data.scanList[0]!.scanDt = '2026-10-13 24:00:00'; },
      (data: Parcel) => { data.scanList[0]!.scanDt = '2026-02-30 18:05:44'; },
      (data: Parcel) => { delete data.scanList[0]!.scanDt; },
      (data: Parcel) => { data.scanList[0]!.scanTypeNm = ''; },
      (data: Parcel) => { data.scanList[0]!.scanTypeNm = ['발송']; },
      (data: Parcel) => { data.scanList[0]!.scanType = 'A-2'; },
      (data: Parcel) => { data.scanList[0]!.strtPointNm = 12; },
    ]) {
      expect(() => parseKyoungdong(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    // The lookup answers an unknown number with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://kdexp.com/index.do' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>경동택배</title><body>점검 중</body></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('rejects numbers Kyungdong does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['200000000002', '20000000000002', 'A000000000002', '1'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeKyoungdongNumber('2000-0000-00002')).toBe(IN_TRANSIT);
    expect(normalizeKyoungdongNumber(' 2000 0000 00002 ')).toBe(IN_TRANSIT);
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

  it('routes a number filed under Kyungdong Express to the adapter, and declares no recognition', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: '1000-0000-00001', carrier: 'kyoungdong' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'kyoungdong', source: 'kyoungdong', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${KYOUNGDONG_API}${DELIVERED}`)).toBe(true);
    expect(carrier(fetcher).recognize).toBeUndefined();
  });

  it('leaves Kyungdong’s numbers to the caller: no rule claims thirteen digits', () => {
    for (const number of [DELIVERED, IN_TRANSIT]) expect(detectCarrierMatch(number).carrier, number).not.toBe('kyoungdong');
  });
});

describe('Kyungdong Express status vocabulary', () => {
  it('records every scan type the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string }[]) {
      expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(kyoungdongStage(entry.code ?? null, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'kyoungdong', providerCode: '0008', description: '배송중' })).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'kyoungdong', providerCode: '0099', description: '가상상태' })).toEqual({ kind: 'unknown' });
  });
});
