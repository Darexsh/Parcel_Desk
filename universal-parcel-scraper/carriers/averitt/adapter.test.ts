import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, AVERITT_ENDPOINT, AverittTracker } from './adapter.js';
import { parseAveritt } from './parser.js';
import { averittMappedStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '0123056785';
const IN_TRANSIT = '0234567891';
const AGED = '0345678902';
const ABSENT = '0999999990';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
const rows = (result: ReturnType<typeof parseAveritt>) =>
  result.events!.map(event => [event.local_time, event.location, event.description, event.stage]);
// Parties, references and the delivering service center the page names.
const PRIVATE = /EXAMPLE SHIPPER|CONSIGNEE|SAMPLESIGNER|BOLSAMPLE|POSAMPLE|SERVICE CENTER/;

describe('Averitt tracking adapter', () => {
  it('opens the direct tracking link once for the whole PRO number through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new AverittTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` ${DELIVERED.slice(0, 4)}-${DELIVERED.slice(4)} `, { budgetMs: 1000.5 })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://tools.averitt.com/servlet/rsoLTLtrack?Type=PN&Number=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'averitt', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the shipment progression newest first, as wall clocks, with the weight in kilograms and no party or reference', () => {
    const result = parseAveritt(page('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-03-05T09:40:00', expected_delivery: null, weight_kg: 566.99 });
    expect(rows(result)).toEqual([
      ['2026-03-05T09:40:00', 'EXAMPLEVILLE, TN', 'DELIVERED', 'delivered'],
      ['2026-03-05T07:30:00', 'EXAMPLEVILLE, TN', 'OUT FOR DELIVERY', 'out_for_delivery'],
      ['2026-03-04T17:47:00', 'EXAMPLEVILLE, TN', 'AT DESTINATION TERMINAL', 'in_transit'],
      ['2026-03-04T08:02:00', 'EXAMPLEVILLE, TN', 'OUT FOR DELIVERY', 'out_for_delivery'],
      ['2026-03-04T06:15:00', 'EXAMPLEVILLE, TN', 'DESTINATION ARRIVAL', 'in_transit'],
      ['2026-03-03T23:58:00', 'RELAYBURG, AL', 'RELAY DEPARTURE', 'in_transit'],
      ['2026-03-03T02:30:00', 'RELAYBURG, AL', 'RELAY ARRIVAL', 'in_transit'],
      ['2026-03-02T21:12:00', 'SAMPLETOWN, GA', 'ORIGIN DEPARTURE', 'in_transit'],
      ['2026-03-02T13:05:00', 'SAMPLETOWN, GA', 'SHIPMENT PICKED UP', 'accepted'],
    ]);
    expect(result.events!.every(event => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result).not.toHaveProperty('summary_only');
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', IN_TRANSIT], ['aged', AGED]] as const) {
      expect(JSON.stringify(parseAveritt(page(name), number)), name).not.toMatch(PRIVATE);
    }
    // The page's own order is kept when it lists the newest first, and a row it repeats appears once.
    const body = page('delivered');
    const table = /<tbody>([\s\S]*?)<\/tbody>/.exec(body)![1]!;
    const listed = table.split('</tr>').slice(0, -1).map(row => `${row}</tr>`);
    const reversed = parseAveritt(body.replace(table, `${[...listed].reverse().join('')}${listed.at(-1)}\n`), DELIVERED);
    expect(reversed.events).toEqual(result.events);
  });

  it('follows the newest row past a status the page has not moved on, and keeps its own status for a delivery', () => {
    const result = parseAveritt(page('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'RELAY ARRIVAL', last_update_local: '2026-04-14T03:07:00', weight_kg: 217.724 });
    expect(rows(result)).toEqual([
      ['2026-04-14T03:07:00', 'RELAYBURG, AL', 'RELAY ARRIVAL', 'in_transit'],
      ['2026-04-13T22:41:00', 'SAMPLETOWN, GA', 'ORIGIN DEPARTURE', 'in_transit'],
      ['2026-04-13T15:20:00', 'SAMPLETOWN, GA', 'SHIPMENT PICKED UP', 'accepted'],
    ]);
    // A delivery the page reports before its row comes in counts.
    const ahead = parseAveritt(page('in-transit').replace('Picked Up</p>', 'Delivered</p>'), IN_TRANSIT);
    expect(ahead).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered' });
  });

  it('reads an older shipment from its pickup and delivery details once the page drops its rows', () => {
    const result = parseAveritt(page('aged'), AGED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      last_update_local: '2025-06-12T10:08:00', summary_only: true, weight_kg: 2739.698 });
    expect(rows(result)).toEqual([
      ['2025-06-12T10:08:00', 'EXAMPLEVILLE, TN', 'Delivered', 'delivered'],
      ['2025-06-10T14:50:00', 'SAMPLETOWN, GA', 'Picked Up', 'accepted'],
    ]);
    // The delivery details count only on a delivered shipment.
    const moving = parseAveritt(page('aged').replace('Delivered</p>', 'Picked Up</p>'), AGED);
    expect(moving).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'Picked Up', summary_only: true });
    expect(rows(moving)).toEqual([['2025-06-10T14:50:00', 'SAMPLETOWN, GA', 'Picked Up', 'accepted']]);
    // A status without a clock is still the shipment's; nothing at all is no history.
    const undated = page('aged').replace('06/10/2025 2:50 PM', '-');
    expect(parseAveritt(undated.replace('Delivered</p>', 'Picked Up</p>'), AGED)).toMatchObject({ current_stage: 'accepted', events: [] });
    expect(() => parseAveritt(undated.replace(/\s*Delivered<\/p>/, '</p>'), AGED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('stages new wording through the shared rules and keeps the rest visible without a stage', () => {
    const shared = parseAveritt(page('delivered').replace('>DELIVERED<', '>DELIVERED TO RECEIVING DOCK<'), DELIVERED);
    expect(shared.events![0]!.stage).toBe('delivered');
    expect(shared.events![0]!.stage_source).toMatch(/^wording:/);
    const unknown = parseAveritt(page('in-transit').replace('>RELAY ARRIVAL<', '>TRAILER CLOSED<'), IN_TRANSIT);
    expect(unknown).toMatchObject({ current_stage: 'in_transit', last_status_text: 'TRAILER CLOSED' });
    expect(unknown.events![0]).toEqual({ local_time: '2026-04-14T03:07:00', location: 'RELAYBURG, AL', description: 'TRAILER CLOSED' });
    // A blank place, weight or status leaves it out.
    const bare = parseAveritt(page('in-transit').replace(/RELAYBURG, AL<\/td>/, '-</td>').replace('>480.0<', '>-<')
      .replace('Picked Up</p>', '</p>'), IN_TRANSIT);
    expect(bare.events![0]).not.toHaveProperty('location');
    expect(bare).not.toHaveProperty('weight_kg');
    expect(bare).toMatchObject({ current_stage: 'in_transit', last_status_text: 'RELAY ARRIVAL' });
  });

  it('binds the page to the requested PRO number and rejects pages it cannot read', () => {
    expect(() => parseAveritt(page('delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const html of ['<html><body>Maintenance</body></html>',
      page('delivered').replace(`\n\t\t\t\t\t${DELIVERED}</strong>`, '</strong>'),
      page('delivered').replace('PRO Number:', 'Order Number:'),
      page('delivered').replace('<p class="h1">', '<p class="h1">Delivered</p><p class="h1">'),
      page('delivered').replace('<li class="ae-result-list--item">', '<li class="ae-result-list--item"><span class="ae-result-list--item-label">PRO Number:</span></li><li class="ae-result-list--item">'),
      page('delivered').replace('03/04/2026 6:15 AM', '03/04/2026 13:15 AM'),
      page('delivered').replace('03/04/2026 6:15 AM', '02/30/2026 6:15 AM'),
      page('delivered').replace('03/04/2026 6:15 AM', 'Wed Mar 04 06:15:00 CST 2026'),
      page('delivered').replace('<td data-title="Status">RELAY ARRIVAL</td>', '<td data-title="Status"></td>'),
      page('delivered').replace('<td data-title="Status">RELAY ARRIVAL</td>', ''),
      page('delivered').replace('id="shipment-progression"', 'id="progression"'),
      page('delivered').replace(/<table class="data display-tag-data">[\s\S]*<\/table>/, '')]) {
      expect(() => parseAveritt(html, DELIVERED), html.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const many = page('delivered').replace('<tbody>', `<tbody>${Array.from({ length: 501 }, (_, minute) =>
      `<tr><td data-title="Location">RELAYBURG, AL</td><td data-title="Date/Time">03/03/2026 ${1 + Math.floor(minute / 60) % 12}:${
        String(minute % 60).padStart(2, '0')} AM</td><td data-title="Status">RELAY ARRIVAL</td></tr>`).join('')}`);
    expect(() => parseAveritt(many, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads only the results page’s notice as a missing shipment, and a block page as a challenge', () => {
    expect(() => parseAveritt(page('not-found'), ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseAveritt(page('not-found').replace('Nothing found to display.', '<a name="detailsLink[]" href="#">0999999990</a>'), ABSENT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseAveritt(page('not-found').replace('Nothing found to display.', 'Something went wrong.'), ABSENT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const html of ['<html><head><title>Access Denied</title></head><body>Blocked</body></html>',
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>',
      '<html><body>Request unsuccessful. Incapsula incident ID: 0-0</body></html>']) {
      expect(() => parseAveritt(html, ABSENT)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('takes ten-digit PRO numbers and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['012345678', '01234567851', '012345678X', 'ABCDEFGHIJ', '1Z9999999999999999', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recognizes a known shipment and the not-found notice, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('in-transit'))).mockResolvedValueOnce(reply(page('not-found')))
      .mockResolvedValueOnce(reply(page('aged')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-04-14T03:07:00' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(AGED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2025-06-12T10:08:00' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([[302, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => status === 302
        ? new Response(null, { status, headers: { Location: '/login.jsp' } })
        : reply(status === 500 ? '' : page('not-found'), status));
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps empty pages and oversized replies apart from missing shipments', async () => {
    for (const [body, kind] of [['', 'indeterminate'], ['  ', 'indeterminate'], ['{"status":"Delivered"}', 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
      await expect(carrier(fetcher).recognize!(ABSENT), body.slice(0, 40)).rejects.toMatchObject({ kind });
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

  it('routes a PRO number filed under Averitt to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: DELIVERED, carrier: 'averitt' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'averitt', source: 'averitt', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${AVERITT_ENDPOINT}?`))).toBe(true);
  });
});

describe('Averitt status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(averittMappedStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(entry.stage);
    }
    expect(averittMappedStage('  Relay   ARRIVAL ')).toBe('in_transit');
    for (const wording of ['constructor', 'toString', 'RELAY', 'DELIVERED TO']) {
      expect(averittMappedStage(wording), wording).toBeUndefined();
    }
    expect(statusMap.stage('7', 'delivered')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'averitt', description: 'OUT FOR DELIVERY' })).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
  });
});
