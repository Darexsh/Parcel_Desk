import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, JETLINE_TRACKER, JetlineCouriersTracker } from './adapter.js';
import { jetlineAnswerUrl, jetlineHistoryFields, jetlineSearchFields, normalizeJetlineNumber, parseJetlineCouriers } from './parser.js';
import { jetlineMappedStage, jetlineStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '123456789';
const IN_TRANSIT = '12345679';
const UNKNOWN = '000000000';
const ANSWER = '/track.aspx?trackId=AAAAAAAAAAAAAAAAAAAAAA==';
const ANSWER_URL = `https://www.jetlinecouriers.in${ANSWER}`;
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const moved = (location: string, status = 302) => new Response(null, { status, headers: { Location: location } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** The in-transit parcel's answer page, which the tracker renders like the delivered one's. */
const inTransitSummary = () => page('summary').replace(`>${DELIVERED}<`, `>${IN_TRANSIT}<`);
/** The tracker's four replies: its form, the redirect to the answer page, that page and the history it posts back for. */
const flow = (summary: Response, history?: Response) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('form'))).mockResolvedValueOnce(moved(ANSWER))
    .mockResolvedValueOnce(summary);
  return history ? fetcher.mockResolvedValueOnce(history) : fetcher;
};
const rows = (result: ReturnType<typeof parseJetlineCouriers>) =>
  result.events!.map(event => [event.local_time, event.location ?? null, event.description, event.stage ?? null]);
// The branches' addresses and phones, the summary's status and route, and the proof of delivery.
const PRIVATE = /SAMPLE (?:ROAD|COMPLEX|ENTERPRISES|TRANSPORT)|EXAMPLE (?:MARKET|CHOWK)|0000000000|000-0|SIGN|base64|image\/jpeg/i;
const TIMELINE = /<table class="timeline-grid"[\s\S]*?<\/table>/;
const ROW = /<tr>\s*<td>[\s\S]*?<\/tr>/g;
const GRID_ROW = /<\/tr><tr>[\s\S]*?<\/tr>/;

describe('Jetline Couriers tracking adapter', () => {
  it('posts the whole AWB number from the home page’s form, opens the answer page and posts its history link back', async () => {
    const fetcher = flow(reply(page('summary')), reply(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new JetlineCouriersTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(' 123 456 789 ', { budgetMs: 1000.5 })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(4);
    const calls = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit], [string, RequestInit], [string, RequestInit]];
    expect(calls.map(([url, init]) => [url, init.method])).toEqual([
      [JETLINE_TRACKER, 'GET'], [JETLINE_TRACKER, 'POST'], [ANSWER_URL, 'GET'], [ANSWER_URL, 'POST']]);
    for (const [, init] of calls) {
      expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({ 'User-Agent': 'SyntheticHost/1.0' }) });
      expect(new Headers(init.headers).has('cookie')).toBe(false);
    }
    const [, [, search], [, answer], [, history]] = calls;
    expect(search.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded', Referer: JETLINE_TRACKER });
    expect(Object.fromEntries(new URLSearchParams(String(search.body)))).toEqual({
      __VIEWSTATE: 'SYNTHETICVIEWSTATE0000000000000000', __VIEWSTATEGENERATOR: '00000000',
      __EVENTVALIDATION: 'SYNTHETICEVENTVALIDATION0000000000', txtAwbNo: DELIVERED, btnTrack: 'Track Package',
    });
    expect(answer.headers).toMatchObject({ Referer: JETLINE_TRACKER });
    expect(history.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded', Referer: ANSWER_URL });
    expect(Object.fromEntries(new URLSearchParams(String(history.body)))).toEqual({
      __VIEWSTATE: 'SYNTHETICVIEWSTATE1111111111111111', __VIEWSTATEGENERATOR: '11111111',
      __EVENTVALIDATION: 'SYNTHETICEVENTVALIDATION1111111111', __EVENTTARGET: 'grd1$ctl02$LinkButton1', __EVENTARGUMENT: '',
    });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'jetline-couriers', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history newest first by its days, placing each row in its branch’s city', () => {
    const result = parseJetlineCouriers(page('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'SHIPMENT CURRENT STATUS IS DELIVERED', last_update: null, last_update_local: '2026-10-09', expected_delivery: null });
    expect(rows(result)).toEqual([
      ['2026-10-09', 'TESTABAD', 'SHIPMENT CURRENT STATUS IS DELIVERED', 'delivered'],
      ['2026-10-08', 'TESTABAD', 'SHIPMENT RECEIVED AT TESTABAD IN TSTHUB', 'in_transit'],
      // A dispatch row's badge names the branch it leaves for, so the branch it leaves comes from its wording.
      ['2026-10-07', 'EXAMPLEGANJ', 'SHIPMENT DISPATCH FOR DESTIANTION TESTABAD FROM EXAMPLEGANJ', 'in_transit'],
      ['2026-10-07', 'EXAMPLEGANJ', 'SHIPMENT RECEIVED AT EXAMPLEGANJ IN EXGHUB', 'in_transit'],
      ['2026-10-05', 'SAMPLEPUR', 'SHIPMENT DISPATCH FOR DESTIANTION TESTABAD FROM SAMPLEPUR', 'in_transit'],
      // The booking's wording cuts its branch short; the badge names it whole.
      ['2026-10-05', 'SAMPLEPUR', 'BOOKED AT SAMPLE', 'accepted'],
    ]);
    // A day is no instant, so neither the delivery nor any row has one.
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.every((event) => !('time' in event))).toBe(true);
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', IN_TRANSIT]] as const) {
      expect(JSON.stringify(parseJetlineCouriers(page(name), number)), name).not.toMatch(PRIVATE);
    }
  });

  it('follows the newest staged row of a parcel on its way', () => {
    const result = parseJetlineCouriers(page('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'SHIPMENT RECEIVED AT EXAMPLEGANJ IN', last_update_local: '2026-10-14' });
    expect(rows(result)).toEqual([
      ['2026-10-14', 'EXAMPLEGANJ', 'SHIPMENT RECEIVED AT EXAMPLEGANJ IN', 'in_transit'],
      ['2026-10-13', 'SAMPLEPUR', 'SHIPMENT DISPATCH FOR DESTIANTION TESTABAD FROM SAMPLEPUR', 'in_transit'],
      ['2026-10-12', 'SAMPLEPUR', 'BOOKED AT SAMPLEPUR', 'accepted'],
    ]);
    const body = page('in-transit');
    const listed = TIMELINE.exec(body)![0].match(ROW)!;
    // A row the tracker repeats appears once, and rows out of order are put in order by their days.
    const reordered = body.replace(TIMELINE, (grid) => grid.replace(listed.join(''), [listed[2], listed[0], listed[1], listed[0]].join('')));
    expect(parseJetlineCouriers(reordered, IN_TRANSIT).events).toEqual(result.events);
    // Wording neither the map nor the shared rules know stays without a stage, and the newest staged row decides.
    const unknown = parseJetlineCouriers(body.replace('SHIPMENT RECEIVED AT EXAMPLEGANJ IN ', 'SHIPMENT SCANNED AT EXAMPLEGANJ'), IN_TRANSIT);
    expect(unknown).toMatchObject({ status: 'in_transit', last_status_text: 'SHIPMENT DISPATCH FOR DESTIANTION TESTABAD FROM SAMPLEPUR' });
    expect(unknown.events![0]).toMatchObject({ location: 'EXAMPLEGANJ', description: 'SHIPMENT SCANNED AT EXAMPLEGANJ' });
    expect(unknown.events![0]).not.toHaveProperty('stage');
  });

  it('keeps a delivery run’s other outcomes to the shared rules, without phones or a signatory', () => {
    const delivered = page('delivered');
    const outcome = (wording: string) => parseJetlineCouriers(delivered.replace('SHIPMENT CURRENT STATUS IS DELIVERED', wording), DELIVERED);
    const out = outcome('SHIPMENT CURRENT STATUS IS OUT FOR DELIVERY 0000000000');
    expect(out).toMatchObject({ status: 'out_for_delivery', current_stage_source: 'wording:language' });
    expect(out.events![0]).toMatchObject({ description: 'SHIPMENT CURRENT STATUS IS OUT FOR DELIVERY', stage: 'out_for_delivery' });
    const missed = outcome('SHIPMENT CURRENT STATUS IS UNDELIVERED');
    expect(missed.events![0]!.stage).not.toBe('delivered');
    expect(missed.current_stage).not.toBe('delivered');
    const signed = outcome('SHIPMENT CURRENT STATUS IS DELIVERED SIGN SAMPLE RECEIVER');
    expect(signed).toMatchObject({ status: 'delivered', last_status_text: 'SHIPMENT CURRENT STATUS IS DELIVERED' });
    expect(JSON.stringify([out, missed, signed])).not.toMatch(PRIVATE);
    expect(JSON.stringify(signed)).not.toMatch(/RECEIVER/);
  });

  it('leaves a row without a city it can read unplaced', () => {
    const delivered = page('delivered');
    const placed = (find: string | RegExp, replace: string) => parseJetlineCouriers(delivered.replace(find, replace), DELIVERED).events![0]!;
    expect(placed(/📍 JETLINE COURIERS SHOP[^\n]*/, '📍 JETLINE COURIERS 0000000000')).not.toHaveProperty('location');
    expect(placed(/📍 JETLINE COURIERS SHOP[^\n]*/, '📍 ')).not.toHaveProperty('location');
    expect(placed(/📍 JETLINE COURIERS SHOP[^\n]*/, '📍 SAMPLE ROAD,TESTABAD 000000,0000000000')).not.toHaveProperty('location');
    const dispatch = parseJetlineCouriers(delivered.replace('FOR DESTIANTION TESTABAD FROM EXAMPLEGANJ', 'FOR DESTIANTION TESTABAD'), DELIVERED);
    expect(dispatch.events![2]).toMatchObject({ description: 'SHIPMENT DISPATCH FOR DESTIANTION TESTABAD' });
    expect(dispatch.events![2]).not.toHaveProperty('location');
  });

  it('binds the answer page and the history to the one row for the whole number', () => {
    const summary = page('summary');
    const delivered = page('delivered');
    expect(jetlineHistoryFields(summary.replace(`>${DELIVERED}<`, `> ${DELIVERED.toLowerCase()} <`), DELIVERED).get('__EVENTTARGET'))
      .toBe('grd1$ctl02$LinkButton1');
    for (const [html, number] of [
      [summary, IN_TRANSIT],
      [summary.replace(`>${DELIVERED}<`, `>${DELIVERED}${','.repeat(60)}${IN_TRANSIT}<`), DELIVERED],
      [summary.replace(`>${DELIVERED}<`, '><'), DELIVERED],
      // Two bookings under the number, or another parcel beside it.
      [summary.replace(GRID_ROW, (row) => `${row}${row.slice(5)}`), DELIVERED],
      [summary.replace(GRID_ROW, (row) => `${row}${row.slice(5).replace(DELIVERED, IN_TRANSIT)}`), DELIVERED],
    ] as const) {
      expect(() => jetlineHistoryFields(html, number), html.length.toString()).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseJetlineCouriers(delivered, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseJetlineCouriers(delivered.replace(`>${DELIVERED}<`, `>${IN_TRANSIT}<`), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A browser gets the page with the post back's own event fields, which the history link's post sets.
    const browser = summary.replace('<input type="hidden" name="__VIEWSTATE"',
      '<input type="hidden" name="__EVENTTARGET" id="__EVENTTARGET" value="btnTrack" /><input type="hidden" name="__VIEWSTATE"');
    expect(jetlineHistoryFields(browser, DELIVERED).get('__EVENTTARGET')).toBe('grd1$ctl02$LinkButton1');
  });

  it('reads only the answer page’s missing-record alert as a missing parcel', () => {
    expect(() => jetlineHistoryFields(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const empty = /<div class="table-responsive">\s*<\/div>/;
    for (const html of [
      page('not-found').replace("<script>alert('No Record Available...! ');</script>", ''),
      page('not-found').replace('No Record Available', 'Server busy'),
      page('not-found').replace(empty, '<div class="table-responsive"><span>Server busy</span></div>'),
      page('summary').replace('</form>', "<script>alert('No Record Available...! ');</script></form>"),
    ]) {
      expect(() => jetlineHistoryFields(html, UNKNOWN), html.length.toString()).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // The history post back answering with the alert instead of the parcel is no missing parcel.
    expect(() => parseJetlineCouriers(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const html of ['<html><head><title>Access Denied</title></head><body>Blocked</body></html>',
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      '<html><body><div class="g-recaptcha" data-sitekey="SYNTHETIC"></div></body></html>']) {
      expect(() => jetlineSearchFields(html, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'challenge' }));
      expect(() => jetlineHistoryFields(html, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'challenge' }));
      expect(() => parseJetlineCouriers(html, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('rejects answers it cannot read as malformed', () => {
    const delivered = page('delivered');
    const timeline = TIMELINE.exec(delivered)![0];
    for (const html of ['<html><body>Maintenance</body></html>',
      delivered.replace('id="form1"', 'id="form2"'),
      delivered.replace('<th scope="col">Status Date</th>', '<th scope="col">Updated</th>'),
      delivered.replace(/<td align="center">\s*<a id="grd1_ctl02_LinkButton1"[\s\S]*?<\/td>/, ''),
      delivered.replace('id="grd1"', 'id="grd2"'),
      delivered.replace('id="Panel1"', 'id="Panel4"'),
      delivered.replace(timeline, timeline.replace(ROW, '')),
      delivered.replace('🗓️ 05/10/2026', '🗓️ 2026-10-05'),
      delivered.replace('🗓️ 05/10/2026', '🗓️ 31/09/2026'),
      delivered.replace('<p class="timeline-remarks">BOOKED AT SAMPLE</p>', '<p class="timeline-remarks"> </p>'),
      delivered.replace(timeline, timeline.replace(/<\/table>$/, `${timeline.match(ROW)![1]!.repeat(300)}</table>`))]) {
      expect(() => parseJetlineCouriers(html, DELIVERED), html.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const summary = page('summary');
    for (const html of [summary.replace('&#39;grd1$ctl02$LinkButton1&#39;', '&#39;btnLogin&#39;'),
      summary.replace(GRID_ROW, '</tr>'), `${summary}${summary}`]) {
      expect(() => jetlineHistoryFields(html, DELIVERED), html.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('posts the form’s own state and refuses a form without it', () => {
    const fields = jetlineSearchFields(page('form'), IN_TRANSIT);
    expect(fields.get('txtAwbNo')).toBe(IN_TRANSIT);
    expect(fields.has('btnLogin')).toBe(false);
    expect(fields.has('txtPassword')).toBe(false);
    for (const html of [page('form').replace(/name="__VIEWSTATE" id="__VIEWSTATE" value="[^"]*"/, 'name="__VIEWSTATE" id="__VIEWSTATE" value=""'),
      page('form').replace(/<input type="hidden" name="__EVENTVALIDATION"[^>]*>/, ''),
      page('form').replace('type="submit" name="btnTrack"', 'type="button" name="btnTrack"'),
      page('form').replace('name="txtAwbNo"', 'name="txtNumber"')]) {
      expect(() => jetlineSearchFields(html, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('follows the form’s redirect only to the tracker’s own answer page', async () => {
    expect(jetlineAnswerUrl(ANSWER)).toBe(ANSWER_URL);
    expect(jetlineAnswerUrl('/Track.aspx?trackId=Ab+cd/EF==')).toBe('https://www.jetlinecouriers.in/Track.aspx?trackId=Ab+cd/EF==');
    for (const location of [null, '', '/', '/track.aspx', '/track.aspx?trackId=', '/track.aspx?id=AAAA', `${ANSWER}&x=1`,
      `https://example.com${ANSWER}`, '/error.html?aspxerrorpath=/track.aspx', `${ANSWER}#top`, 'http://[']) {
      expect(() => jetlineAnswerUrl(location), String(location)).toThrow(expect.objectContaining({ kind: 'transport' }));
    }
    const elsewhere = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('form'))).mockResolvedValueOnce(moved('https://example.com/'));
    await expect(carrier(elsewhere).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'transport' });
    expect(elsewhere).toHaveBeenCalledTimes(2);
    // The form answered in place, or the answer page or its history moving elsewhere.
    const inPlace = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('form'))).mockResolvedValueOnce(reply(page('form')));
    await expect(carrier(inPlace).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'schema' });
    for (const fetcher of [vi.fn<typeof fetch>().mockResolvedValueOnce(moved('/')), flow(moved('/')), flow(reply(page('summary')), moved(ANSWER))]) {
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'transport' });
    }
  });

  it('answers a number the tracker holds nothing under after three requests', async () => {
    const fetcher = flow(reply(page('not-found')));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('takes AWB numbers of seven to nine digits and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['123456', '1234567890', 'A12345678', 'JL1234567', '12345678X', `${DELIVERED},${IN_TRANSIT}`, '1'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeJetlineNumber('123-456-789')).toBe(DELIVERED);
    expect(normalizeJetlineNumber('1234567')).toBe('1234567');
    expect(normalizeJetlineNumber('0000000')).toBe('0000000');
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s on each request, without a retry', async (status, kind) => {
      const failing = (body: string) => reply(status === 500 ? '' : body, status);
      const entry = vi.fn<typeof fetch>().mockImplementation(async () => failing(page('form')));
      await expect(carrier(entry).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
      expect(entry).toHaveBeenCalledTimes(1);
      const search = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('form'))).mockResolvedValueOnce(failing(page('form')));
      await expect(carrier(search).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
      expect(search).toHaveBeenCalledTimes(2);
      const answer = flow(failing(page('not-found')));
      await expect(carrier(answer).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
      expect(answer).toHaveBeenCalledTimes(3);
      const history = flow(reply(page('summary')), failing(page('delivered')));
      await expect(carrier(history).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      expect(history).toHaveBeenCalledTimes(4);
    });

  it('keeps empty pages and oversized replies apart from missing parcels', async () => {
    for (const [body, kind] of [['', 'indeterminate'], ['  ', 'indeterminate'], ['{"status":"Delivered"}', 'schema']] as const) {
      await expect(carrier(flow(reply(body))).track({ number: UNKNOWN }), body).rejects.toMatchObject({ kind });
      await expect(carrier(flow(reply(page('summary')), reply(body))).track({ number: DELIVERED }), body).rejects.toMatchObject({ kind });
    }
    const large = flow(reply(page('summary')), new Response(new Uint8Array(8 * 1024 * 1024 + 1)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('form'))).mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(page('form'))).mockResolvedValueOnce(moved(ANSWER)).mockResolvedValueOnce(reply(inTransitSummary()))
      .mockResolvedValueOnce(reply(page('in-transit')));
    await expect(carrier(flaky).track({ number: IN_TRANSIT })).resolves.toMatchObject({ status: 'in_transit' });
    expect(flaky).toHaveBeenCalledTimes(6);
    const immediate = flow(reply(page('summary')), reply(page('delivered')));
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

  it('routes an AWB number filed under Jetline Couriers to the adapter', async () => {
    const fetcher = flow(reply(inTransitSummary()), reply(page('in-transit')));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: IN_TRANSIT, carrier: 'jetline-couriers' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'jetline-couriers', source: 'jetline-couriers', result: { current_stage: 'in_transit' },
      attempts: [{ source: 'jetline-couriers', kind: 'ok' }] });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});

describe('Jetline Couriers numbers', () => {
  it('leaves AWB numbers unclaimed', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN, '1234567']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('jetline-couriers');
    }
  });
});

describe('Jetline Couriers status vocabulary', () => {
  it('records every wording seen with the stage it gets', () => {
    for (const entry of statuses.entries) {
      const wording = entry.wording.replace(/<[a-z]+>/g, 'SAMPLEPUR');
      expect(jetlineStage(wording)?.stage, entry.wording).toBe(entry.stage);
    }
    // The history's wording is the map's; the summary's status, which the adapter does not read, is left to the shared rules.
    for (const entry of statuses.entries.filter(({ wording }) => wording !== 'DELIVERED SIGN')) {
      const wording = entry.wording.replace(/<[a-z]+>/g, 'SAMPLEPUR');
      expect(jetlineMappedStage(wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, wording.toLowerCase()), entry.wording).toBe(entry.stage);
    }
    expect(jetlineMappedStage('  shipment   received at  samplepur in ')).toBe('in_transit');
    for (const wording of ['SHIPMENT CURRENT STATUS IS UNDELIVERED', 'SHIPMENT CURRENT STATUS IS', 'BOOKED', 'SHIPMENT RECEIVED', 'constructor', '']) {
      expect(jetlineMappedStage(wording), wording).toBeUndefined();
    }
    expect(statusMap.stage('BOOKED', 'booked at samplepur')).toBeUndefined();
    // Other wording goes to the shared rules, and wording they do not know either stays without a stage.
    expect(jetlineStage('SHIPMENT RECEIVED AT SAMPLEPUR IN SMPHUB')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(jetlineStage('SHIPMENT CURRENT STATUS IS OUT FOR DELIVERY')).toEqual({ stage: 'out_for_delivery', source: 'wording:language' });
    expect(jetlineStage('SHIPMENT SCANNED AT SAMPLEPUR')).toBeNull();
    expect(statusMapAnswer({ carrier: 'jetline-couriers', providerCode: null, description: 'BOOKED AT SAMPLEPUR' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
  });
});
