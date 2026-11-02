import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, OAK_HARBOR_ENDPOINT, OakHarborTracker } from './adapter.js';
import { normalizeOakHarborNumber, parseOakHarbor } from './parser.js';
import { oakHarborMappedStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '31112222';
const IN_TRANSIT = '32223333';
const UNKNOWN = '33334444';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (result: ReturnType<typeof parseOakHarbor>) =>
  result.events!.map(event => [event.local_time, event.location ?? null, event.description, event.stage ?? null]);
// The references, parties, terminals' addresses and phone numbers, the signer and the documents form.
const PRIVATE = /4455667|SAMPLE-778|PO-0001|SAMPLE SUPPLY|EXAMPLE FARM|00001|00002|Sample Way|Example Road|555|SIGNER|Signature|Enter Email/i;

describe('Oak Harbor tracking adapter', () => {
  it('posts the whole PRO once to the tracing page’s action through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new OakHarborTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` ${DELIVERED.slice(0, 4)}-${DELIVERED.slice(4)} `, { budgetMs: 1000.5 })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://www.oakh.com/tracingactions.php');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'User-Agent': 'SyntheticHost/1.0', 'X-Requested-With': 'XMLHttpRequest', Referer: 'https://www.oakh.com/page/tracing',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } });
    expect(String(init!.body)).toBe(`action=loadTraceDetails&traceNum=${DELIVERED}&tracePro=${DELIVERED}&traceType=OHPRO`
      + '&showPrevious=false&showNext=false&traceAccount=0');
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'oak-harbor', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the trace history newest first, as wall clocks, without the signer, phone numbers or parties', () => {
    const result = parseOakHarbor(page('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-03-12T14:41:00', expected_delivery: null });
    expect(rows(result)).toEqual([
      ['2026-03-12T14:41:00', 'Fictionville, OR', 'Delivered', 'delivered'],
      ['2026-03-12T08:05:00', 'Testburg, OR', 'Dispatched for delivery', 'out_for_delivery'],
      // Repeated rows appear once.
      ['2026-03-11T15:30:00', 'Fictionville, OR', 'Refused-not delivered', 'failed_attempt'],
      ['2026-03-11T12:26:00', 'Fictionville, OR', 'Appointment-3/12/26 08:00-12:00', 'in_transit'],
      ['2026-03-11T07:58:00', 'Testburg, OR', 'Dispatched for delivery', 'out_for_delivery'],
      ['2026-03-11T00:42:00', 'Testburg, OR', 'Arrived at terminal', 'in_transit'],
      ['2026-03-10T21:54:00', 'Midtown, WA', 'Leaving Terminal', 'in_transit'],
      ['2026-03-10T05:31:00', 'Midtown, WA', 'Arrived at terminal', 'in_transit'],
      ['2026-03-09T19:10:00', 'Exampleton, WA', 'Leaving Terminal', 'in_transit'],
      ['2026-03-09T15:55:00', 'Exampleton, WA', 'Picked Up', 'accepted'],
    ]);
    expect(result.events!.every(event => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    for (const field of ['summary_only', 'delivered_at', 'sender_name', 'receiver_name']) expect(result).not.toHaveProperty(field);
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', IN_TRANSIT]] as const) {
      expect(JSON.stringify(parseOakHarbor(page(name), number)), name).not.toMatch(PRIVATE);
    }
    // The page's order is kept when it lists the oldest first.
    const body = page('delivered');
    const table = /<\/th><\/tr>([\s\S]*?)<\/table>/.exec(body)![1]!;
    const listed = table.split('</tr>').slice(0, -1).map(row => `${row}</tr>`);
    expect(parseOakHarbor(body.replace(table, [...listed].reverse().join('')), DELIVERED).events).toEqual(result.events);
  });

  it('follows the newest row past a delivery status the page has not moved on, and keeps the estimate until a delivery', () => {
    const result = parseOakHarbor(page('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Arrived at terminal', last_update_local: '2026-11-01T01:30:00', expected_delivery: '2026-11-03' });
    expect(rows(result)).toEqual([
      ['2026-11-01T01:30:00', 'Midtown, WA', 'Arrived at terminal', 'in_transit'],
      ['2026-10-31T22:20:00', 'Sample Falls, ID', 'Leaving Terminal', 'in_transit'],
      ['2026-10-31T10:05:00', 'Sample Falls, ID', 'Received from Partner', 'accepted'],
    ]);
    const status = '<span>In transit between terminals</span>';
    // A delivery the page reports before its row comes in counts, and drops the estimate.
    const ahead = parseOakHarbor(page('in-transit').replace(status, '<span>Delivered</span>'), IN_TRANSIT);
    expect(ahead).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', expected_delivery: null });
    // A status the map does not know falls to the shared wording rules, and a blank one leaves the rows to decide.
    const shared = parseOakHarbor(page('in-transit').replace(status, '<span>Returned to Shipper</span>'), IN_TRANSIT);
    expect(shared).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'wording:returned' });
    const blank = parseOakHarbor(page('in-transit').replace(status, '<span></span>'), IN_TRANSIT);
    expect(blank).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Arrived at terminal' });
    // An estimate that is not a real day is left out.
    expect(parseOakHarbor(page('in-transit').replace('11/03/26', '13/03/26'), IN_TRANSIT).expected_delivery).toBeNull();
  });

  it('keeps a row without a time as its day and stages new wording through the shared rules', () => {
    const untimed = parseOakHarbor(page('in-transit').replace('<td>01:30</td>', '<td></td>'), IN_TRANSIT);
    expect(rows(untimed)[0]).toEqual(['2026-11-01', 'Midtown, WA', 'Arrived at terminal', 'in_transit']);
    const shared = parseOakHarbor(page('delivered').replace('Delivered Signature-SAMPLE SIGNER', 'Delivered to dock'), DELIVERED);
    expect(shared.events![0]).toMatchObject({ description: 'Delivered to dock', location: 'Fictionville, OR', stage: 'delivered' });
    expect(shared.events![0]!.stage_source).toMatch(/^wording:/);
    const unknown = parseOakHarbor(page('in-transit').replace('<td>Arrived at terminal</td>', '<td>Trailer closed</td>'), IN_TRANSIT);
    expect(unknown).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Trailer closed' });
    expect(unknown.events![0]).toEqual({ local_time: '2026-11-01T01:30:00', location: 'Midtown, WA', description: 'Trailer closed' });
  });

  it('binds the details to the requested PRO and rejects details it cannot read', () => {
    // The hidden fields echo the lookup; another number there is another lookup.
    expect(() => parseOakHarbor(page('delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A shipment the tracker found by another reference is not the PRO asked.
    const other = page('delivered').replace(`<span class="notAuthThin">${DELIVERED}</span>`, `<span class="notAuthThin">${IN_TRANSIT}</span>`);
    expect(() => parseOakHarbor(other, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: expect.stringContaining('another shipment') }));
    expect(() => parseOakHarbor(page('delivered').replace('value="OHPRO"', 'value="BL"'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const empty = page('in-transit').replace(/<\/th><\/tr>[\s\S]*?<\/table>/, '</th></tr></table>');
    expect(() => parseOakHarbor(empty, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    for (const html of ['<html><body>Maintenance</body></html>',
      page('delivered').replace(`<span class="notAuthThin">${DELIVERED}</span>`, '<span class="notAuthThin"></span>'),
      page('delivered').replace('OAKH Pro:', 'Pro or BOL#:'),
      page('delivered').replace('Shipper Number:', 'OAKH Pro:'),
      page('delivered').replace('Pro Information', 'Shipment'),
      page('delivered').replace('id="traceDetailsTable"', 'id="traceTable"'),
      page('delivered').replace('>Location</th>', '>Place</th>'),
      page('delivered').replace('<td>14:41</td>', '<td>24:41</td>'),
      page('delivered').replace('<td>14:41</td>', '<td>2:41 PM</td>'),
      page('delivered').replace('<td>03/12/26</td><td>14:41</td>', '<td>02/30/26</td><td>14:41</td>'),
      page('delivered').replace('<td>03/12/26</td><td>14:41</td>', '<td>2026-03-12</td><td>14:41</td>'),
      page('delivered').replace('Delivered Signature-SAMPLE SIGNER', ''),
      page('delivered').replace('<td>14:41</td>', '<td>14:41</td><td>Sample</td>')]) {
      expect(() => parseOakHarbor(html, DELIVERED), html.slice(-80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const many = page('delivered').replace('</th></tr>', `</th></tr>${Array.from({ length: 501 }, (_, minute) =>
      `<tr><td>03/10/26</td><td>${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}</td><td>Leaving Terminal</td><td></td></tr>`).join('')}`);
    expect(() => parseOakHarbor(many, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads only "Pro Not Found" as a missing shipment, the support notice as inconclusive and a block page as a challenge', () => {
    expect(() => parseOakHarbor(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseOakHarbor(page('support-notice'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    // Each notice binds to the lookup through the hidden fields.
    for (const name of ['not-found', 'support-notice']) {
      expect(() => parseOakHarbor(page(name), DELIVERED), name).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
      expect(() => parseOakHarbor(page(name).replace('id="currentPro" type="hidden" value="33334444"', 'id="currentPro" type="hidden" value="0"'), UNKNOWN), name)
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseOakHarbor(page('not-found').replace('Pro Not Found', 'Tracking is currently unavailable.'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const html of ['<html><head><title>Access Denied</title></head><body>Blocked</body></html>',
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body></body></html>']) {
      expect(() => parseOakHarbor(html, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('takes eight-digit PROs and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['3111222', '311122223', '3111222X', 'ABCDEFGH', '01112222', '00000000', '1Z9999999999999999', '3'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeOakHarborNumber('3111 2222')).toBe(DELIVERED);
    expect(carrier(fetcher).recognize).toBeUndefined();
  });

  it.each([[302, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => status === 302
        ? new Response(null, { status, headers: { Location: '/page/login' } })
        : reply(status === 500 ? '' : page('not-found'), status));
      await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('keeps empty replies and oversized ones apart from missing shipments', async () => {
    for (const [body, kind] of [['', 'indeterminate'], ['  ', 'indeterminate'], ['{"status":"Delivered"}', 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
      await expect(carrier(fetcher).track({ number: UNKNOWN }), body.slice(0, 40)).rejects.toMatchObject({ kind });
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

  it('routes a PRO filed under Oak Harbor to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: DELIVERED, carrier: 'oak-harbor' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'oak-harbor', source: 'oak-harbor', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === OAK_HARBOR_ENDPOINT)).toBe(true);
  });
});

describe('Oak Harbor numbers', () => {
  it('leaves eight digits unclaimed', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN]) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('oak-harbor');
    }
  });
});

describe('Oak Harbor status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(oakHarborMappedStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(entry.stage);
    }
    expect(oakHarborMappedStage('  Leaving   TERMINAL ')).toBe('in_transit');
    expect(oakHarborMappedStage('Appointment-4/09/20  14:00-17:00')).toBe('in_transit');
    for (const wording of ['constructor', 'toString', 'Appointment-', 'Delivered Signature-J SMITH', 'Picked']) {
      expect(oakHarborMappedStage(wording), wording).toBeUndefined();
    }
    expect(statusMap.stage('7', 'delivered')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'oak-harbor', description: 'Received from Partner' })).toEqual({ kind: 'mapped', stage: 'accepted' });
  });
});
