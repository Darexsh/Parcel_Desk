import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, MADHUR_TRACKER, MadhurCourierTracker } from './adapter.js';
import { madhurSearchFields, madhurSessionUrl, normalizeMadhurNumber, parseMadhurCourier } from './parser.js';
import { madhurMappedStage, madhurStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'P123456789';
const IN_TRANSIT = '1234067891';
const UNKNOWN = '0000000000';
const SESSION = '/(S(abcdefghijklmnopqrstuvwx))/CNoteTracking';
const SESSION_URL = `https://madhurcouriers.in${SESSION}`;
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const moved = (location: string, status = 302) => new Response(null, { status, headers: { Location: location } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** The tracker's three replies: the redirect to a session, its form, and the answer to the posted C-Note. */
const flow = (answer: Response) => vi.fn<typeof fetch>().mockResolvedValueOnce(moved(SESSION)).mockResolvedValueOnce(reply(page('form')))
  .mockResolvedValueOnce(answer);
const rows = (result: ReturnType<typeof parseMadhurCourier>) =>
  result.events!.map(event => [event.local_time, event.location ?? null, event.provider_code, event.description, event.stage ?? null]);
// The sender, the consignee and their address, the receiver, the delivery staff and their phone, and the pieces.
const PRIVATE = /SAMPLE (?:SENDER|RECEIVER|STAFF|RIDER)|EXAMPLE (?:ROAD|COLONY)|0000000000|Consignor|Consignee|Mobile|Pcs/i;
const GRID = /<table class="table[\s\S]*?<\/table>/;
const ROW = /<tr>\s*<td>[\s\S]*?<\/tr>/g;

describe('Madhur Courier tracking adapter', () => {
  it('opens the tracker’s session page and posts the whole C-Note back as its search button does', async () => {
    const fetcher = flow(reply(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new MadhurCourierTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` p1234 56789 `, { budgetMs: 1000.5 })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const [[entry, entryInit], [form, formInit], [post, postInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit], [string, RequestInit]];
    expect([entry, form, post]).toEqual([MADHUR_TRACKER, SESSION_URL, SESSION_URL]);
    for (const init of [entryInit, formInit, postInit]) {
      expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({ 'User-Agent': 'SyntheticHost/1.0' }) });
      expect(new Headers(init.headers).has('cookie')).toBe(false);
    }
    expect([entryInit.method, formInit.method, postInit.method]).toEqual(['GET', 'GET', 'POST']);
    expect(postInit.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded', Referer: SESSION_URL });
    expect(Object.fromEntries(new URLSearchParams(String(postInit.body)))).toEqual({
      __EVENTTARGET: '', __EVENTARGUMENT: '', __VIEWSTATE: expect.stringMatching(/^SYNTHETICVIEWSTATE/), __VIEWSTATEGENERATOR: '00000000',
      __SCROLLPOSITIONX: '0', __SCROLLPOSITIONY: '0', __EVENTVALIDATION: expect.stringMatching(/^SYNTHETICEVENTVALIDATION/),
      ctl00$ContentPlaceHolder1$hdPageNo: '0', ctl00$ContentPlaceHolder1$hdTotalPages: '0',
      ctl00$ContentPlaceHolder1$a: 'rdoCNote', ctl00$ContentPlaceHolder1$txtCNote: DELIVERED, ctl00$ContentPlaceHolder1$btnSearch: 'Track CNote',
    });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'madhur-courier', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history newest first by its days and drops every name, address and phone', () => {
    const result = parseMadhurCourier(page('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'DELIVERED', last_update: null, last_update_local: '2026-10-09', expected_delivery: null });
    expect(rows(result)).toEqual([
      // The receiver, the area and the delivery staff after the delivery's wording are dropped.
      ['2026-10-09', 'TESTABAD', 'RUNSHEET UPDATE', 'DELIVERED', 'delivered'],
      // The out-for-delivery row names the staff and their phone, so it keeps its transaction type.
      ['2026-10-09', 'TESTABAD', 'OUT FOR DELIVERY', 'OUT FOR DELIVERY', 'out_for_delivery'],
      ['2026-10-08', 'TESTABAD', 'PARCEL RECEIVED', 'RECEIVED IN TESTABAD FROM EXAMPLEGANJ FOR TESTABAD Location', 'in_transit'],
      ['2026-10-07', 'EXAMPLEGANJ', 'PARCEL DISPATCH', 'Forwarded FROM EXAMPLEGANJ TO TESTABAD for TESTABAD Location By Surface', 'in_transit'],
      ['2026-10-07', 'EXAMPLEGANJ', 'PARCEL RECEIVED', 'RECEIVED IN EXAMPLEGANJ FROM SAMPLEPUR FOR TESTABAD Location', 'in_transit'],
      ['2026-10-05', 'SAMPLEPUR', 'BAG FORWARD', 'BAG FORWARDED BY SAMPLEPUR TO EXAMPLEGANJ', 'in_transit'],
      ['2026-10-05', 'SAMPLEPUR', 'PARCEL DISPATCH', 'Forwarded FROM SAMPLEPUR TO EXAMPLEGANJ for TESTABAD Location By Surface', 'in_transit'],
      // The consignor, the consignee with their address and the pieces after the booking's route are dropped.
      ['2026-10-05', 'SAMPLEPUR', 'BOOKING', 'PARCEL BOOKED BY SAMPLEPUR FROM SAMPLEPUR TO TESTABAD', 'accepted'],
    ]);
    // A day is no instant, so neither the delivery nor any row has one.
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.every((event) => !('time' in event))).toBe(true);
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', IN_TRANSIT]] as const) {
      expect(JSON.stringify(parseMadhurCourier(page(name), number)), name).not.toMatch(PRIVATE);
    }
  });

  it('follows the newest staged row of a consignment on its way', () => {
    const result = parseMadhurCourier(page('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Forwarded FROM EXAMPLEGANJ TO TESTABAD for TESTABAD Location By Surface', last_update_local: '2026-10-14' });
    expect(rows(result)).toEqual([
      ['2026-10-14', 'EXAMPLEGANJ', 'PARCEL DISPATCH', 'Forwarded FROM EXAMPLEGANJ TO TESTABAD for TESTABAD Location By Surface', 'in_transit'],
      ['2026-10-13', 'EXAMPLEGANJ', 'PARCEL RECEIVED', 'RECEIVED IN EXAMPLEGANJ FROM SAMPLEPUR FOR TESTABAD Location', 'in_transit'],
      ['2026-10-12', 'SAMPLEPUR', 'DOCUMENT OUT', 'READY TO DISPATCH FROM SAMPLEPUR TO EXAMPLEGANJ', 'in_transit'],
      ['2026-10-12', 'SAMPLEPUR', 'BOOKING', 'DOCUMENT BOOKED BY SAMPLEPUR FROM SAMPLEPUR TO TESTABAD', 'accepted'],
    ]);
    const body = page('in-transit');
    const listed = GRID.exec(body)![0].match(ROW)!;
    // A row the tracker repeats appears once, and rows out of order are put in order by their days.
    const reordered = body.replace(GRID, (grid) => grid.replace(listed.join(''), [listed[3], listed[0], listed[1], listed[2], listed[3]].join('')));
    expect(parseMadhurCourier(reordered, IN_TRANSIT).events).toEqual(result.events);
    // A transaction type and wording neither the map nor the shared rules know stays without a stage, and the newest staged row decides.
    const unknown = body.replace(listed[3]!, listed[3]!.replace(' PARCEL DISPATCH', 'SCAN').replace(/Forwarded FROM[^<]*/, 'SCANNED AT EXAMPLEGANJ'));
    const read = parseMadhurCourier(unknown, IN_TRANSIT);
    expect(read).toMatchObject({ status: 'in_transit', last_status_text: 'RECEIVED IN EXAMPLEGANJ FROM SAMPLEPUR FOR TESTABAD Location' });
    expect(read.events![0]).toMatchObject({ provider_code: 'SCAN', description: 'SCANNED AT EXAMPLEGANJ' });
    expect(read.events![0]).not.toHaveProperty('stage');
  });

  it('keeps a delivery sheet’s other outcomes to the shared rules, without the names they give', () => {
    const delivered = page('delivered');
    const sheet = (wording: string) => parseMadhurCourier(delivered.replace(/DELIVERED TO SAMPLE RECEIVER[^<]*/, wording), DELIVERED);
    const missed = sheet('UNDELIVERED BY SAMPLE RIDER Mobile No:0000000000');
    expect(missed.events![0]).toMatchObject({ provider_code: 'RUNSHEET UPDATE', description: 'UNDELIVERED' });
    expect(missed.events![0]!.stage).not.toBe('delivered');
    expect(missed.current_stage).not.toBe('delivered');
    expect(sheet('Pcs:2').events![0]).toMatchObject({ description: 'RUNSHEET UPDATE' });
    expect(sheet('Pcs:2').events![0]).not.toHaveProperty('stage');
    // A delivery named under another transaction type keeps only its opening word too.
    const other = parseMadhurCourier(delivered.replace('RUNSHEET UPDATE', 'POD ENTRY'), DELIVERED);
    expect(other.events![0]).toMatchObject({ provider_code: 'POD ENTRY', description: 'DELIVERED', stage: 'delivered', stage_source: 'wording:language' });
    expect(JSON.stringify(missed)).not.toMatch(PRIVATE);
  });

  it('binds the answer to the C-Note in the form’s field and to one booking', () => {
    const delivered = page('delivered');
    for (const html of [
      delivered.replace(`value="${DELIVERED}"`, `value="${IN_TRANSIT}"`),
      delivered.replace(`value="${DELIVERED}"`, `value="${DELIVERED}${','.repeat(60)}${IN_TRANSIT}"`),
      delivered.replace(`value="${DELIVERED}" `, ''),
      // The answer to a reference lookup.
      delivered.replace('value="rdoCNote" checked="checked"', 'value="rdoCNote"').replace('value="rdoRefNO"', 'value="rdoRefNO" checked="checked"'),
      // Two bookings under the number.
      delivered.replace(GRID, (grid) => grid.replace(/<\/table>$/, `${grid.match(ROW)![0]}</table>`)),
      // The tracker's own page, as it opens before a search.
      page('form'),
    ]) {
      expect(() => parseMadhurCourier(html, DELIVERED), html.length.toString()).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseMadhurCourier(delivered, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseMadhurCourier(delivered.replace(`value="${DELIVERED}"`, `value="${DELIVERED.toLowerCase()}"`), DELIVERED).status).toBe('delivered');
  });

  it('reads only the tracker’s empty answer for the C-Note in its field as a missing consignment', () => {
    expect(() => parseMadhurCourier(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseMadhurCourier(page('not-found'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const empty = /<div>\s*<\/div>/;
    for (const html of [
      page('not-found').replace(empty, '<div><span>Server busy</span></div>'),
      page('not-found').replace('id="ContentPlaceHolder1_Panel1"', 'id="ContentPlaceHolder1_Panel2"'),
    ]) {
      expect(() => parseMadhurCourier(html, UNKNOWN), html.length.toString()).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const html of ['<html><head><title>Access Denied</title></head><body>Blocked</body></html>',
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      '<html><body><div class="g-recaptcha" data-sitekey="SYNTHETIC"></div></body></html>']) {
      expect(() => parseMadhurCourier(html, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'challenge' }));
      expect(() => madhurSearchFields(html, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('rejects answers it cannot read as malformed', () => {
    const delivered = page('delivered');
    const grid = GRID.exec(delivered)![0];
    for (const html of ['<html><body>Maintenance</body></html>',
      delivered.replace('id="form1"', 'id="form2"'),
      delivered.replace('<th scope="col">Remark</th>', '<th scope="col">Note</th>'),
      delivered.replace(grid, grid.replace(ROW, '')),
      delivered.replace(grid, `${grid}${grid}`),
      delivered.replace('05-Oct-2026', '2026-10-05'),
      delivered.replace('05-Oct-2026', '31-Sep-2026'),
      delivered.replace('05-Oct-2026', '05-Foo-2026'),
      delivered.replace(/<td>\s*<span id="ContentPlaceHolder1_gvBookings_lblRemark_0"><\/span>\s*<\/td>/, ''),
      delivered.replace('>BAG FORWARD<', '> <'),
      delivered.replace(grid, grid.replace(/<\/table>$/, `${grid.match(ROW)![1]!.repeat(300)}</table>`))]) {
      expect(() => parseMadhurCourier(html, DELIVERED), html.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('posts the form’s own state and refuses a form without it', () => {
    const fields = madhurSearchFields(page('form'), IN_TRANSIT);
    expect(fields.get('ctl00$ContentPlaceHolder1$txtCNote')).toBe(IN_TRANSIT);
    expect(fields.get('ctl00$ContentPlaceHolder1$a')).toBe('rdoCNote');
    expect(fields.has('ctl00$ContentPlaceHolder1$btnPrev')).toBe(false);
    for (const html of [page('form').replace(/name="__VIEWSTATE" id="__VIEWSTATE" value="[^"]*"/, 'name="__VIEWSTATE" id="__VIEWSTATE" value=""'),
      page('form').replace(/<input type="hidden" name="__EVENTVALIDATION"[^>]*>/, ''),
      page('form').replace('type="submit" name="ctl00$ContentPlaceHolder1$btnSearch"', 'type="button" name="search"'),
      page('form').replace('value="rdoCNote"', 'value="rdoDocket"')]) {
      expect(() => madhurSearchFields(html, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('follows the redirect only to the tracker’s own session page', async () => {
    expect(madhurSessionUrl(SESSION)).toBe(SESSION_URL);
    for (const location of [null, '', '/CNoteTracking', '/(S(short))/CNoteTracking', `${SESSION}?x=1`, `https://example.com${SESSION}`,
      '/(S(abcdefghijklmnopqrstuvwx))/Login', 'http://[']) {
      expect(() => madhurSessionUrl(location), String(location)).toThrow(expect.objectContaining({ kind: 'transport' }));
    }
    const elsewhere = vi.fn<typeof fetch>().mockResolvedValue(moved('https://example.com/'));
    await expect(carrier(elsewhere).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'transport' });
    expect(elsewhere).toHaveBeenCalledTimes(1);
    // A tracker that serves its form without a session posts it back to the same address.
    const plain = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('form'))).mockResolvedValueOnce(reply(page('in-transit')));
    await expect(carrier(plain).track({ number: IN_TRANSIT })).resolves.toMatchObject({ status: 'in_transit' });
    expect(plain.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([[MADHUR_TRACKER, 'GET'], [MADHUR_TRACKER, 'POST']]);
    // The session page or the answer moving elsewhere is a moved route.
    for (const fetcher of [vi.fn<typeof fetch>().mockResolvedValueOnce(moved(SESSION)).mockResolvedValueOnce(moved('/Error')),
      flow(moved(SESSION))]) {
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'transport' });
    }
  });

  it('takes C-Note numbers and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['123456789', '123456789012', 'P12345678', 'P1234567890', 'X123456789', 'PP12345678', 'REF-SAMPLE', `${DELIVERED},${IN_TRANSIT}`, '1'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeMadhurNumber('p 123-456-789')).toBe(DELIVERED);
    expect(normalizeMadhurNumber('00000000000')).toBe('00000000000');
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s on the session page and on the answer, without a retry', async (status, kind) => {
      const failing = (body: string) => reply(status === 500 ? '' : body, status);
      const entry = vi.fn<typeof fetch>().mockImplementation(async () => failing(page('form')));
      await expect(carrier(entry).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
      expect(entry).toHaveBeenCalledTimes(1);
      const answer = flow(failing(page('not-found')));
      await expect(carrier(answer).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
      expect(answer).toHaveBeenCalledTimes(3);
    });

  it('keeps empty pages and oversized replies apart from missing consignments', async () => {
    for (const [body, kind] of [['', 'indeterminate'], ['  ', 'indeterminate'], ['{"status":"Delivered"}', 'schema']] as const) {
      await expect(carrier(flow(reply(body))).track({ number: UNKNOWN }), body).rejects.toMatchObject({ kind });
    }
    const large = flow(new Response(new Uint8Array(1024 * 1024 + 1)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockResolvedValueOnce(moved(SESSION)).mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(moved(SESSION)).mockResolvedValueOnce(reply(page('form'))).mockResolvedValueOnce(reply(page('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(5);
    const immediate = flow(reply(page('delivered')));
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

  it('routes a C-Note filed under Madhur Courier to the adapter', async () => {
    const fetcher = flow(reply(page('in-transit')));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: IN_TRANSIT, carrier: 'madhur-courier' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'madhur-courier', source: 'madhur-courier', result: { current_stage: 'in_transit' },
      attempts: [{ source: 'madhur-courier', kind: 'ok' }] });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe('Madhur Courier numbers', () => {
  it('leaves C-Note numbers unclaimed', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN, '00000000000']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('madhur-courier');
    }
  });
});

describe('Madhur Courier status vocabulary', () => {
  it('records every transaction type the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(madhurMappedStage(entry.code, entry.wording), entry.code).toBe(entry.stage);
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
    }
    expect(madhurMappedStage(' parcel   dispatch ', '')).toBe('in_transit');
    for (const [code, wording] of [['RUNSHEET UPDATE', 'UNDELIVERED'], ['RUNSHEET UPDATE', 'NOT DELIVERED'], ['RUNSHEET UPDATE', ''],
      ['constructor', ''], ['toString', ''], ['PARCEL', ''], ['BOOKING CANCELLED', '']] as const) {
      expect(madhurMappedStage(code, wording), `${code} ${wording}`).toBeUndefined();
    }
    expect(statusMap.stage(null, 'delivered')).toBeUndefined();
    // Other transaction types go to the shared rules, and wording they do not know either stays without a stage.
    expect(madhurStage('PARCEL RECEIVED', 'RECEIVED IN SAMPLEPUR')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(madhurStage('POD ENTRY', 'DELIVERED')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(madhurStage('SCAN', 'SCANNED AT SAMPLEPUR')).toBeNull();
    expect(statusMapAnswer({ carrier: 'madhur-courier', providerCode: 'BOOKING', description: 'PARCEL BOOKED BY SAMPLEPUR' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
  });
});
