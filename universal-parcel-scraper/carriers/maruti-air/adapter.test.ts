import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, MARUTI_AIR_TRACKER, MarutiAirTracker } from './adapter.js';
import { normalizeMarutiAirNumber, parseMarutiAir } from './parser.js';
import { marutiAirMappedStage, marutiAirStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '200000011';
const IN_TRANSIT = '200000022';
const UNKNOWN = '300000033';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (result: ReturnType<typeof parseMarutiAir>) =>
  result.events!.map(event => [event.time ?? event.local_time, event.location ?? null, event.description, event.stage ?? null]);
// The sender, the consignee, the receiver, the delivery staff, the signature and the delivery image.
const PRIVATE = /SAMPLE|STAFF SIGN|base64|imgViewFile|Consignor|Consignee/i;
const ROW = (date: string, time: string, place: string, activity: string) => `<tr><td>${date}</td><td>${time}</td><td>${place}</td><td>${activity}</td></tr>`;
const HISTORY = /(<tr><th>Date<\/th><th>Time<\/th><th>Location<\/th><th>Activity<\/th><\/tr>)[\s\S]*?(<\/table>)/;
const withRows = (html: string, ...lines: string[]) => html.replace(HISTORY, (_, heading: string, end: string) => `${heading}${lines.join('')}${end}`);
const withSummary = (html: string, status: string) => html.replace(/(<div class="shippingstatus">[\s\S]*?<span class="green">)[^<]*(<\/span>)/, `$1${status}$2`);
const TRACKING = /<div class="tracking">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/;

describe('Maruti Air tracking adapter', () => {
  it('opens the tracker once for the whole document number through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new MarutiAirTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` ${DELIVERED.slice(0, 4)} ${DELIVERED.slice(4)} `, { budgetMs: 1000.5 })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://erp.marutiair.com/TrackpageWeb/WebAWBTracking.aspx?AWB=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'maruti-air', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the history newest first on India’s clock, keeps a midnight delivery as its day and drops every name', () => {
    const result = parseMarutiAir(page('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language', last_status_text: 'DELIVERED',
      last_update: null, last_update_local: '2026-10-13', expected_delivery: null });
    expect(rows(result)).toEqual([
      // The receiver's name and the signature after the wording are dropped.
      ['2026-10-13', 'PUNE - KOTHRUD', 'DELIVERED', 'delivered'],
      // So is the delivery staff's name.
      ['2026-10-13T09:40:00+05:30', 'PUNE - KOTHRUD', 'OUT FOR DELIVERY', 'out_for_delivery'],
      ['2026-10-12T22:15:00+05:30', 'PUNE', 'Received at PUNE - KOTHRUD', 'in_transit'],
      ['2026-10-11T19:30:00+05:30', 'SURAT', 'Forwarded to PUNE', 'in_transit'],
      ['2026-10-11T14:05:00+05:30', 'SURAT - RING ROAD', 'BOOKED', null],
    ]);
    expect(result.events!.slice(2, 4).every(event => event.stage_source === 'carrier_map')).toBe(true);
    // A delivery the tracker dates only by its day is no instant.
    expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('summary_only');
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', IN_TRANSIT]] as const) {
      expect(JSON.stringify(parseMarutiAir(page(name), number)), name).not.toMatch(PRIVATE);
    }
    // A delivery with its time is the delivery's instant and the last update.
    const timed = parseMarutiAir(page('delivered').replace('<td>00:00</td>', '<td>15:20</td>'), DELIVERED);
    expect(timed).toMatchObject({ last_update: '2026-10-13T15:20:00+05:30', delivered_at: '2026-10-13T15:20:00+05:30' });
    expect(timed).not.toHaveProperty('last_update_local');
  });

  it('follows the newest staged row of a document on its way, from a history listed oldest first', () => {
    const result = parseMarutiAir(page('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Received at BENGALURU - JAYANAGAR', last_update: '2026-10-16T06:10:00+05:30' });
    expect(rows(result)).toEqual([
      ['2026-10-16T06:10:00+05:30', 'BENGALURU', 'Received at BENGALURU - JAYANAGAR', 'in_transit'],
      ['2026-10-14T20:45:00+05:30', 'MUMBAI', 'Forwarded to BENGALURU', 'in_transit'],
      ['2026-10-14T11:20:00+05:30', 'MUMBAI - ANDHERI', 'BOOKED', null],
    ]);
    expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('last_update_local');
    // A row the page repeats appears once, and the newest-first order is kept.
    const body = page('in-transit');
    const listed = HISTORY.exec(body)![0].match(/<tr><td>[\s\S]*?<\/tr>/g)!;
    expect(parseMarutiAir(withRows(body, ...[...listed].reverse(), listed[0]), IN_TRANSIT).events).toEqual(result.events);
    // Wording neither the map nor the shared rules know stays without a stage, and the summary then decides.
    const unknown = withRows(body, ROW('17/10/2026', '10:00', 'BENGALURU', 'MANIFESTED'));
    expect(parseMarutiAir(unknown, IN_TRANSIT)).toMatchObject({ status: 'in_transit', last_status_text: 'IN TRANSIT' });
    const silent = parseMarutiAir(withSummary(unknown, ''), IN_TRANSIT);
    expect(silent).toMatchObject({ status: 'unknown', last_status_text: 'MANIFESTED', events: [{ description: 'MANIFESTED' }] });
    expect(silent).not.toHaveProperty('current_stage');
    expect(silent.events![0]).not.toHaveProperty('stage');
  });

  it('reads the tracker’s other day and time layouts and keeps only a day when no time is given', () => {
    const at = (date: string, time: string) =>
      rows(parseMarutiAir(withRows(page('in-transit'), ROW(date, time, 'MUMBAI', 'Forwarded to PUNE')), IN_TRANSIT))[0]![0];
    expect(at('2026-10-09', '15:40:00')).toBe('2026-10-09T15:40:00+05:30');
    expect(at('9/10/2026', '3:40 PM')).toBe('2026-10-09T15:40:00+05:30');
    expect(at('09-10-2026', '15:40')).toBe('2026-10-09T15:40:00+05:30');
    expect(at('09.10.2026', '15:40')).toBe('2026-10-09T15:40:00+05:30');
    expect(at('9 Oct 2026', '12:05 AM')).toBe('2026-10-09T00:05:00+05:30');
    expect(at('09-Sept-2026', '12:30 pm')).toBe('2026-09-09T12:30:00+05:30');
    expect(at('09/10/2026 15:40', '')).toBe('2026-10-09T15:40:00+05:30');
    for (const [date, time] of [['09/10/2026', ''], ['09/10/2026', '00:00:00'], ['09/10/2026', '12:00 AM'], ['09/10/2026 00:00', '']]) {
      expect(at(date!, time!), `${date} ${time}`).toBe('2026-10-09');
    }
    for (const [date, time] of [['10/13/2026', '15:40'], ['32/10/2026', '15:40'], ['30/02/2026', '15:40'], ['9 Foo 2026', '15:40'],
      ['09/10/26', '15:40'], ['09/10/2026', '25:00'], ['09/10/2026', '13:40 PM'], ['09/10/2026', '940'], ['09/10/2026', 'noon'], ['', '15:40']]) {
      expect(() => at(date!, time!), `${date} ${time}`).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('lets the summary’s delivery settle the document, and the summary stand alone without a history', () => {
    const ahead = parseMarutiAir(withSummary(page('in-transit'), 'DELIVERED'), IN_TRANSIT);
    expect(ahead).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'DELIVERED',
      last_update: '2026-10-16T06:10:00+05:30' });
    expect(ahead).not.toHaveProperty('delivered_at');
    // The summary reads without its label.
    expect(parseMarutiAir(withSummary(page('in-transit'), 'DELIVERED').replace('<h5>Status</h5>', '<h5>Current Status :</h5>'), IN_TRANSIT))
      .toMatchObject({ current_stage: 'delivered', last_status_text: 'DELIVERED' });
    // A summary on its way does not override a delivered row.
    expect(parseMarutiAir(withSummary(page('delivered'), 'IN TRANSIT'), DELIVERED)).toMatchObject({ current_stage: 'delivered' });
    const alone = parseMarutiAir(withRows(page('delivered'), ''), DELIVERED);
    expect(alone).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'DELIVERED',
      last_update: null, summary_only: true, events: [] });
    expect(() => parseMarutiAir(withSummary(withRows(page('delivered'), ''), ''), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('binds the page to the requested document and rejects pages it cannot read', () => {
    expect(() => parseMarutiAir(page('delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const delivered = page('delivered');
    const heading = `<span class="green">${DELIVERED}</span>`;
    for (const html of [
      // The heading names another document, or two.
      delivered.replace(heading, `<span class="green">${IN_TRANSIT}</span>`),
      delivered.replace(heading, `<span class="green">${DELIVERED}0</span>`),
      delivered.replace(heading, `<span class="green">${DELIVERED}</span><span>${IN_TRANSIT}</span>`),
      // The field holds another number, or several behind a long value.
      delivered.replace(`value="${DELIVERED}"`, `value="${IN_TRANSIT}"`),
      delivered.replace(`value="${DELIVERED}"`, `value="${DELIVERED}${','.repeat(60)}${IN_TRANSIT}"`),
      // Several documents under the number.
      delivered.replace(TRACKING, (block) => `${block}${block}`),
    ]) {
      expect(() => parseMarutiAir(html, DELIVERED), html.length.toString()).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    const history = HISTORY.exec(delivered)![0];
    for (const html of ['<html><body>Maintenance</body></html>',
      delivered.replace('id="form1"', 'id="form2"'),
      delivered.replace(heading, '<span class="green">Docket</span>'),
      delivered.replace(heading, `<span class="green">${'X'.repeat(1000)} ${DELIVERED}</span>`),
      delivered.replace(TRACKING, ''),
      delivered.replace('<th>Location</th>', '<th>Date</th>'),
      delivered.replace(history, `${history}<table class="shipingtable">${history}`),
      delivered.replace('<td>SURAT</td><td>Forwarded to PUNE</td>', '<td>SURAT</td>'),
      delivered.replace('<td>OUT FOR DELIVERY WITH SAMPLE COURIER</td>', '<td> </td>'),
      withRows(delivered, ...Array.from({ length: 301 }, (_, minute) =>
        ROW('12/10/2026', `${String(10 + Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`, 'PUNE', 'Received at PUNE')))]) {
      expect(() => parseMarutiAir(html, DELIVERED), html.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads only the tracker’s notice with the number in its field as a missing document, and a block page as a challenge', () => {
    expect(() => parseMarutiAir(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The notice for another number in the field is inconclusive, and so is one with the field emptied.
    expect(() => parseMarutiAir(page('not-found'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseMarutiAir(page('not-found').replace(`value="${UNKNOWN}"`, 'value=""'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const notice = /<div class='alert alert-danger' role='alert'>DETAIL NOT FOUND !<\/div>/;
    const block = TRACKING.exec(page('delivered'))![0].replaceAll(DELIVERED, UNKNOWN);
    for (const html of [
      page('not-found').replace(notice, (alert) => `${alert}${block}`),
      page('not-found').replace(notice, (alert) => `${alert}${alert}`),
      page('not-found').replace(notice, "<div class='alert alert-danger' role='alert'>Server busy</div>"),
      page('not-found').replace(notice, ''),
    ]) {
      expect(() => parseMarutiAir(html, UNKNOWN), html.length.toString()).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const html of ['<html><head><title>Access Denied</title></head><body>Blocked</body></html>',
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      '<html><body><div class="g-recaptcha" data-sitekey="SYNTHETIC"></div></body></html>']) {
      expect(() => parseMarutiAir(html, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('takes digit runs of eight to ten digits and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['1234567', '12345678901', '20000001X', 'ABCDEFGHI', `${DELIVERED},${IN_TRANSIT}`, '5'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeMarutiAirNumber('2000-000-11')).toBe(DELIVERED);
    expect(normalizeMarutiAirNumber('10000000')).toBe('10000000');
    expect(normalizeMarutiAirNumber('1000000000')).toBe('1000000000');
  });

  it('recognizes a known document and the not-found notice, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('in-transit'))).mockResolvedValueOnce(reply(page('not-found')))
      .mockResolvedValueOnce(reply(page('delivered')));
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: '2026-10-16T00:40:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([[302, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => status === 302
        ? new Response(null, { status, headers: { Location: '/TrackpageWeb/Error.aspx' } })
        : reply(status === 500 ? '' : page('not-found'), status));
      await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(UNKNOWN)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps empty pages and oversized replies apart from missing documents', async () => {
    for (const [body, kind] of [['', 'indeterminate'], ['  ', 'indeterminate'], ['{"status":"Delivered"}', 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
      await expect(carrier(fetcher).recognize!(UNKNOWN), body.slice(0, 40)).rejects.toMatchObject({ kind });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(3 * 1024 * 1024 + 1)));
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

  it('routes a document number filed under Maruti Air to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('in-transit')));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: IN_TRANSIT, carrier: 'maruti-air' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'maruti-air', source: 'maruti-air', result: { current_stage: 'in_transit' },
      attempts: [{ source: 'maruti-air', kind: 'ok' }] });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${MARUTI_AIR_TRACKER}?AWB=${IN_TRANSIT}`);
  });
});

describe('Maruti Air numbers', () => {
  it('leaves bare digit runs unclaimed', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN, '10000000', '1000000000']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('maruti-air');
    }
  });
});

describe('Maruti Air status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(marutiAirMappedStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(marutiAirMappedStage(`${entry.wording} PUNE - KOTHRUD`), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(entry.stage);
    }
    expect(marutiAirMappedStage('  RECEIVED   at  PUNE ')).toBe('in_transit');
    for (const wording of ['constructor', 'toString', 'Received', 'Received atPUNE', 'Not received at PUNE', 'DELIVERED']) {
      expect(marutiAirMappedStage(wording), wording).toBeUndefined();
    }
    expect(statusMap.stage('7', 'received at pune')).toBeUndefined();
    // Other wording goes to the shared rules, and wording they do not know either stays without a stage.
    expect(marutiAirStage('Received at PUNE')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(marutiAirStage('OUT FOR DELIVERY')).toEqual({ stage: 'out_for_delivery', source: 'wording:language' });
    expect(marutiAirStage('BOOKED')).toBeNull();
    expect(statusMapAnswer({ carrier: 'maruti-air', description: 'Received at PUNE' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
  });
});
