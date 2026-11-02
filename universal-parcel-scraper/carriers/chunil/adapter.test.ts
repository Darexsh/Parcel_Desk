import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CHUNIL_TRACE, chunilTraceUrl, ChunilTracker } from './adapter.js';
import { normalizeChunilNumber, parseChunil } from './parser.js';
import { chunilStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '20000000011';
const IN_TRANSIT = '20000000022';
const UNKNOWN = '20000000099';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: BodyInit, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const answering = (respond: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => respond());
const page = (name: string) => answering(() => reply(fixture(name)));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// Cloudflare's managed challenge, as it could stand in place of the page.
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:"managed"};</script></body></html>';
// The scan rows of the route table, oldest first, as the page lists them.
const ROWS = /(<table width="100%" id="tracking"[^>]*>\s*<tr>[\s\S]*?<\/tr>)([\s\S]*?)(<\/table>)/;
const withRows = (html: string, change: (rows: string) => string) => html.replace(ROWS, (_, head: string, rows: string, end: string) =>
  `${head}${change(rows)}${end}`);
const row = (day: string, branch: string, label: string) => `<tr><td align="center" bgcolor="#FFFFFF">${day}</td>`
  + `<td align="center" bgcolor="#FFFFFF">${branch}</td><td align="center" bgcolor="#FFFFFF">000-000-0000</td>`
  + `<td align="center" bgcolor="#FFFFFF">${label}</td></tr>`;
const outcome = (html: string, value: string) => html.replace(/(배송\/출고결과 :<\/td>\s*<td bgcolor="#FFFFFF">)[^<]*/, `$1${value}`);
const events = (result: ReturnType<typeof parseChunil>) => result.events!.map((event) => [event.local_time, event.description,
  event.stage ?? null, event.location ?? null]);

describe('Chunil Express HTTP adapter', () => {
  it('asks the tracking page for the whole number, through the supplied transport', async () => {
    const fetcher = page('in-transit');
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ChunilTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 200-0000-0022 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${CHUNIL_TRACE}?transNo=${IN_TRANSIT}`);
    expect(chunilTraceUrl('2000 0000 011')).toBe(`${CHUNIL_TRACE}?transNo=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'chunil', step: 'direct', outcome: 'ok' }));
  });

  it('reads a delivered route newest first as days, at branches, without names, phone numbers or goods', () => {
    const result = parseChunil(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '배송완료', last_update: null, last_update_local: '2026-03-04', expected_delivery: null,
    });
    for (const field of ['summary_only', 'delivered_at', 'receiver_name', 'sender_name', 'history_truncated']) {
      expect(result).not.toHaveProperty(field);
    }
    expect(events(result)).toEqual([
      ['2026-03-04', '배송완료', 'delivered', '예시'],
      ['2026-03-04', '영업소도착', 'in_transit', '예시'],
      ['2026-03-04', '도착터미널하차', 'in_transit', '예시터미널'],
      ['2026-03-03', '발송터미널출발', 'in_transit', '샘플터미널'],
      ['2026-03-02', '발송터미널하차', 'in_transit', '샘플터미널'],
      ['2026-03-02', '발송', 'in_transit', '천일샘플'],
      ['2026-03-02', '접수', 'accepted', '천일샘플'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && !('provider_code' in event))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/샘\*\*|예\*\*|000-000-0000|샘플 상품|샘플로|예시로|2BOX/);
  });

  it('reads an in-transit route by its newest staged scan, with the delivery result still empty', () => {
    const result = parseChunil(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: '도착터미널하차', last_update: null, last_update_local: '2026-10-13', expected_delivery: null,
    });
    expect(events(result).map(([day, label, stage]) => [day, label, stage])).toEqual([
      ['2026-10-13', '도착터미널하차', 'in_transit'],
      ['2026-10-12', '발송터미널출발', 'in_transit'],
      ['2026-10-12', '발송터미널하차', 'in_transit'],
      ['2026-10-12', '발송', 'in_transit'],
      ['2026-10-12', '접수', 'accepted'],
    ]);
    // A scan whose label the map does not know is kept without a stage; the newest staged scan decides.
    const unlabelled = parseChunil(withRows(fixture('in-transit'), (rows) => `${rows}${row('2026-10-14', '예시', '샘플상태')}`), IN_TRANSIT);
    expect(unlabelled).toMatchObject({ current_stage: 'in_transit', last_status_text: '샘플상태', last_update_local: '2026-10-14' });
    expect(unlabelled.events![0]).not.toHaveProperty('stage');
    // A trunk-line or out-for-delivery scan another tracker lists is staged too.
    const out = parseChunil(withRows(fixture('in-transit'), (rows) => `${rows}${row('2026-10-14', '예시', '배송출발')}`), IN_TRANSIT);
    expect(out).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_update_local: '2026-10-14' });
  });

  it('keeps a repeated scan once, and a branch without a phone number', () => {
    const repeated = parseChunil(withRows(fixture('in-transit'), (rows) => `${rows}${row('2026-10-13', '예시터미널', '도착터미널하차')}`), IN_TRANSIT);
    expect(repeated.events).toHaveLength(5);
    const phoned = parseChunil(withRows(fixture('in-transit'), (rows) => `${rows}${row('2026-10-14', '예시 (031-000-0000)', '영업소도착')}`), IN_TRANSIT);
    expect(phoned.events![0]).toMatchObject({ location: '예시', description: '영업소도착' });
  });

  it('lets the delivery result settle a route without the delivery, and stand in for an empty route', () => {
    const delivered = parseChunil(outcome(fixture('in-transit'), '배송완료'), IN_TRANSIT);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '배송완료', last_update: null });
    expect(delivered).not.toHaveProperty('last_update_local');
    expect(delivered.events).toHaveLength(5);
    // Only a delivery outranks the route's own scans.
    expect(parseChunil(outcome(fixture('in-transit'), '접수'), IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit' });
    const summary = parseChunil(withRows(outcome(fixture('in-transit'), '배송완료'), () => ''), IN_TRANSIT);
    expect(summary).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: '배송완료', summary_only: true, events: [] });
    const unlabelled = parseChunil(withRows(outcome(fixture('in-transit'), '샘플상태'), () => ''), IN_TRANSIT);
    expect(unlabelled).toMatchObject({ status: 'unknown', last_status_text: '샘플상태', summary_only: true });
    expect(unlabelled).not.toHaveProperty('current_stage');
    expect(() => parseChunil(withRows(fixture('in-transit'), () => ''), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads the page’s empty answer as not found, and a parcel only when the page names the number asked', () => {
    expect(() => parseChunil(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // An answer for another number is no answer, either way.
    expect(() => parseChunil(fixture('not-found'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Chunil Express answered for another number' }));
    expect(() => parseChunil(fixture('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Chunil Express answered for another parcel' }));
    const heading = fixture('in-transit').replace(`<b>${IN_TRANSIT}</b>`, `<b>${UNKNOWN}</b>`);
    expect(() => parseChunil(heading, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const field = fixture('in-transit').replace(`id="transNo" value="${IN_TRANSIT}"`, `id="transNo" value="${UNKNOWN}"`);
    expect(() => parseChunil(field, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed page', () => {
    for (const change of [
      (html: string) => html.replace('id="transNo"', 'id="waybill"'),
      (html: string) => html.replace(/<span class="style7">상태<\/span>/, '<span class="style7">내용</span>'),
      (html: string) => html.replace('id="tracking"', 'id="route"'),
      (html: string) => html.replace(/<b>(\d{11})<\/b>/, '$1'),
      (html: string) => withRows(html, (rows) => `${rows}${row('2026-02-30', '예시', '영업소도착')}`),
      (html: string) => withRows(html, (rows) => `${rows}${row('2026.10.14', '예시', '영업소도착')}`),
      (html: string) => withRows(html, (rows) => `${rows}${row('2026-10-14 09:00', '예시', '영업소도착')}`),
      (html: string) => withRows(html, (rows) => `${rows}${row('2026-10-14', '예시', '')}`),
      (html: string) => withRows(html, (rows) => `${rows}<tr><td>2026-10-14</td><td>예시</td><td>영업소도착</td></tr>`),
      (html: string) => withRows(html, (rows) => `${rows}${row('2026-10-14', '예시', '영업소도착').repeat(500)}`),
      (html: string) => `${html}<table><tr><td>결과가 없습니다.</td></tr></table>`,
    ]) {
      expect(() => parseChunil(change(fixture('in-transit')), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const html of ['', '<html><body>천일택배</body></html>', fixture('not-found').replace('결과가 없습니다.', '')]) {
      expect(() => parseChunil(html, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads a page its server labels EUC-KR', async () => {
    // "결과가 없습니다." in EUC-KR.
    const missing = Buffer.from('b0e1b0fab0a120bef8bdc0b4cfb4d92e', 'hex');
    const body = Buffer.concat([Buffer.from(`<input id="transNo" value="${UNKNOWN}"><table><tr><td>`), missing,
      Buffer.from('</td></tr></table>')]);
    await expect(carrier(answering(() => reply(new Uint8Array(body), { headers: { 'Content-Type': 'text/html; charset=EUC-KR' } })))
      .track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(answering(() => reply(new Uint8Array(body)))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('keeps an unknown number, a moved route, a browser check and a broken page apart', async () => {
    const lookup = (respond: () => Response) => carrier(answering(respond)).track({ number: UNKNOWN });
    await expect(carrier(page('not-found')).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(() => reply('<html><title>404 Not Found</title></html>', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 410 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 302, headers: { Location: 'https://www.chunil.co.kr/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply(CHALLENGE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply('<html><title>Chunil</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = answering(() => reply('<html><body>Error</body></html>', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the empty answer, and asks nothing for a number Chunil does not issue', async () => {
    // A day alone dates the last activity without an instant.
    await expect(carrier(page('delivered')).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-04T00:00:00' });
    await expect(carrier(page('not-found')).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(answering(() => reply(CHALLENGE))).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    // A page for another parcel is no answer either way.
    await expect(carrier(page('delivered')).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind: 'indeterminate' });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('2000000001')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects numbers Chunil does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '2000000001', '200000000111', '2000000001A', 'A2000000001', '20000000011.5', `${DELIVERED}${'9'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    for (const raw of ['2000 0000 011', '200-0000-0011', ' 20000000011 ']) expect(normalizeChunilNumber(raw), raw).toBe(DELIVERED);
  });

  it('tries a read that hangs once more, and ends inside the budget', async () => {
    fakeBudgetClock();
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: 50, reply: () => reply(fixture('in-transit')) }]);
    const answered = carrier(recovered.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answered).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(recovered.fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry within the rest.
    expect(recovered.ended).toEqual([200, 250]);
    const started = performance.now();
    const hanging = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(hanging.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(hanging.fetcher).toHaveBeenCalledTimes(2);
    expect(hanging.ended.map((at) => at - started)).toEqual([60, 120]);
  });

  it('routes a number the caller names Chunil’s to the adapter', async () => {
    const fetcher = page('delivered');
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'chunil' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'chunil', source: 'chunil', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === chunilTraceUrl(DELIVERED))).toBe(true);
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(metadata.tracking).toMatchObject({ adapter: 'chunil', steps: ['direct', 'retry'], recognition: { rank: 621 }, localClocks: true });
  });
});

describe('Chunil Express numbers', () => {
  it('leaves eleven digits to the caller’s choice, and reads tracker links', () => {
    // Other carriers print eleven digits too, so neither detection nor recognition offers Chunil.
    expect(detectCarrierMatch(DELIVERED).carrier).not.toBe('chunil');
    expect(recognitionAskedCarriers(DELIVERED)).not.toContain('chunil');
    for (const link of [`https://www.chunil.co.kr/HTrace/HTrace.jsp?transNo=${DELIVERED}`, `http://chunil.co.kr/HTrace/HTrace.jsp?transNo=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'chunil', source: 'link' });
    }
  });
});

describe('Chunil Express status vocabulary', () => {
  it('records every label the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(chunilStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'chunil', providerCode: null, description: '배송완료' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'chunil', providerCode: null, description: '샘플상태' })).toEqual({ kind: 'unknown' });
    // Spacing inside a label does not change it.
    expect(chunilStage('발송터미널 하차')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    // A label the map does not know falls to the shared rules, else stays without a stage.
    expect(chunilStage('Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(chunilStage('샘플상태')).toBeNull();
  });
});
