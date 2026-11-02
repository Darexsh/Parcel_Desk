import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PITT_OHIO_ENDPOINT, PittOhioTracker } from './adapter.js';
import { normalizePittOhioNumber, parsePittOhio } from './parser.js';
import { pittOhioMappedStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '5011122233';
const IN_TRANSIT = '5022233344';
const UNKNOWN = '5033344455';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (result: ReturnType<typeof parsePittOhio>) =>
  result.events!.map(event => [event.local_time, event.location ?? null, event.description, event.stage ?? null]);
// The terminals' addresses and phone numbers in their pop-ups, the appointment and the site's forms.
const PRIVATE = /Sample Terminal Way|Example Industrial Drive|Sample Freight Road|00001|00002|00003|555-01|Appointment|SYNTHETIC-TOKEN/;
// The multi-number results page, which lists shipments with links to their details.
const RESULTS = page('in-transit').replace('<h1>LTL Shipment Status Details</h1>', '<h1>LTL Shipment Status Results</h1>');

describe('Pitt Ohio tracking adapter', () => {
  it('opens the tracing page once for the whole PRO number through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PittOhioTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` ${DELIVERED.slice(0, 3)}-${DELIVERED.slice(3)} `, { budgetMs: 1000.5 })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://pittohio.com/myPittOhio/Shipping/LTL/TraceRequest?pro=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pitt-ohio', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the shipment history newest first, as wall clocks, with each row’s place apart from its wording', () => {
    const result = parsePittOhio(page('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-03-12T14:41:00', expected_delivery: null });
    expect(rows(result)).toEqual([
      ['2026-03-12T14:41:00', 'Sampleton, WV', 'Delivered at consignee location', 'delivered'],
      ['2026-03-12T08:05:00', 'Sampleton, WV', 'Shipment out for delivery to consignee', 'out_for_delivery'],
      ['2026-03-12T07:58:00', null, 'Scheduled for Delivery to Consignee', 'in_transit'],
      ['2026-03-11T15:30:00', 'Sampleton, WV', 'Delivery Attempted - Incorrect Address', 'failed_attempt'],
      ['2026-03-11T08:12:00', 'Sampleton, WV', 'Shipment out for delivery to consignee', 'out_for_delivery'],
      ['2026-03-11T06:20:00', null, 'Scheduled for Delivery to Consignee', 'in_transit'],
      // A terminal's place, written without a space after the comma.
      ['2026-03-10T23:47:00', 'Testville, WV', 'Shipment arrived at PITT OHIO destination terminal', 'in_transit'],
      ['2026-03-10T21:15:00', 'Midtown, PA', 'Departed from intermediate terminal', 'in_transit'],
      ['2026-03-10T03:02:00', null, 'Arrived at PITT OHIO intermediate terminal.', 'in_transit'],
      ['2026-03-10T00:40:00', 'Exampleburg, OH', 'Shipment in transit to destination terminal from terminal', 'in_transit'],
      ['2026-03-09T19:10:00', 'Exampleburg, OH', 'Shipment arrived at PITT OHIO origin terminal', 'in_transit'],
      ['2026-03-09T15:55:00', 'Exampleburg, OH', 'Pickup - Departure', 'accepted'],
      ['2026-03-09T15:55:00', 'Fictionville, OH', 'Arrived at shipper pickup location', 'registered'],
    ]);
    expect(result.events!.every(event => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result).not.toHaveProperty('summary_only');
    expect(result).not.toHaveProperty('delivered_at');
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', IN_TRANSIT]] as const) {
      expect(JSON.stringify(parsePittOhio(page(name), number)), name).not.toMatch(PRIVATE);
    }
    // The page's order is kept when it lists the oldest first, and a row it repeats appears once.
    const body = page('delivered');
    const table = /<!-- Display each historical status row -->([\s\S]*?)<\/table>/.exec(body)![1]!;
    const listed = table.split('</tr>').slice(0, -1).map(row => `${row}</tr>`);
    const reversed = parsePittOhio(body.replace(table, `${[...listed].reverse().join('')}${listed[0]}\n`), DELIVERED);
    expect(reversed.events).toEqual(result.events);
  });

  it('follows the newest row past a status the page has not moved on, and keeps its own status for a delivery', () => {
    const result = parsePittOhio(page('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Departed from intermediate terminal', last_update_local: '2026-11-01T01:30:00' });
    expect(rows(result)).toEqual([
      ['2026-11-01T01:30:00', 'Midtown, PA', 'Departed from intermediate terminal', 'in_transit'],
      ['2026-11-01T01:05:00', 'Midtown, PA', 'Arrived at PITT OHIO intermediate terminal', 'in_transit'],
      ['2026-10-31T22:20:00', 'Exampleburg, OH', 'Shipment in transit to destination terminal from terminal', 'in_transit'],
      ['2026-10-31T18:45:00', 'Exampleburg, OH', 'Shipment arrived at PITT OHIO origin terminal', 'in_transit'],
      ['2026-10-31T14:10:00', 'Exampleburg, OH', 'Pickup - Departure', 'accepted'],
      ['2026-10-31T14:10:00', 'Fictionville, OH', 'Arrived at shipper pickup location', 'registered'],
    ]);
    // A delivery the page reports before its row comes in counts.
    const ahead = parsePittOhio(page('in-transit').replace('<td>In Transit</td>', '<td>Delivered</td>'), IN_TRANSIT);
    expect(ahead).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered' });
    // A status the map does not know falls to the shared wording rules, and a blank one leaves the rows to decide.
    const shared = parsePittOhio(page('in-transit').replace('<td>In Transit</td>', '<td>Returned to Shipper</td>'), IN_TRANSIT);
    expect(shared).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'wording:returned' });
    const blank = parsePittOhio(page('in-transit').replace('<td>In Transit</td>', '<td></td>'), IN_TRANSIT);
    expect(blank).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Departed from intermediate terminal' });
  });

  it('keeps the current status as the history when the page lists no rows, and a row without a time as its day', () => {
    const empty = page('in-transit').replace(/<!-- Display each historical status row -->[\s\S]*?<\/table>/, '</table>');
    expect(parsePittOhio(empty, IN_TRANSIT)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      current_stage_source: 'wording:language', last_status_text: 'In Transit', last_update_local: '2026-11-01', summary_only: true,
      events: [{ local_time: '2026-11-01', description: 'In Transit', stage: 'in_transit', stage_source: 'wording:language' }] });
    expect(() => parsePittOhio(empty.replace('<td>11/1/2026</td>', '<td></td>'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parsePittOhio(empty.replace('<td>In Transit</td>', '<td></td>'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const untimed = parsePittOhio(page('in-transit').replace(/\s*<td>1:30 AM<\/td>/, '').replace('<td>1:05 AM</td>', '<td></td>'), IN_TRANSIT);
    expect(rows(untimed).slice(0, 2)).toEqual([
      ['2026-11-01', 'Midtown, PA', 'Departed from intermediate terminal', 'in_transit'],
      ['2026-11-01', 'Midtown, PA', 'Arrived at PITT OHIO intermediate terminal', 'in_transit'],
    ]);
  });

  it('stages new wording through the shared rules and keeps the rest visible without a stage', () => {
    const shared = parsePittOhio(page('delivered').replace('Delivered at consignee location in', 'Delivered to receiving dock in'), DELIVERED);
    expect(shared.events![0]).toMatchObject({ description: 'Delivered to receiving dock', location: 'Sampleton, WV', stage: 'delivered' });
    expect(shared.events![0]!.stage_source).toMatch(/^wording:/);
    const unknown = parsePittOhio(page('in-transit').replace('Departed from intermediate terminal in', 'Trailer closed in'), IN_TRANSIT);
    expect(unknown).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Trailer closed' });
    expect(unknown.events![0]).toEqual({ local_time: '2026-11-01T01:30:00', location: 'Midtown, PA', description: 'Trailer closed' });
  });

  it('binds the page to the requested PRO number and rejects pages it cannot read', () => {
    expect(() => parsePittOhio(page('delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePittOhio(page('delivered').replace(`<td style="width:70%"><b>${DELIVERED}</b>`, `<td style="width:70%"><b>${DELIVERED}0</b>`),
      DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const html of ['<html><body>Maintenance</body></html>',
      page('delivered').replace(`<td style="width:70%"><b>${DELIVERED}</b>`, '<td style="width:70%"><b></b>'),
      page('delivered').replace('Pro #:', 'Order #:'),
      page('delivered').replace('<th><b>Status:</b></th>', '<th><b>Pro #:</b></th>'),
      page('delivered').replace('<span>Shipment History</span>', '<span>History</span>'),
      page('delivered').replace('<span>Shipment Documents</span>', '<span>Shipment History</span>'),
      page('delivered').replace('<td>2:41 PM</td>', '<td>14:41 PM</td>'),
      page('delivered').replace('<td>2:41 PM</td>', '<td>2:41</td>'),
      page('delivered').replace('<td>3/12/2026</td>\n                                <td>2:41 PM</td>', '<td>2/30/2026</td>\n<td>2:41 PM</td>'),
      page('delivered').replace('<td>3/12/2026</td>\n                                <td>2:41 PM</td>', '<td>2026-03-12</td>\n<td>2:41 PM</td>'),
      page('delivered').replace('Delivered at consignee location in Sampleton, WV', ''),
      page('delivered').replace('<td>2:41 PM</td>', '<td>2:41 PM</td><td>Sample</td>')]) {
      expect(() => parsePittOhio(html, DELIVERED), html.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const many = page('delivered').replace('<!-- Display each historical status row -->', Array.from({ length: 501 }, (_, minute) =>
      `<tr><td>3/10/2026</td><td>${1 + Math.floor(minute / 60) % 12}:${String(minute % 60).padStart(2, '0')} AM</td><td>Departed from intermediate terminal</td></tr>`).join(''));
    expect(() => parsePittOhio(many, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads only the search form’s notice for the number asked as a missing shipment, and a block page as a challenge', () => {
    expect(() => parsePittOhio(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The notice names no number; the form keeps the one it looked up.
    expect(() => parsePittOhio(page('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePittOhio(page('not-found').replace(`value="${UNKNOWN}"`, 'value=""'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The search form without the notice, as the tracing page shows it before a lookup.
    expect(() => parsePittOhio(page('not-found').replace(/Search returned no results\.[^\n]*/, ''), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePittOhio(page('not-found').replace('Search returned no results.', 'Something went wrong.'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    // Several shipments for the number are inconclusive.
    expect(() => parsePittOhio(RESULTS, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const html of ['<html><head><title>Access Denied</title></head><body>Blocked</body></html>',
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body></body></html>']) {
      expect(() => parsePittOhio(html, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('takes ten-digit PRO numbers and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['501112223', '50111222334', '501112223X', 'ABCDEFGHIJ', '1Z9999999999999999', '5'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizePittOhioNumber('501 112 2233')).toBe(DELIVERED);
  });

  it('recognizes a known shipment and the not-found notice, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('in-transit'))).mockResolvedValueOnce(reply(page('not-found')))
      .mockResolvedValueOnce(reply(RESULTS));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-11-01T01:30:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([[302, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => status === 302
        ? new Response(null, { status, headers: { Location: '/myPittOhio/Users/Account/LogOn' } })
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

  it('routes a PRO number filed under Pitt Ohio to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: DELIVERED, carrier: 'pitt-ohio' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'pitt-ohio', source: 'pitt-ohio', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${PITT_OHIO_ENDPOINT}?`))).toBe(true);
  });
});

describe('Pitt Ohio numbers', () => {
  it('leaves ten digits unclaimed', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN]) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('pitt-ohio');
    }
  });
});

describe('Pitt Ohio status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(pittOhioMappedStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(entry.stage);
    }
    expect(pittOhioMappedStage('  Pickup -  DEPARTURE ')).toBe('accepted');
    expect(pittOhioMappedStage('Arrived at PITT OHIO intermediate terminal.')).toBe('in_transit');
    for (const wording of ['constructor', 'toString', 'Pickup', 'Delivered at consignee location in Sampleton, WV']) {
      expect(pittOhioMappedStage(wording), wording).toBeUndefined();
    }
    expect(statusMap.stage('7', 'delivered')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'pitt-ohio', description: 'Pickup - Departure' })).toEqual({ kind: 'mapped', stage: 'accepted' });
  });
});
