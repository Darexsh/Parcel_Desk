import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, LOTTE_TRACKING, LotteGlobalTracker } from './adapter.js';
import { lotteWording, normalizeLotteNumber, parseLotte } from './parser.js';
import { lotteStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '200000000012';
const IN_TRANSIT = '200000000023';
const OUT_FOR_DELIVERY = '200000000034';
const ARCHIVED = '200000000045';
const NOT_SHIPPED = '200000000056';
const UNKNOWN = '200000000060';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html;charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The history's rows, which alone carry a cell of class "tl".
const rows = (html: string) => [...html.matchAll(/ {28}<tr>\n[\s\S]*?<\/tr>\n/g)].map((match) => match[0]).filter((row) => row.includes('class="tl"'));
const withRows = (html: string, change: (list: string[]) => string[]) => {
  const list = rows(html);
  const start = html.indexOf(list[0]!);
  const end = html.indexOf(list.at(-1)!) + list.at(-1)!.length;
  return html.slice(0, start) + change(list).join('') + html.slice(end);
};

describe('Lotte Global Logistics HTTP adapter', () => {
  it('posts the whole number to the tracking form’s result page once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new LotteGlobalTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 2000-0000-0023 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(LOTTE_TRACKING);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(String(init!.body)).toBe(`InvNo=${IN_TRANSIT}`);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'lotte-global', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery at Seoul time, without the courier, the customer as a place or the pickup listed twice', () => {
    const result = parseLotte(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '물품을 받으셨습니다.', last_update: '2026-05-13T05:21:00Z', last_update_local: '2026-05-13T14:21:00',
      delivered_at: '2026-05-13T05:21:00Z', expected_delivery: null });
    expect(result).not.toHaveProperty('summary_only');
    expect(result.events!.map((event) => [event.time, event.local_time, event.provider_code, event.stage, event.location ?? null, event.description]))
      .toEqual([
        ['2026-05-13T05:21:00Z', '2026-05-13T14:21:00', '배달 완료', 'delivered', null, '물품을 받으셨습니다.'],
        ['2026-05-13T05:21:00Z', '2026-05-13T14:21:00', '배달 완료', 'delivered', '샘플배달(대)', '배달 완료하였습니다.'],
        ['2026-05-12T23:40:00Z', '2026-05-13T08:40:00', '배송 출발', 'out_for_delivery', '샘플배달(대)', '고객님의 상품을 14~16시에 배달 예정 입니다.'],
        ['2026-05-12T22:12:00Z', '2026-05-13T07:12:00', '상품 이동중', 'in_transit', '샘플집배센터', '샘플집배센터에 도착하였습니다.'],
        ['2026-05-12T17:05:00Z', '2026-05-13T02:05:00', '상품 이동중', 'in_transit', '샘플권MEGAHUB(터)', '샘플권MEGAHUB(터)에 도착하였습니다.'],
        ['2026-05-12T13:30:00Z', '2026-05-12T22:30:00', '상품 이동중', 'in_transit', '샘플TML', '샘플TML에 도착하였습니다.'],
        ['2026-05-12T08:02:00Z', '2026-05-12T17:02:00', '인수/상품접수', 'accepted', '샘플접수(대)', '보내시는 고객님으로부터 상품을 인수했습니다.'],
      ]);
    expect(JSON.stringify(result)).not.toMatch(/홍길동|010-0000-0000|배송담당|고객"|\*\*\*/);
  });

  it('reads a parcel on its way', () => {
    const result = parseLotte(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: '샘플TML에 도착하였습니다.',
      last_update: '2026-05-12T13:30:00Z', expected_delivery: null });
    expect(result.events!.map((event) => event.provider_code)).toEqual(['상품 이동중', '인수/상품접수']);
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('gives the courier’s window on the day of the out-for-delivery scan while that scan is the latest', () => {
    const result = parseLotte(fixture('out-for-delivery'), OUT_FOR_DELIVERY);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_update: '2026-05-12T23:40:00Z',
      expected_delivery_from: '2026-05-13T05:00:00Z', expected_delivery: '2026-05-13T07:00:00Z' });
    // A pickup whose time the tracker hides, without a timed twin, keeps its day.
    expect(result.events!.at(-1)).toEqual({ local_time: '2026-05-12', location: '샘플접수(대)', description: '보내시는 고객님으로부터 상품을 인수했습니다.',
      provider_code: '인수/상품접수', stage: 'accepted', stage_source: 'carrier_map' });
    // A window that ended before the scan, or reads backwards, is no estimate.
    for (const window of ['06~08', '16~14', '14~25']) {
      const late = parseLotte(fixture('out-for-delivery').replace('14~16', window), OUT_FOR_DELIVERY);
      expect(late).toMatchObject({ current_stage: 'out_for_delivery', expected_delivery: null });
      expect(late).not.toHaveProperty('expected_delivery_from');
    }
    // Delivered, the window is history.
    expect(parseLotte(fixture('delivered'), DELIVERED)).toMatchObject({ expected_delivery: null });
    expect(parseLotte(fixture('delivered'), DELIVERED)).not.toHaveProperty('expected_delivery_from');
  });

  it('keeps the day of scans the tracker shows without a time, with no instant', () => {
    const result = parseLotte(fixture('archived'), ARCHIVED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null, last_update_local: '2019-03-12' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time ?? null, event.local_time, event.provider_code])).toEqual([
      [null, '2019-03-12', '배달 완료'], [null, '2019-03-11', '인수/상품접수'],
    ]);
  });

  it('turns an oldest-first history round', () => {
    const reversed = withRows(fixture('in-transit'), (list) => [...list].reverse());
    expect(parseLotte(reversed, IN_TRANSIT).events!.map((event) => event.provider_code)).toEqual(['상품 이동중', '인수/상품접수']);
  });

  it('reads a known label without scans from the summary alone', () => {
    expect(parseLotte(fixture('not-shipped'), NOT_SHIPPED)).toEqual({ status: 'pending', current_stage: 'registered',
      current_stage_source: 'carrier_map', last_status_text: '미출고', provider_code: '미출고', summary_only: true, last_update: null,
      expected_delivery: null, events: [] });
    expect(parseLotte(fixture('not-shipped').replace('<td>미출고</td>', '<td>예약취소</td>'), NOT_SHIPPED))
      .toMatchObject({ status: 'exception', current_stage: 'exception', provider_code: '예약취소', summary_only: true });
    // A word the map does not know keeps the carrier's text without a stage.
    const other = parseLotte(fixture('not-shipped').replace('<td>미출고</td>', '<td>합포장</td>'), NOT_SHIPPED);
    expect(other).toMatchObject({ status: 'unknown', provider_code: '합포장', summary_only: true });
    expect(other).not.toHaveProperty('current_stage');
    // Real branches with neither scans nor a word: known, with nothing to say yet.
    expect(() => parseLotte(fixture('not-shipped').replace('<td>미출고</td>', '<td> </td>'), NOT_SHIPPED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads the tracker’s answer for a waybill it does not know as not found, and nothing else', () => {
    expect(() => parseLotte(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The placeholder branches with a delivery word, or with scans, are not that answer.
    expect(() => parseLotte(fixture('not-found').replace('<td> </td>', '<td>미출고</td>'), UNKNOWN)).not.toThrow();
    const scanned = fixture('in-transit').replace(/<td>샘플접수\(대\)<\/td>\n(\s*)<td>샘플배달\(대\)<\/td>/, '<td>***</td>\n$1<td>***</td>');
    expect(parseLotte(scanned, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit' });
  });

  it('counts a waybill only when the summary names its whole number', () => {
    expect(() => parseLotte(fixture('delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLotte(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLotte(fixture('delivered').replace(`<td>${DELIVERED}</td>`, `<td>${DELIVERED.slice(1)}</td>`), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps maintenance, a refused number and a changed page apart', () => {
    expect(() => parseLotte(fixture('maintenance'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'maintenance' }));
    expect(() => parseLotte(fixture('rejected'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const delivered = fixture('delivered');
    for (const html of [
      '<html><title>롯데글로벌로지스</title><body>택배조회</body></html>',
      '{"error":"unexpected"}',
      delivered.replace('<th scope="col">처리현황</th>', '<th scope="col">상태</th>'),
      delivered.replace('<th scope="col">배달결과</th>', ''),
      delivered.replace('</tbody>', `<tr><td>${DELIVERED}</td><td>a</td><td>b</td><td>c</td></tr></tbody>`),
      delivered.replace('2026-05-13&nbsp;08:40', '2026-05-13&nbsp;25:40'),
      delivered.replace('2026-05-13&nbsp;08:40', '2026-02-30&nbsp;08:40'),
      delivered.replace('2026-05-13&nbsp;08:40', '13.05.2026 08:40'),
      delivered.replace('2026-05-12&nbsp;--:--', '2026-13-12&nbsp;--:--'),
      delivered.replace('2026-05-13&nbsp;08:40', ''),
      delivered.replace('<td class="tl">샘플TML에 도착하였습니다.</td>', ''),
      delivered.replace('<td class="tl">샘플TML에 도착하였습니다.</td>', '<td class="tl" colspan="2">샘플TML에 도착하였습니다.</td>'),
      delivered.replace('<td>상품 이동중</td>', '<td></td>').replace('<td class="tl">샘플집배센터에 도착하였습니다.</td>', '<td class="tl"></td>'),
      withRows(delivered, (list) => Array.from({ length: 501 }, () => list[1]!)),
    ]) {
      expect(() => parseLotte(html, DELIVERED), html.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A step the map does not know keeps its name and wording without a stage.
    const unmapped = parseLotte(delivered.replace('<td>상품 이동중</td>', '<td>간선상차</td>'), DELIVERED);
    expect(unmapped.events![3]).toMatchObject({ provider_code: '간선상차', description: '샘플집배센터에 도착하였습니다.' });
    expect(unmapped.events![3]).not.toHaveProperty('stage');
  });

  it('keeps an unknown number, a moved page, a browser check and a broken page apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The tracker answers every waybill with HTTP 200: a 404 or a redirect is a moved page.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.lotteglogis.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(fixture('maintenance'))).rejects.toMatchObject({ kind: 'maintenance' });
    await expect(lookup('<html><title>롯데글로벌로지스</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('rejects numbers Lotte does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // The tracker's form refuses a waybill that is not twelve digits or fails the check digit.
    for (const number of ['200000000013', '20000000001', '2000000000120', 'LOTTE0000012', '', `2${'0'.repeat(80)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
      expect(() => parseLotte(fixture('delivered'), number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeLotteNumber('2000 0000 0012')).toBe(DELIVERED);
    expect(carrier(fetcher)).not.toHaveProperty('recognize');
  });

  it('takes the courier’s name and phone out of the wording', () => {
    expect(lotteWording('배달 완료하였습니다. (배송담당: 홍길동 010-0000-0000)')).toBe('배달 완료하였습니다.');
    expect(lotteWording('고객님의 상품을  14~16시에 배달 예정 입니다. (배송담당: 홍길동 010-0000-0000)')).toBe('고객님의 상품을 14~16시에 배달 예정 입니다.');
    expect(lotteWording('(집배담당: 홍길동) 샘플TML에 도착하였습니다.')).toBe('샘플TML에 도착하였습니다.');
    expect(lotteWording('문의 02-000-0000 또는 0100000000')).toBe('문의 또는');
    expect(lotteWording('샘플권MEGAHUB(터)에 도착하였습니다.')).toBe('샘플권MEGAHUB(터)에 도착하였습니다.');
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

  it('routes a number filed under Lotte Global Logistics to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'lotte-global' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'lotte-global', source: 'lotte-global', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === LOTTE_TRACKING)).toBe(true);
  });
});

describe('Lotte Global Logistics status vocabulary', () => {
  it('records every step and summary word the map knows with the stage it gives', () => {
    for (const { code, wording, stage } of statuses.entries) {
      if (!code) continue;
      expect(statusMap.stage(code, wording.toLowerCase()), code).toBe(stage);
      expect(lotteStage(code, wording)?.stage, code).toBe(stage);
    }
    expect(statusMapAnswer({ carrier: 'lotte-global', providerCode: '배송 출발', description: '고객님의 상품을 14~16시에 배달 예정 입니다.' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'lotte-global', providerCode: '합포장', description: '합포장' })).toEqual({ kind: 'unknown' });
    expect(lotteStage('합포장', '합포장')).toBeNull();
  });
});
