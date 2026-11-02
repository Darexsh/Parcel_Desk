import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ICC_WORLDWIDE_ENDPOINT, IccWorldwideTracker } from './adapter.js';
import { normalizeIccWorldwideNumber, parseIccWorldwide } from './parser.js';
import { iccWorldwideMappedStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '10000000011';
const IN_TRANSIT = '10000000022';
const UNKNOWN = '10000000033';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (result: ReturnType<typeof parseIccWorldwide>) =>
  result.events!.map(event => [event.time ?? event.local_time, event.location ?? null, event.description, event.stage ?? null]);
// The receiver, the customer, the consignee, the origin and destination cells and the print link.
const PRIVATE = /SAMPLE RECEIVER|SAMPLE STORE|SAMPLE CONSIGNEE|SAMPLE SHOPPER|printview|nodecoration/;
const ROW = (date: string, time: string, place: string, details: string) =>
  `<tr><td class="text-left">${date}</td><td class="text-left">${time}</td><td class="text-left">${place}</td><td class="text-left">${details}</td></tr>`;
const TBODY = /<tbody class="table-hover">[\s\S]*?<\/tbody>/;
const withRows = (html: string, ...lines: string[]) => html.replace(TBODY, `<tbody class="table-hover">${lines.join('')}</tbody>`);
const EMPTY_STATUS = /<span class="delivered">\s*<\/span>/;
const delivered = (html: string, line: string) => html.replace(EMPTY_STATUS, `<span class="delivered">SAMPLE RECEIVER<br/>${line}</span>`);

describe('ICC Worldwide tracking adapter', () => {
  it('opens the tracking page once for the whole air waybill through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new IccWorldwideTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` ${DELIVERED.slice(0, 4)} ${DELIVERED.slice(4)} `, { budgetMs: 1000.5 })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://www.iccworld.com/track-result.php?track_no=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'icc-worldwide', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the checkpoints newest first, on India’s clock in India and as wall clocks elsewhere, and the delivering partner', () => {
    const result = parseIccWorldwide(page('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Shipment Delivered', last_update: '2026-10-09T15:40:00+05:30', expected_delivery: null,
      delivered_at: '2026-10-09T15:40:00+05:30', delivery_carrier: 'blue-dart', delivery_tracking_number: '69000000011' });
    expect(rows(result)).toEqual([
      // The receiver's name after the wording is dropped.
      ['2026-10-09T15:40:00+05:30', 'MUMBAI', 'SHIPMENT DELIVERED', 'delivered'],
      ['2026-10-09T09:15:00+05:30', 'MUMBAI', 'OUT FOR DELIVERY', 'out_for_delivery'],
      ['2026-10-08T18:20:00+05:30', 'MUMBAI', 'HANDED OVER TO BLUE DART', 'accepted'],
      ['2026-10-08T11:05:00+05:30', 'MUMBAI', 'CUSTOMS CLEARED', 'in_transit'],
      ['2026-10-07T22:30:00+05:30', 'MUMBAI', 'ARRIVED AT DESTINATION FACILITY', 'in_transit'],
      ['2026-10-06T20:10:00', 'NEW YORK', 'DEPARTED FROM ORIGIN FACILITY', 'in_transit'],
      // The customer's name after the wording is dropped.
      ['2026-10-05T14:30:00', 'NEW YORK', 'SHIPMENT PICKED UP', 'accepted'],
    ]);
    expect(result.events!.filter(event => event.location === 'NEW YORK').every(event => event.local_time && !event.time)).toBe(true);
    expect(result.events!.filter(event => event.location === 'MUMBAI').every(event => event.time && !event.local_time)).toBe(true);
    expect(result).not.toHaveProperty('summary_only');
    expect(result).not.toHaveProperty('last_update_local');
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', IN_TRANSIT]] as const) {
      expect(JSON.stringify(parseIccWorldwide(page(name), number)), name).not.toMatch(PRIVATE);
    }
  });

  it('follows the newest staged row of a shipment on its way, and keeps a row without a time as its day', () => {
    const result = parseIccWorldwide(page('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'wording:language',
      last_status_text: 'SHIPMENT ON HOLD AT CUSTOMS', last_update: '2026-10-14T10:20:00+05:30',
      delivery_carrier: 'dhl-express', delivery_tracking_number: '5000000011' });
    expect(rows(result)).toEqual([
      ['2026-10-14T10:20:00+05:30', 'NEW DELHI', 'SHIPMENT ON HOLD AT CUSTOMS', 'customs'],
      ['2026-10-13T23:45:00+05:30', 'NEW DELHI', 'ARRIVED AT DESTINATION FACILITY', 'in_transit'],
      ['2026-10-12T16:00:00', 'LONDON', 'DEPARTED FROM ORIGIN FACILITY', 'in_transit'],
      ['2026-10-11T11:30:00', 'LONDON', 'SHIPMENT RECEIVED AT ORIGIN FACILITY', 'accepted'],
      ['2026-10-11', 'LONDON', 'DATA RECEIVED', 'registered'],
    ]);
    expect(result).not.toHaveProperty('delivered_at');
    // The page's order is kept when it lists the oldest first, and a row it repeats appears once.
    const body = page('in-transit');
    const listed = TBODY.exec(body)![0].match(/<tr>[\s\S]*?<\/tr>/g)!;
    const reversed = parseIccWorldwide(withRows(body, ...[...listed].reverse(), listed[0]), IN_TRANSIT);
    expect(reversed.events).toEqual(result.events);
    // A newest row on a wall clock is the last update's own.
    const abroad = parseIccWorldwide(withRows(body, ROW('October 15, 2026', '08:00', 'LONDON', 'SHIPMENT ON HOLD')), IN_TRANSIT);
    expect(abroad).toMatchObject({ last_update: null, last_update_local: '2026-10-15T08:00:00' });
    // Wording neither the map nor the shared rules know stays without a stage.
    const unknown = parseIccWorldwide(withRows(body, ROW('October 15, 2026', '08:00', 'NEW DELHI', 'MANIFESTED')), IN_TRANSIT);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'MANIFESTED' });
    expect(unknown).not.toHaveProperty('current_stage');
  });

  it('reads the tracker’s other day and time layouts, and reads only places in India on India’s clock', () => {
    const at = (date: string, time: string, place = 'MUMBAI') =>
      rows(parseIccWorldwide(withRows(page('in-transit'), ROW(date, time, place, 'ARRIVED AT DESTINATION FACILITY')), IN_TRANSIT))[0]![0];
    expect(at('2026-10-09', '15:40:00')).toBe('2026-10-09T15:40:00+05:30');
    expect(at('9 Oct 2026', '3:40 PM')).toBe('2026-10-09T15:40:00+05:30');
    expect(at('09-Oct-2026', '1540')).toBe('2026-10-09T15:40:00+05:30');
    expect(at('Sept 9, 2026', '12:05 AM')).toBe('2026-09-09T00:05:00+05:30');
    expect(at('October 9, 2026', '', 'MUMBAI')).toBe('2026-10-09');
    expect(at('October 9, 2026', '15:40', 'PUNE, INDIA')).toBe('2026-10-09T15:40:00+05:30');
    expect(at('October 9, 2026', '15:40', 'Chennai')).toBe('2026-10-09T15:40:00+05:30');
    // Delhi alone could be New York State's; other places keep their wall clocks.
    for (const place of ['DELHI', 'NEW YORK', 'INDIANAPOLIS', 'MUMBAI AIRPORT', '']) {
      expect(at('October 9, 2026', '15:40', place), place).toBe('2026-10-09T15:40:00');
    }
    for (const [date, time] of [['10/09/2026', '15:40'], ['October 32, 2026', '15:40'], ['Foo 9, 2026', '15:40'], ['February 30, 2026', '15:40'],
      ['October 9, 2026', '25:00'], ['October 9, 2026', '13:40 PM'], ['October 9, 2026', '940'], ['October 9, 2026', 'noon'], ['', '15:40']]) {
      expect(() => at(date!, time!), `${date} ${time}`).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('lets the summary’s delivery settle the shipment, dated as a wall clock when no row has it yet', () => {
    const ahead = parseIccWorldwide(delivered(page('in-transit'), 'Shipment Delivered at October 15, 2026 12:10'), IN_TRANSIT);
    expect(ahead).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Shipment Delivered', last_update: null, last_update_local: '2026-10-15T12:10:00' });
    expect(ahead.events![0]).toEqual({ local_time: '2026-10-15T12:10:00', description: 'Shipment Delivered', stage: 'delivered', stage_source: 'carrier_map' });
    expect(ahead).not.toHaveProperty('delivered_at');
    expect(JSON.stringify(ahead)).not.toMatch(PRIVATE);
    // A delivery without its time keeps its day; one the parser cannot date still settles the shipment.
    const day = parseIccWorldwide(delivered(page('in-transit'), 'Shipment Delivered at October 15, 2026'), IN_TRANSIT);
    expect(day.events![0]).toMatchObject({ local_time: '2026-10-15', description: 'Shipment Delivered' });
    const undated = parseIccWorldwide(delivered(page('in-transit'), 'Shipment Delivered at 15/10/2026'), IN_TRANSIT);
    expect(undated).toMatchObject({ current_stage: 'delivered', last_status_text: 'Shipment Delivered', last_update: '2026-10-14T10:20:00+05:30' });
    expect(undated.events).toHaveLength(5);
    // Without rows, the summary's delivery is the history.
    const alone = parseIccWorldwide(withRows(delivered(page('in-transit'), 'Shipment Delivered at October 15, 2026 12:10'), ''), IN_TRANSIT);
    expect(alone).toMatchObject({ status: 'delivered', summary_only: true, events: [{ local_time: '2026-10-15T12:10:00', stage: 'delivered' }] });
    expect(() => parseIccWorldwide(withRows(page('in-transit'), ''), IN_TRANSIT)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    // A receiver's name alone is no delivery, and it is never kept.
    const named = parseIccWorldwide(page('in-transit').replace(EMPTY_STATUS, '<span class="delivered">SAMPLE RECEIVER</span>'), IN_TRANSIT);
    expect(named).toMatchObject({ current_stage: 'customs' });
    // Two deliveries in the summary are a changed page.
    expect(() => parseIccWorldwide(page('delivered').replace('15:40\n', '15:40<br/>Shipment Delivered at October 10, 2026 10:00\n'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps a partner only for one catalog carrier the summary links a number of its own to', () => {
    const link = (text: string) => `<a target="_blank" class="courier-details" href="#">${text}</a><br />`;
    const partner = (...texts: string[]) => {
      const result = parseIccWorldwide(page('in-transit').replace(/<a target="_blank" class="courier-details"[^>]*>DHL - 5000000011<\/a><br \/>/,
        texts.map(link).join('')), IN_TRANSIT);
      return [result.delivery_carrier ?? null, result.delivery_tracking_number ?? null];
    };
    expect(partner('UPS - 1Z 999 AA1 01 2345 6784')).toEqual(['ups', '1Z999AA10123456784']);
    expect(partner('FEDEX - 700000000011', 'FEDEX - 700000000011')).toEqual(['fedex', '700000000011']);
    expect(partner('TNT INTERNTIONAL - 900000001')).toEqual(['tnt', '900000001']);
    for (const texts of [['CITY-LINK - 12345678'], ['GLOBAL - 12345678'], ['UBX - 12345678'], ['DHL - 123'], [`DHL - ${IN_TRANSIT}`],
      ['DHL - 5000000011', 'UPS - 1Z999AA10123456784'], ['DHL 5000000011'], []]) {
      expect(partner(...texts), texts.join(', ')).toEqual([null, null]);
    }
  });

  it('binds the page to the requested air waybill and rejects pages it cannot read', () => {
    expect(() => parseIccWorldwide(page('delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseIccWorldwide(page('delivered').replace(`${DELIVERED}</a>`, `${DELIVERED}0</a>`), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseIccWorldwide(page('delivered').replace(`${DELIVERED} - Detailed Report`, `${IN_TRANSIT} - Detailed Report`), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // Several shipments under the number are inconclusive.
    const summary = /<div class="tracking-number">[\s\S]*?<div class="clear"><\/div>/.exec(page('delivered'))![0];
    const report = /<div class="shipment-report[\s\S]*?<div class="tracking-report-buttons">/.exec(page('delivered'))![0];
    const twice = page('delivered').replace(summary, `${summary}${summary}`).replace(report, `${report}</div></div>${report}`);
    expect(() => parseIccWorldwide(twice, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const html of ['<html><body>Maintenance</body></html>',
      page('delivered').replace(`${DELIVERED}</a>`, '</a>'),
      page('delivered').replace('Tracking / Airwaybill Number :', 'Order Number :'),
      page('delivered').replace(summary, ''),
      page('delivered').replace(report, ''),
      page('delivered').replace('<td class="text-left">MUMBAI</td>', ''),
      page('delivered').replace('<td class="text-left">OUT FOR DELIVERY</td>', '<td class="text-left"> </td>'),
      page('delivered').replace('</table>\n                    </div>\n                    <div class="clear">&nbsp;</div>',
        '</table><table class="tracking-report-table"></table></div><div class="clear">&nbsp;</div>')]) {
      expect(() => parseIccWorldwide(html, DELIVERED), html.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const many = withRows(page('in-transit'), ...Array.from({ length: 301 }, (_, minute) =>
      ROW('October 12, 2026', `${String(10 + Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`, 'LONDON', 'IN TRANSIT')));
    expect(() => parseIccWorldwide(many, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads only the summary’s notice as a missing shipment, and a block page as a challenge', () => {
    expect(() => parseIccWorldwide(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The notice names no number; one that names another is inconclusive.
    const other = page('not-found').replace('style="text-decoration: none;color: black;"></a>', `style="text-decoration: none;color: black;">${DELIVERED}</a>`);
    expect(() => parseIccWorldwide(other, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseIccWorldwide(other, DELIVERED)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseIccWorldwide(withRows(page('not-found'), ROW('October 9, 2026', '15:40', 'MUMBAI', 'IN TRANSIT')), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    // The page without its notice and without a number is a changed page.
    expect(() => parseIccWorldwide(page('not-found').replace('Record not found', ''), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseIccWorldwide(page('not-found').replace('Record not found', 'Server busy'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const html of ['<html><head><title>Access Denied</title></head><body>Blocked</body></html>',
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body></body></html>']) {
      expect(() => parseIccWorldwide(html, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('takes digit runs of seven to twelve digits and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['100000', '1000000000111', '1000000001X', 'ABCDEFGHIJK', '1Z9999999999999999', `${DELIVERED},${IN_TRANSIT}`, '5'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeIccWorldwideNumber('1000-000-0011')).toBe(DELIVERED);
    expect(normalizeIccWorldwideNumber('1000000')).toBe('1000000');
  });

  it('recognizes a known shipment and the not-found notice, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('in-transit'))).mockResolvedValueOnce(reply(page('not-found')))
      .mockResolvedValueOnce(reply(page('delivered')));
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: '2026-10-14T04:50:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([[302, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => status === 302
        ? new Response(null, { status, headers: { Location: '/index.html' } })
        : reply(status === 500 ? '' : page('not-found'), status));
      await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(UNKNOWN)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps empty pages and oversized replies apart from missing shipments', async () => {
    for (const [body, kind] of [['', 'indeterminate'], ['  ', 'indeterminate'], ['{"status":"Delivered"}', 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
      await expect(carrier(fetcher).recognize!(UNKNOWN), body.slice(0, 40)).rejects.toMatchObject({ kind });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
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

  it('routes an air waybill filed under ICC Worldwide to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: DELIVERED, carrier: 'icc-worldwide' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'icc-worldwide', source: 'icc-worldwide', result: { current_stage: 'delivered' },
      attempts: [{ source: 'icc-worldwide', kind: 'ok' }, { source: 'blue-dart' }] });
    // The delivering partner the page names is asked next, by its own number.
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual(['www.iccworld.com', 'www.bluedart.com']);
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${ICC_WORLDWIDE_ENDPOINT}?track_no=${DELIVERED}`);
    expect(String(fetcher.mock.calls[1]![0])).toContain('69000000011');
  });
});

describe('ICC Worldwide numbers', () => {
  it('leaves bare digit runs unclaimed', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN]) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('icc-worldwide');
    }
  });
});

describe('ICC Worldwide status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(iccWorldwideMappedStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(entry.stage);
    }
    expect(iccWorldwideMappedStage('  SHIPMENT   delivered ')).toBe('delivered');
    for (const wording of ['constructor', 'toString', 'Shipment Delivered at October 9, 2026 15:40', 'OUT FOR DELIVERY']) {
      expect(iccWorldwideMappedStage(wording), wording).toBeUndefined();
    }
    expect(statusMap.stage('7', 'shipment delivered')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'icc-worldwide', description: 'Shipment Delivered' })).toEqual({ kind: 'mapped', stage: 'delivered' });
  });
});
