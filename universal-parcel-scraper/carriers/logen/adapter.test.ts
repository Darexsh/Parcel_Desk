import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, LOGEN_TRACE, LogenTracker } from './adapter.js';
import { logenWording, normalizeLogenNumber, parseLogen } from './parser.js';
import { logenStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '10000000006';
const OUT_FOR_DELIVERY = '20000000005';
const IN_TRANSIT = '30000000004';
const UNKNOWN = '40000000003';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const changed = (name: string, from: string | RegExp, to: string) => {
  const html = fixture(name);
  const next = html.replace(from, to);
  if (next === html) throw new Error(`The ${name} fixture has no ${String(from)}`);
  return next;
};
// The page with its history table's rows edited.
const history = (name: string, edit: (rows: string[]) => string[]) => {
  const html = fixture(name);
  const start = html.indexOf('<tbody>', html.indexOf('class="data tkInfo"')) + '<tbody>'.length;
  const end = html.indexOf('</tbody>', start);
  return html.slice(0, start) + edit(html.slice(start, end).match(/<tr>[\s\S]*?<\/tr>/g)!).join('\n') + html.slice(end);
};
const page = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html;charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The page the tracker serves instead of a lookup for a number that is not ten or eleven digits.
const REFUSED = "<html>\n<script>\n    alert('잘못된 접근입니다. 운송장번호를 확인해주세요.');\n            history.back();\n</script>\n</html>";

describe('Logen HTTP adapter', () => {
  it('gets the tracking page of the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(page(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new LogenTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 300-0000-0004 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${LOGEN_TRACE}${IN_TRANSIT}`);
    expect(String(url)).toBe('https://www.ilogen.com/web/personal/trace/30000000004');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'logen', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads Korean wall clocks at UTC+9 and stages each scan by its label, newest first', () => {
    const result = parseLogen(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '고객님께 물품을 전달하였습니다.', last_update: '2026-09-29T07:43:00Z',
      delivered_at: '2026-09-29T07:43:00Z', expected_delivery: null });
    expect(result).not.toHaveProperty('expected_delivery_from');
    expect(result.events!.map((event) => [event.time, event.location, event.provider_code, event.stage, event.description])).toEqual([
      ['2026-09-29T07:43:00Z', '마바', '배송완료', 'delivered', '고객님께 물품을 전달하였습니다.'],
      ['2026-09-28T23:20:00Z', '마바', '배송출고', 'out_for_delivery', '고객님께 물품을 배달 준비 중입니다.'],
      ['2026-09-28T22:52:00Z', '마바', '배송입고', 'in_transit', '마바지점에 도착했습니다.'],
      ['2026-09-28T14:10:00Z', '다라터미널', '터미널출고', 'in_transit', '마바(으)로 출발하였습니다.'],
      // A bagging scan has no line of its own.
      ['2026-09-28T13:47:00Z', '다라터미널', '행낭적입', 'in_transit', '행낭적입'],
      // The repeated arrival is kept once.
      ['2026-09-28T13:31:00Z', '다라터미널', '터미널입고', 'in_transit', '가나에서 도착하였습니다.'],
      ['2026-09-28T10:05:00Z', '가나', '집하출고', 'in_transit', '다라터미널(으)로 출발하였습니다.'],
      ['2026-09-28T08:40:00Z', '가나', '집하완료', 'accepted', '물품을 접수하였습니다.'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
  });

  it('keeps no sender, recipient, address, goods, staff, receiver or phone number', () => {
    const text = JSON.stringify(parseLogen(fixture('delivered'), DELIVERED));
    expect(text).not.toMatch(/홍|김철수|샘|서울|현관|010-|0505|배송예정|16시/);
  });

  it('gives the window of an out-for-delivery scan on its day while it is the newest scan', () => {
    expect(parseLogen(fixture('out-for-delivery'), OUT_FOR_DELIVERY)).toMatchObject({ status: 'out_for_delivery',
      current_stage: 'out_for_delivery', last_update: '2026-10-13T23:05:00Z',
      expected_delivery_from: '2026-10-14T09:00:00Z', expected_delivery: '2026-10-14T11:00:00Z' });
    // A window the page words otherwise, or that ends before it starts, is left out.
    for (const window of ['오후', '20시~18시', '18시~25시']) {
      const result = parseLogen(changed('out-for-delivery', '18시~20시\n', `${window}\n`), OUT_FOR_DELIVERY);
      expect(result.expected_delivery, window).toBeNull();
      expect(result).not.toHaveProperty('expected_delivery_from');
    }
  });

  it('reads a parcel between hubs, whose history starts when the pickup branch sends it off', () => {
    const result = parseLogen(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: '타파에서 도착하였습니다.',
      last_update: '2026-10-14T12:02:00Z', expected_delivery: null });
    expect(result.events!.map((event) => event.provider_code)).toEqual(['터미널입고', '집하출고']);
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('reads the label a photo link follows, and a history listed newest first', () => {
    const photo = parseLogen(changed('delivered', /배송완료\n/, '배송완료 <a href="#" class="btnPhoto">사진확인</a>\n'), DELIVERED);
    expect(photo.events![0]).toMatchObject({ provider_code: '배송완료', stage: 'delivered' });
    expect(parseLogen(changed('delivered', /배송완료\n/, '배송완료 사진확인\n'), DELIVERED).events![0]).toMatchObject({ provider_code: '배송완료' });
    expect(parseLogen(history('in-transit', (rows) => rows.reverse()), IN_TRANSIT).events!.map((event) => event.provider_code)).toEqual(['터미널입고', '집하출고']);
  });

  it('keeps an unknown label without a stage and takes the stage from the newest scan that has one', () => {
    const result = parseLogen(changed('in-transit', /터미널입고\n/, '가상상태\n'), IN_TRANSIT);
    expect(result.events![0]).toMatchObject({ provider_code: '가상상태', description: '타파에서 도착하였습니다.' });
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: '타파에서 도착하였습니다.' });
    expect(logenStage('가상상태', '샘플')).toBeNull();
  });

  it('takes phone numbers out of a line', () => {
    expect(logenWording('배송출고', '\n\t\t고객님께 물품을 배달 준비 중입니다. 010-0000-0000\n')).toBe('고객님께 물품을 배달 준비 중입니다.');
    expect(logenWording('배송입고', '문의 0505-000-0000 (지점)')).toBe('문의 (지점)');
    expect(logenWording('배송입고', '2026.10.14 도착')).toBe('2026.10.14 도착');
    expect(logenWording('행낭적입', ' \n ')).toBe('행낭적입');
  });

  it('reads the page’s own answer for a number it has no parcel for as not found, and details without scans as no history', () => {
    expect(() => parseLogen(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseLogen(history('in-transit', () => []), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('counts a parcel only when its details name the number asked', () => {
    expect(() => parseLogen(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Logen answered for another parcel' }));
    expect(parseLogen(changed('in-transit', '300-0000-0004', '30000000004'), IN_TRANSIT).events).toHaveLength(2);
  });

  it('rejects a changed page', () => {
    for (const html of [
      '<html><title>로젠택배</title></html>',
      changed('in-transit', '<td class="tit">송장번호</td>', '<td class="tit">운송장</td>'),
      changed('in-transit', '<th scope="col">사업장</th>', '<th scope="col">지점</th>'),
      changed('in-transit', 'table class="data tkInfo"', 'table class="data"'),
      changed('in-transit', '2026.10.14 21:02', '2026-10-14 21:02'),
      changed('in-transit', '2026.10.14 21:02', '2026.10.14 24:00'),
      changed('in-transit', '2026.10.14 21:02', '2026.02.30 21:02'),
      changed('in-transit', '<td>하나센터</td>', ''),
      // A scan with neither a label nor a line.
      changed('in-transit', /터미널입고\n([\s\S]*?)타파에서 도착하였습니다\./, '\n$1'),
      // An empty answer that is not the page's own.
      changed('not-found', '배송자료를 조회할 수 없습니다', '잠시 후 다시 시도해 주세요'),
    ]) {
      expect(() => parseLogen(html, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseLogen(history('in-transit', (rows) => Array.from({ length: 501 }, () => rows[0]!)), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a refused number, a moved route, a browser check and a broken page apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(page(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(REFUSED)).rejects.toMatchObject({ kind: 'invalid_input' });
    // The page answers a missing parcel with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.ilogen.com/web' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>로젠택배</title><body>점검 중</body></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number with its last scan and the unknown-number answer, and asks nothing for a number Logen does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page(fixture('delivered')))
      .mockResolvedValueOnce(page(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-09-29T07:43:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('10000000005')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Logen does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // A wrong check digit, ten or twelve digits, a check digit Logen never gives, letters.
    for (const number of ['10000000005', '1000000006', '100000000060', '10000000007', 'A0000000006', '1'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeLogenNumber('100-0000-0006')).toBe(DELIVERED);
    expect(normalizeLogenNumber(' 100 0000 0006 ')).toBe(DELIVERED);
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(page(fixture('in-transit')));
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

  it('routes a number filed under Logen to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => page(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: '100-0000-0006', carrier: 'logen' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'logen', source: 'logen', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${LOGEN_TRACE}${DELIVERED}`)).toBe(true);
  });

  it('leaves Logen’s numbers to the caller: no rule claims eleven digits with a mod 7 check', () => {
    for (const number of [DELIVERED, OUT_FOR_DELIVERY, IN_TRANSIT]) expect(detectCarrierMatch(number).carrier, number).not.toBe('logen');
  });
});

describe('Logen status vocabulary', () => {
  it('records every label the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      if (!entry.code) {
        expect(entry.stage, entry.wording).toBeUndefined();
        continue;
      }
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(logenStage(entry.code, entry.wording)?.stage, entry.code).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'logen', providerCode: '배송출고', description: '고객님께 물품을 배달 준비 중입니다.' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'logen', providerCode: '가상상태', description: '샘플' })).toEqual({ kind: 'unknown' });
  });
});
