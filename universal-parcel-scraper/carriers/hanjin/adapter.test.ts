import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, HANJIN_ENDPOINT, HanjinTracker } from './adapter.js';
import { parseHanjin } from './parser.js';
import { hanjinScanStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '400000000013';
const TRANSIT = '400000000024';
const INTERNATIONAL = '800000000004';
const ABSENT = '500000000006';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
const rows = (result: ReturnType<typeof parseHanjin>) => result.events!.map(event => [event.time ?? event.local_time, event.location, event.description, event.stage]);
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType: \'interactive\'};</script></body></html>';
const SEARCH = '<!DOCTYPE html><html><head><title>글로벌 종합물류기업 (주)한진&gt;배송조회 </title></head><body>'
  + '<form name="frm" method="post" action="/kor/CMS/DeliveryMgr/WaybillResult.do"><input type="hidden" name="wblnum" id="wblnum" />'
  + '<input type="text" class="text" name="wblnumText" id="wblnumText" /></form></body></html>';
// The result page older trackers rendered for an unknown number: the number and the notice, no scans.
const NOTICE_PAGE = page('delivered').replace(/<p class="comm-sec">[\s\S]*?<\/p>/, '<p class="comm-sec"><span class="comm-ico "></span> 운송장이 등록되지 않았거나 보내는 분(업체)이 상품을 준비 중 입니다. </p>')
  .replace(/<h3 class="c-tit01">기본정보<\/h3>[\s\S]*?<div class="sgap"><\/div>/, '');
// Marks the clocks of the rows at these times with the page's asterisk.
const star = (html: string, ...clocks: string[]) => clocks.reduce((marked, clock) => marked.replace(
  `<td class="w-time">${clock}</td>`, `<td class="w-time">${clock}<string class="cblue">*</string></td>`), html);

describe('Hanjin tracking adapter', () => {
  it('asks the result page once for the whole waybill through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new HanjinTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 4000-0000-0013 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://www.hanjin.com/kor/CMS/DeliveryMgr/WaybillResult.do?mCode=MN038&wblnum=${DELIVERED}&schLang=KR`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'hanjin', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered domestic history newest first on Korean time, without names, phones or the basic table', () => {
    const result = parseHanjin(page('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '배송완료하였습니다.', last_update: '2026-03-03T13:47:00+09:00', delivered_at: '2026-03-03T13:47:00+09:00',
      events: [
        { time: '2026-03-03T13:47:00+09:00', description: '배송완료하였습니다.', location: '샘플(집)', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2026-03-03T10:20:00+09:00', description: '배송출발하였습니다.', location: '샘플(집)', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2026-03-03T07:56:00+09:00', description: '배송지점에 도착하여 배송을 준비중입니다.', location: '샘플 터미널', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-03-03T07:55:00+09:00', description: '샘플 터미널에 도착하였습니다.', location: '샘플 터미널', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-03-03T00:40:00+09:00', description: 'Mega-Hub터미널에서 샘플터미널로 이동중입니다.', location: 'Mega-Hub 터미널', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-03-03T00:12:00+09:00', description: 'Mega-Hub 터미널에 도착하였습니다.', location: 'Mega-Hub 터미널', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-03-02T19:41:00+09:00', description: '예시터미널에서 Mega-Hub터미널로 이동중입니다.', location: '예시 터미널', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-03-02T19:40:00+09:00', description: '고객님 상품을 집하하여 예시 터미널에 입고되었습니다.', location: '예시 터미널', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-03-02T16:05:00+09:00', description: '고객님 상품을 접수하였습니다.', location: '가상(집)', stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
    const text = JSON.stringify(result);
    for (const kept of ['홍길동', '김가상', '010-0000', '집하사원', '배송사원', '테스트 상품', '가*상*', '예*인', '가상시', '선불', '1588']) {
      expect(text, kept).not.toContain(kept);
    }
  });

  it('keeps the scans abroad as wall clocks up to Korean customs, then reads Korean time', () => {
    const result = parseHanjin(page('in-transit'), TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Mega-Hub 터미널에 도착하였습니다.',
      last_update: '2026-04-07T22:10:00+09:00' });
    expect(result.delivered_at).toBeUndefined();
    expect(rows(result)).toEqual([
      ['2026-04-07T22:10:00+09:00', 'Mega-Hub 터미널', 'Mega-Hub 터미널에 도착하였습니다.', 'in_transit'],
      ['2026-04-07T13:37:00+09:00', '인천공항 터미널', '인천공항터미널에서 Mega-Hub터미널로 이동중입니다.', 'in_transit'],
      ['2026-04-07T13:35:00+09:00', 'ICN', '수입통관이 완료되어 국내배송 예정입니다.', 'in_transit'],
      ['2026-04-07T13:33:00+09:00', 'ICN', '수입통관장에 반입되었습니다.(통관불가)', 'customs'],
      ['2026-04-06T10:10:00', 'SGI', '항공편으로 출발 대기중입니다.', 'in_transit'],
      ['2026-04-06T10:10:00', 'SGI', '고객님 상품을 집하하여 SGI에 입고되었습니다.', 'in_transit'],
      ['2026-04-06T10:10:00', 'SGI', '고객님 상품을 접수하였습니다.', 'accepted'],
      ['2026-04-06T09:37:00', 'WEH', '운송장 정보가 등록되었습니다.', 'registered'],
    ]);
    for (const kept of ['이가상', '집하사원', '통관진행상태', 'unipass', 'SAMPLE ITEM', '예시군']) {
      expect(JSON.stringify(result), kept).not.toContain(kept);
    }
    // A history whose newest scan is still abroad has no instant at all.
    const abroad = parseHanjin(page('in-transit').replace(/<tr class="">\s*<td class="w-date">2026-04-07[\s\S]*?<\/tr>/g, ''), TRANSIT);
    expect(abroad).toMatchObject({ status: 'in_transit', last_update: null, last_update_local: '2026-04-06T10:10:00' });
    expect(abroad.events!.every(event => !event.time && event.local_time)).toBe(true);
  });

  it('reads an international waybill the same way, and its delivery as an instant', () => {
    const result = parseHanjin(page('international'), INTERNATIONAL);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: '배송완료 되었습니다.',
      last_update: '2026-05-14T12:25:00+09:00', delivered_at: '2026-05-14T12:25:00+09:00' });
    expect(rows(result)).toEqual([
      ['2026-05-14T12:25:00+09:00', '샘플(집)', '배송완료 되었습니다.', 'delivered'],
      ['2026-05-14T11:24:00+09:00', '샘플(집)', '배송출발 하였습니다.', 'out_for_delivery'],
      ['2026-05-14T08:30:00+09:00', '샘플터미널', '배송원이 배송준비중 입니다.', 'in_transit'],
      ['2026-05-14T01:21:00+09:00', 'Mega-Hub터미널', '국내배송을 위해 Mega-Hub터미널에서 샘플터미널로 이동중 입니다.', 'in_transit'],
      ['2026-05-13T22:23:00+09:00', 'Mega-Hub터미널', 'Mega-Hub터미널에 도착하였습니다.', 'in_transit'],
      ['2026-05-13T13:11:00+09:00', '인천공항터미널', '국내배송을 위해 인천공항터미널에서 Mega-Hub터미널로 이동중 입니다.', 'in_transit'],
      ['2026-05-13T13:08:00+09:00', 'Incheon Intl Airport터미널', '수입통관이 완료되어 국내배송 예정입니다.', 'in_transit'],
      ['2026-05-13T13:06:00+09:00', 'Incheon Intl Airport터미널', '수입통관장에 반입되었습니다.', 'customs'],
      ['2026-05-11T14:58:00', 'HANEDA(SGW)', 'ZZ0101 항공편으로 출발 대기중입니다.', 'in_transit'],
      ['2026-05-11T14:58:00', 'HANEDA(SGW)', '상품이 물류센터에 입고되었습니다.', 'in_transit'],
      ['2026-05-11T13:52:00', 'NRT(SGW) Airport터미널', '운송장 정보가 등록되었습니다.', 'registered'],
    ]);
    for (const kept of ['15881612', '010-0000', '99900000000', 'SAMPLE CO', 'KIM G', 'SAMPLE GOODS']) {
      expect(JSON.stringify(result), kept).not.toContain(kept);
    }
    // Without a Korean customs scan, nothing on an international waybill gets an offset.
    const uncleared = parseHanjin(page('international').replace(/수입통관장에 반입되었습니다\.|수입통관이 완료되어 국내배송 예정입니다\./g, '현지 배송사 처리'), INTERNATIONAL);
    expect(uncleared).toMatchObject({ last_update: null, last_update_local: '2026-05-14T12:25:00', current_stage: 'delivered' });
    expect(uncleared.delivered_at).toBeUndefined();
    expect(uncleared.events!.some(event => event.time)).toBe(false);
  });

  it('keeps a clock the page marks as local time a wall clock, and the history before Korean customs with it', () => {
    const marked = parseHanjin(star(page('in-transit'), '13:37'), TRANSIT);
    expect(rows(marked).slice(0, 3).map(row => row[0])).toEqual(['2026-04-07T22:10:00+09:00', '2026-04-07T13:37:00', '2026-04-07T13:35:00+09:00']);
    // A domestic waybill with a marked clock and no customs scan is read from abroad throughout.
    const domestic = parseHanjin(star(page('delivered'), '16:05'), DELIVERED);
    expect(domestic).toMatchObject({ last_update: null, last_update_local: '2026-03-03T13:47:00' });
    expect(domestic.events!.some(event => event.time)).toBe(false);
    // So is one waiting for a flight.
    const flown = parseHanjin(page('delivered').replace('고객님 상품을  <strong>접수</strong>하였습니다.', '항공편으로 출발 대기중입니다.'), DELIVERED);
    expect(flown.events!.some(event => event.time)).toBe(false);
  });

  it('leaves the stage to the shared rules for new wording, and unknown when they do not know it either', () => {
    const unknown = parseHanjin(page('delivered').replace('<strong>배송완료</strong>하였습니다.</span>', '새로운 상태입니다.</span>'), DELIVERED);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: '새로운 상태입니다.', last_update: '2026-03-03T13:47:00+09:00' });
    expect(unknown.current_stage).toBeUndefined();
    expect(unknown.delivered_at).toBeUndefined();
    expect(unknown.events![0]).toEqual({ time: '2026-03-03T13:47:00+09:00', description: '새로운 상태입니다.', location: '샘플(집)' });
    const shared = parseHanjin(page('delivered').replace('<strong>배송완료</strong>하였습니다.</span>', 'Delivered</span>'), DELIVERED);
    expect(shared).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: expect.stringMatching(/^wording:/) });
  });

  it('keeps each scan once, skips the rows the page leaves empty and drops a missing location', () => {
    const repeated = page('delivered').replace(/(<tr class="">\s*<td class="w-date">2026-03-03<\/td>\s*<td class="w-time">07:55[\s\S]*?<\/tr>)/, '$1$1');
    expect(parseHanjin(repeated, DELIVERED).events).toHaveLength(9);
    const blank = parseHanjin(page('delivered').replace('<td class="w-org">가상(집)</td>', '<td class="w-org">-</td>'), DELIVERED);
    expect(blank.events!.at(-1)).toEqual({ time: '2026-03-02T16:05:00+09:00', description: '고객님 상품을 접수하였습니다.', stage: 'accepted', stage_source: 'carrier_map' });
    const filler = page('delivered').replace('<tbody>\n\t\t\t\t\t\t\t<tr class="">', '<tbody>\n<tr><td></td><td> </td><td></td><td></td></tr>\n<tr class="">');
    expect(parseHanjin(filler, DELIVERED).events).toHaveLength(9);
  });

  it('binds the page to the requested waybill and rejects pages it cannot read', () => {
    expect(() => parseHanjin(page('delivered'), TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Hanjin answered for another waybill' }));
    for (const html of [
      page('delivered').replace(`<span class="num">${DELIVERED}</span>`, '<span class="num"></span>'),
      page('delivered').replace(`<span class="num">${DELIVERED}</span>`, `<span class="num">${DELIVERED}</span><span class="num">${DELIVERED}</span>`),
      page('delivered').replace('<div class="waybill-tbl">', '<div class="waybill-tbl"><table></table>'),
      page('delivered').replace('<div class="waybill-tbl">', '<div class="waybill-tbl-gone">'),
      page('delivered').replace('scope="col" style="font-weight: bold;">상품위치', 'scope="col" style="font-weight: bold;">위치'),
      page('delivered').replace('<td class="w-time">13:47</td>', '<td class="w-time">24:10</td>'),
      page('delivered').replace('<td class="w-date">2026-03-03</td>\n\t\t\t\t\t\t\t\t\t<td class="w-time">13:47', '<td class="w-date">2026-02-30</td>\n\t\t\t\t\t\t\t\t\t<td class="w-time">13:47'),
      page('delivered').replace('<td class="w-date">2026-03-02</td>', '<td class="w-date">2026.03.02</td>'),
      page('delivered').replace('<span class="stateDesc"><strong>배송완료</strong>하였습니다.</span>', '<span class="stateDesc"> </span>'),
      page('delivered').replace('<span class="stateDesc"><strong>배송완료</strong>하였습니다.</span>', '<strong>배송완료</strong>하였습니다.'),
      page('delivered').replace('<td class="w-org">샘플(집)</td>', ''),
      '<html><body>점검중</body></html>']) {
      expect(() => parseHanjin(html, DELIVERED), html.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const many = page('delivered').replace(/<tr class="">\s*<td class="w-date">[\s\S]*?<\/tr>/, (row: string) => row.repeat(301));
    expect(() => parseHanjin(many, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads only the tracker’s notice for an unknown number as a missing shipment', () => {
    expect(() => parseHanjin(page('not-found'), ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseHanjin(NOTICE_PAGE, DELIVERED)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The page's other notices, a page without scans and the search form are no answer about the shipment.
    expect(() => parseHanjin(page('not-found').replace(/alert\("[^"]+"\)/, 'alert("운송장 번호는 숫자만 입력 가능합니다.")'), ABSENT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHanjin(NOTICE_PAGE.replace('운송장이 등록되지 않았거나', '조회가 지연되거나'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const empty = page('delivered').replace(/<tr class="">\s*<td class="w-date">[\s\S]*?<\/tr>/g, '');
    expect(() => parseHanjin(empty, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseHanjin(empty.replace(/<p class="comm-sec">[\s\S]*?<\/p>/, '<p class="comm-sec">운송장이 등록되지 않았거나 보내는 분(업체)이 상품을 준비 중 입니다.</p>'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseHanjin(SEARCH, ABSENT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The search script on every result page alerts too; a known waybill is never read as unknown.
    expect(page('delivered')).toContain('alert("운송장번호를 입력해주세요.")');
    for (const html of [CHALLENGE, '<html><head><title>Attention Required! | Cloudflare</title></head><body></body></html>',
      '<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Please consult with your administrator.</body></html>']) {
      expect(() => parseHanjin(html, ABSENT)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('takes twelve digits with their check digit or fourteen digits, without a request otherwise', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['400000000014', '40000000001', '4000000000134', '400000000013000', '8317584424', 'HJ4000000000', '1Z999AA10123456784']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    const asked = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('not-found')));
    await expect(carrier(asked).track({ number: '40000000001399' })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(asked.mock.calls[0]![0])).toContain('wblnum=40000000001399&');
  });

  it('reads the notice for an unknown number as not found and recognizes a known shipment, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('delivered'))).mockResolvedValueOnce(reply(page('not-found')))
      .mockResolvedValueOnce(reply(page('not-found'))).mockResolvedValueOnce(reply(page('in-transit')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-03T04:47:00.000Z' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'not_found' });
    // A page for another waybill is no answer either way.
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(status === 429 || status === 403 ? CHALLENGE : '', status));
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps a challenge served with HTTP 200, redirects, empty pages and oversized replies apart from missing shipments', async () => {
    const challenged = vi.fn<typeof fetch>().mockImplementation(async () => reply(CHALLENGE));
    await expect(carrier(challenged).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(challenged).recognize!(ABSENT)).rejects.toMatchObject({ kind: 'challenge' });
    for (const response of [() => new Response(null, { status: 302, headers: { Location: `${HANJIN_ENDPOINT}?mCode=MN038` } }),
      () => new Response(null, { status: 301, headers: { Location: 'https://www.hanjin.com/' } }), () => reply(''), () => reply('  ')]) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'indeterminate' });
      await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(1_100_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(page('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(page('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a waybill to the adapter when the caller names Hanjin or pastes its link, which detection never offers', async () => {
    for (const number of [DELIVERED, INTERNATIONAL]) {
      expect(detectCarrierMatch(number).candidates).not.toContain('hanjin');
      expect(recognitionAskedCarriers(number)).not.toContain('hanjin');
    }
    for (const link of [`https://www.hanjin.com/kor/CMS/DeliveryMgr/WaybillResult.do?mCode=MN038&wblnum=${DELIVERED}&schLang=KR`,
      `http://www.hanjin.co.kr/Delivery_html/inquiry/result_waybill.jsp?wbl_num=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'hanjin', source: 'link' });
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'hanjin' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'hanjin', source: 'hanjin', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${HANJIN_ENDPOINT}?`))).toBe(true);
  });
});

describe('Hanjin status vocabulary', () => {
  it('records every scan wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      // The progress rail and the notice for an unknown number never come as scans.
      const scan = stage !== undefined && !entry.note.startsWith('A step of the progress rail');
      expect(hanjinScanStage(entry.wording), entry.wording).toBe(scan ? stage : undefined);
      expect(statusMap.stage(null, entry.wording.toLocaleLowerCase('en-US').split(/\s+/).join(' ')), entry.wording).toBe(scan ? stage : undefined);
    }
    expect(hanjinScanStage('  배송완료  하였습니다 ')).toBe('delivered');
    expect(hanjinScanStage('KE0552 항공편으로 출발 대기중입니다.')).toBe('in_transit');
    for (const wording of ['constructor', '배송완료', '배송완료하였습니다. 감사합니다', '배송 완료', '상품 접수']) {
      expect(hanjinScanStage(wording), wording).toBeUndefined();
    }
    expect(statusMap.stage('7', '배송완료하였습니다.')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'hanjin', description: '배송출발 하였습니다.' })).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
  });
});
