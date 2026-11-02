import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { ACI_EXPRESS_KR_COURIER, ACI_EXPRESS_KR_TRACKER, aciExpressKrCourierUrl, aciExpressKrTrackerUrl, AciExpressKrTracker, adapter } from './adapter.js';
import { normalizeAciExpressKrNumber, parseAciExpressKr } from './parser.js';
import { aciExpressKrStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '6069999000013';
const IN_TRANSIT = '6069999000024';
const CJ = '599999000035';
const UNKNOWN = '600000000000';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: BodyInit, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
// The courier lookup's whole answer for a number it has no shipment for.
const courierMiss = (number: string) => `\n\t<script language="javascript">\n\t<!--\n\t\tlocation.href='http://www.acieshop.com/pod.php?OrderNo=${number}';\n\t//-->\n\t</script>`;
// The tracking page answers from its fixture, the courier lookup with its miss unless told otherwise.
const site = (tracker: () => Response, courier: () => Response = () => reply(courierMiss(UNKNOWN))) => vi.fn<typeof fetch>()
  .mockImplementation(async (url) => String(url).startsWith(ACI_EXPRESS_KR_COURIER) ? courier() : tracker());
const page = (name: string) => site(() => reply(fixture(name)));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// Cloudflare's managed challenge, as it could stand in place of either page.
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:"managed"};</script></body></html>';
// A row of ACI's own table and one of the delivering carrier's, as the page writes them.
const aciRow = (date: string, time: string, area: string, detail: string) =>
  `\t\t\t<tr bgcolor=#FFFFFF>\n\t\t\t\t<td height=22  align=center>${date} </td>\n\t\t\t\t<td  align=center>${time} </td>\n\t\t\t\t<td  align=center>${area} &nbsp;</td>\n\t\t\t\t<td  align=center>${detail}</td>\n\t\t\t</tr>\n`;
const postRow = (...cells: string[]) => `<tr bgcolor="#ffffff">${cells.map((cell) => `<td  height="30" align="center">${cell}</td>`).join('')}</tr>\n`;
const afterAciRows = (html: string, rows: string) => html.replace(/(\t\t<\/table>\n\t\t<div align=center>)/, `${rows}$1`);
const beforeReceiver = (html: string, rows: string) => html.replace(/(\s*<tr bgcolor="#ffffff">\s*<td colspan=5)/, `${rows}$1`);
const events = (result: ReturnType<typeof parseAciExpressKr>) => result.events!.map((event) => [event.local_time,
  event.description, event.stage ?? null, event.location ?? null]);

describe('ACI Express HTTP adapter', () => {
  it('opens the tracking page for the whole number, once, through the supplied transport', async () => {
    const fetcher = page('delivered');
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new AciExpressKrTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 6069-9990-00013 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${ACI_EXPRESS_KR_TRACKER}?OrderNo=${DELIVERED}`);
    expect(aciExpressKrTrackerUrl(` ${CJ} `)).toBe(`https://www.acieshop.com/pod.php?OrderNo=${CJ}`);
    expect(aciExpressKrCourierUrl('5999 9900 0035')).toBe(`https://133.acieshop.com/webpod.php?HawbNo=${CJ}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'aci-express-kr', step: 'direct', outcome: 'ok' }));
  });

  it('reads ACI’s milestones then Korea Post’s scans on each site’s own clock, and hands the parcel to Korea Post under its number', () => {
    const result = parseAciExpressKr(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'DELIVERED TO CNEE', last_update: null, last_update_local: '2026-03-05T11:34:00',
      expected_delivery: null, delivery_carrier: 'korea-post', delivery_tracking_number: DELIVERED,
    });
    // The repeated arrival at the sorting centre is kept once, and a pickup without a time keeps its day.
    expect(events(result)).toEqual([
      ['2026-03-05T11:34:00', 'DELIVERED TO CNEE', 'delivered', '샘플우체국'],
      ['2026-03-05T08:10:00', 'HANDED OVER TO POST MAN', 'out_for_delivery', '샘플우체국'],
      ['2026-03-05T02:47:00', 'ARR. AT DEPOT', 'in_transit', '샘플우편집중국'],
      ['2026-03-04T16:02:00', 'MOVE TO DEPOT', 'in_transit', '예시공항(화물터미널)'],
      ['2026-03-04T15:20:00', 'HANDED OVER TO KP', 'in_transit', '예시우편물류센터'],
      ['2026-03-04T13:05:00', 'Customs clearance is completed in the Republic of Korea', 'in_transit', '인천공항'],
      ['2026-03-04T06:15:00', 'Shipped the goods arrived at Incheon International Airport.', 'in_transit', '인천공항'],
      ['2026-03-02T21:40:00', 'Shipment departed to Incheon International Airport', 'in_transit', '샘플시'],
      ['2026-03-02', 'Shipment pick up and waiting at the origin airport', 'accepted', '샘플시'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    for (const field of ['delivered_at', 'history_truncated', 'summary_only', 'origin_country', 'destination_country']) {
      expect(result).not.toHaveProperty(field);
    }
    // Neither the recipient's masked name, the postman nor who took the parcel is kept.
    expect(JSON.stringify(result)).not.toMatch(/홍\*동|김예시|수령인|집배원|본인|배달|EPOST/);
    expect(deliveryHandoff('aci-express-kr', DELIVERED, result)).toEqual({ carrier: 'korea-post', number: DELIVERED, basis: 'partner' });
  });

  it('reads CJ Logistics’ Korean scans without the driver its branch names, and names no carrier it cannot follow', () => {
    const result = parseAciExpressKr(fixture('delivered-cj'), CJ);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '배송완료', last_update_local: '2026-07-23T15:47:26',
    });
    // The bonded warehouse's row without wording is no scan.
    expect(events(result)).toEqual([
      ['2026-07-23T15:47:26', '배송완료', 'delivered', '경기예시동'],
      ['2026-07-23T12:15:02', '배송출발', 'out_for_delivery', '경기예시동'],
      ['2026-07-23T07:58:40', '간선하차', 'in_transit', '예시B'],
      ['2026-07-22T19:20:05', '간선상차', 'in_transit', '샘플HUB'],
      ['2026-07-22T18:44:51', '간선하차', 'in_transit', '샘플HUB'],
      ['2026-07-22T14:02:30', '집하처리', 'in_transit', '글로벌직구팀직영'],
      ['2026-07-22T10:12:00', 'Customs clearance is completed in the Republic of Korea', 'in_transit', '인천공항'],
      ['2026-07-21T08:05:00', 'Shipped the goods arrived at Incheon International Airport.', 'in_transit', '인천공항'],
      ['2026-07-20T09:30:00', 'Shipment departed to Incheon International Airport', 'in_transit', null],
      ['2026-07-20', 'Shipment pick up and waiting at the origin airport', 'accepted', null],
    ]);
    // CJ Logistics' rules take no ACI number, so the parcel is not handed to it.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(JSON.stringify(result)).not.toMatch(/박샘플|홍길|수령인|예시장치장센터|CJNEW/);
  });

  it('reads a parcel Korea Post has not scanned yet, and hands it over all the same', () => {
    const result = parseAciExpressKr(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Shipped the goods arrived at Incheon International Airport.', last_update_local: '2026-05-13T06:40:00',
      delivery_carrier: 'korea-post', delivery_tracking_number: IN_TRANSIT,
    });
    expect(events(result)).toEqual([
      ['2026-05-13T06:40:00', 'Shipped the goods arrived at Incheon International Airport.', 'in_transit', '인천공항'],
      ['2026-05-12T23:50:00', 'Shipment departed to Incheon International Airport', 'in_transit', null],
      ['2026-05-11', 'Shipment pick up and waiting at the origin airport', 'accepted', null],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/홍\*동|수령인|님/);
  });

  it('keeps the page’s order over clocks from different places, and wording it does not know', () => {
    // Customs at Incheon reads earlier than the arrival logged on the origin's clock.
    const early = parseAciExpressKr(fixture('delivered').replace('13:05 ', '05:10 '), DELIVERED);
    expect(events(early).slice(5, 7)).toEqual([
      ['2026-03-04T05:10:00', 'Customs clearance is completed in the Republic of Korea', 'in_transit', '인천공항'],
      ['2026-03-04T06:15:00', 'Shipped the goods arrived at Incheon International Airport.', 'in_transit', '인천공항'],
    ]);
    const added = parseAciExpressKr(afterAciRows(fixture('in-transit'),
      aciRow('2026년 05월 13일', '09:00', '인천공항', '샘플 상태입니다.<br><font color=\'#595655\'>Sample status</font>')), IN_TRANSIT);
    expect(added.events![0]).toEqual({ local_time: '2026-05-13T09:00:00', location: '인천공항', description: 'Sample status' });
    expect(added).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Sample status', last_update_local: '2026-05-13T09:00:00' });
    // A status without an English line is read as it stands, by the shared rules when the map does not know it.
    const korean = parseAciExpressKr(beforeReceiver(fixture('in-transit'), postRow('2026.05.14', '10:00', '샘플우체국', 'Delivered', '&nbsp;')), IN_TRANSIT);
    expect(korean.events![0]).toEqual({ local_time: '2026-05-14T10:00:00', location: '샘플우체국', description: 'Delivered', stage: 'delivered', stage_source: 'wording:language' });
    expect(korean).toMatchObject({ status: 'delivered', current_stage_source: 'wording:language' });
    expect(() => parseAciExpressKr(fixture('in-transit').replace(/<tr bgcolor=#FFFFFF>[\s\S]*?<\/tr>/g, ''), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads the page without a number as not found, and a parcel only when the page names the number asked', () => {
    expect(() => parseAciExpressKr(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseAciExpressKr(fixture('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'ACI Express answered for another number' }));
    expect(() => parseAciExpressKr(fixture('delivered-cj'), `${CJ.slice(0, -1)}6`))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'ACI Express answered for another number' }));
  });

  it('rejects a changed page', () => {
    for (const change of [
      (html: string) => html.replace('>Tracking Number<', '>Number<'),
      (html: string) => html.replace(/(<table {2}class='htmltable')/, "<table class='htmltable'><tr><td>Tracking Number</td><td>X</td></tr></table>$1"),
      (html: string) => html.replace(`<b>${DELIVERED}`, '<b>'),
      (html: string) => html.replace('>Detail<', '>Status<'),
      (html: string) => html.replace('<strong>처리현황</strong>', '<strong>상태</strong>'),
      (html: string) => html.replace(/(<\/table>\s*<div align=center>)/, "$1<table class='htmltable'><tr><td>Date</td><td>Time</td><td>Area</td><td>Detail</td></tr></table>"),
      (html: string) => html.replace('2026년 03월 02일', '2026년 02월 30일'),
      (html: string) => html.replace('2026년 03월 02일', '2026-03-02'),
      (html: string) => html.replace('21:40 ', '24:00 '),
      (html: string) => html.replace('21:40 ', '9:40 '),
      (html: string) => html.replace('2026.03.04', '2026/03/04'),
      (html: string) => html.replace('<td  height="30" align="center">15:20</td>', '<td  height="30" align="center">15h20</td>'),
      (html: string) => afterAciRows(html, aciRow('2026년 03월 04일', '13:30', '인천공항', '')),
      (html: string) => afterAciRows(html, '<tr><td>2026년 03월 04일</td><td>13:30</td><td>Sample status</td></tr>'),
      (html: string) => beforeReceiver(html, '<tr bgcolor="#ffffff"><td>2026.03.05</td><td>12:00</td><td>배달완료</td></tr>'),
      (html: string) => afterAciRows(html, aciRow('2026년 03월 04일', '13:30', '인천공항', 'Sample status').repeat(500)),
    ]) {
      expect(() => parseAciExpressKr(change(fixture('delivered')), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const html of ['', '<html><body>ACIEXPRESS</body></html>', fixture('not-found').replace('>Tracking Number<', '>Order<'),
      fixture('not-found').replace('</table>\n</table>', "<table class='htmltable'><tr><td>Sample</td></tr></table></table>\n</table>")]) {
      expect(() => parseAciExpressKr(html, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('asks the courier lookup about a number the tracking page does not know, and reads only its empty answer as not found', async () => {
    const unknown = site(() => reply(fixture('not-found')));
    await expect(carrier(unknown).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(unknown.mock.calls.map(([url]) => String(url))).toEqual([aciExpressKrTrackerUrl(UNKNOWN), aciExpressKrCourierUrl(UNKNOWN)]);
    expect(unknown.mock.calls[1]![1]).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) });
    const courier = (respond: () => Response) => carrier(site(() => reply(fixture('not-found')), respond)).track({ number: UNKNOWN });
    await expect(courier(() => reply(courierMiss(UNKNOWN).replace('http:', 'https:')))).rejects.toMatchObject({ kind: 'not_found' });
    // An answer for another number, or a shipment the adapter does not read, is no answer either way.
    await expect(courier(() => reply(courierMiss(CJ)))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(courier(() => reply(`<html><body><table><tr><td>${UNKNOWN}</td><td>Sample status</td></tr></table></body></html>`)))
      .rejects.toMatchObject({ kind: 'indeterminate', message: 'ACI Express has a courier shipment under this number, which the adapter does not read' });
    await expect(courier(() => reply(`${courierMiss(UNKNOWN)}<p>Sample</p>`))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(courier(() => reply(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(courier(() => reply(CHALLENGE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(courier(() => reply('', { status: 302, headers: { Location: '/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(courier(() => reply('', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('keeps a moved route, a browser check and a broken page apart', async () => {
    const lookup = (respond: () => Response) => carrier(site(respond)).track({ number: DELIVERED });
    await expect(lookup(() => reply('', { status: 302, headers: { Location: 'https://www.aciexpress.net/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('<html><title>404 Not Found</title></html>', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 410 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply(CHALLENGE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply('<html><title>ACIEXPRESS</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = site(() => reply('<html><body>Error</body></html>', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the empty answers, and asks nothing for a number it does not send', async () => {
    await expect(carrier(page('delivered')).recognize!(DELIVERED)).resolves.toMatchObject({ known: true });
    await expect(carrier(page('not-found')).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(site(() => reply(fixture('not-found')), () => reply('<html><body>Sample</body></html>'))).recognize!(UNKNOWN))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(site(() => reply(CHALLENGE))).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    // A page for another parcel is no answer either way.
    await expect(carrier(page('delivered')).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind: 'indeterminate' });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('EE123456789KR')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects numbers it does not send and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '60699990000', '60699990000135', 'EE123456789KR', '60699990001A', `${DELIVERED},${CJ}`, `${DELIVERED}${'0'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    for (const raw of [' 6069 9990 00013 ', '6069-9990-00013']) expect(normalizeAciExpressKrNumber(raw), raw).toBe(DELIVERED);
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
    let started = performance.now();
    const hanging = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(hanging.fetcher).track({ number: UNKNOWN }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(hanging.fetcher).toHaveBeenCalledTimes(2);
    expect(hanging.ended.map((at) => at - started)).toEqual([60, 120]);
    // A courier lookup that hangs after the tracking page's miss spends the same budget.
    started = performance.now();
    const missed = { afterMs: 10, reply: () => reply(fixture('not-found')) };
    const slow = delayedFetcher([missed, { afterMs: Infinity }, missed, { afterMs: Infinity }]);
    const courier = expect(carrier(slow.fetcher).track({ number: UNKNOWN }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await courier;
    expect(slow.fetcher.mock.calls.map(([url]) => String(url).startsWith(ACI_EXPRESS_KR_COURIER))).toEqual([false, true, false, true]);
    expect(slow.ended.map((at) => at - started)).toEqual([10, 60, 70, 120]);
  });

  it('routes a number asked of ACI Express to the adapter', async () => {
    const fetcher = page('delivered-cj');
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: CJ, carrier: 'aci-express-kr' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'aci-express-kr', source: 'aci-express-kr', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === aciExpressKrTrackerUrl(CJ))).toBe(true);
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(metadata.tracking).toEqual({ mode: 'automatic', adapter: 'aci-express-kr', steps: ['direct', 'retry'], recognition: { rank: 684 }, localClocks: true });
  });
});

describe('ACI Express numbers', () => {
  it('leaves its numbers to the carriers whose rules claim them, and reads tracker links', () => {
    expect(detectCarrierMatch(DELIVERED).candidates).toContain('korea-post');
    for (const number of [DELIVERED, CJ]) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('aci-express-kr');
      expect(recognitionAskedCarriers(number), number).not.toContain('aci-express-kr');
    }
    for (const [link, number] of [[`https://www.acieshop.com/pod.php?OrderNo=${DELIVERED}`, DELIVERED],
      [`https://acieshop.com/aci_pod/pod.php?BL=${DELIVERED}`, DELIVERED], [`http://www.acieshop.com/pod.html?OrderNo=${DELIVERED}`, DELIVERED],
      [`http://133.acieshop.com/webpod.php?HawbNo=${CJ}`, CJ]] as const) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: number, carrier: 'aci-express-kr', source: 'link' });
    }
  });
});

describe('ACI Express status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMap.stage(null, entry.wording), entry.wording).toBe(entry.stage);
      expect(aciExpressKrStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'aci-express-kr', description: 'Shipment pick up and waiting at the origin airport ' })).toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'aci-express-kr', description: '배달완료' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'aci-express-kr', description: 'Sample status' })).toEqual({ kind: 'unknown' });
    expect(aciExpressKrStage('Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(aciExpressKrStage('Sample status')).toBeNull();
  });
});
