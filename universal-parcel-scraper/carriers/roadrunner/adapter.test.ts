import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ROADRUNNER_ENDPOINT, RoadrunnerTracker } from './adapter.js';
import { normalizeRoadrunnerNumber, parseRoadrunner } from './parser.js';
import { roadrunnerMappedStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '511122233';
const IN_TRANSIT = '522233344';
const UNKNOWN = '533344455';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (result: ReturnType<typeof parseRoadrunner>) =>
  result.events!.map(event => [event.local_time, event.location ?? null, event.description, event.stage ?? null]);
// The parties, their addresses and towns, the map's coordinates, the pickup and bill of lading
// numbers, the weight, the contact details and the forms' token.
const PRIVATE = /SAMPLE SUPPLY|JANE EXAMPLE|EXAMPLE PARTS|TEST HARDWARE|EXAMPLE AVE|TEST ST|SAMPLE RD|FICTION BLVD|SAMPLETON, CA|TESTVILLE, TN|EXAMPLEBURG, CA|0000[1-4]|\d+\.00000\d|5000(?:1111|2222)|SAMPLE-BOL|250|480|example\.com|555-010|SYNTHETIC-TOKEN|Residential|Prepaid/;
const historyRow = (date: string, time: string, status: string) => `<tr>
                                    <td>${date}</td>
                                    <td>${time}</td>
                                    <td>${status}</td>
                                </tr>`;

describe('Roadrunner tracking adapter', () => {
  it('opens the portal’s fragment once for the whole PRO through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new RoadrunnerTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` ${DELIVERED.slice(0, 3)}-${DELIVERED.slice(3)} `, { budgetMs: 1000.5 })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://tools.rrts.com/LTLTrack/TrackingShipment/ShipmentDataTab/${DELIVERED}?appIDEncoded=`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'roadrunner', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the travel history newest first, as wall clocks, with the terminal each row names', () => {
    const result = parseRoadrunner(page('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-03-17T12:07:00', expected_delivery: null,
      service_name: 'Standard Service' });
    expect(rows(result)).toEqual([
      ['2026-03-17T12:07:00', null, 'Delivered', 'delivered'],
      // A trailer closed after the delivery run left.
      ['2026-03-17T08:31:00', null, 'Trailer Closed - ready for dispatch', 'in_transit'],
      ['2026-03-17T08:07:00', 'Testville', 'Shipment out for delivery from Testville', 'out_for_delivery'],
      ['2026-03-17T07:37:00', null, 'Trailer Closed - ready for dispatch', 'in_transit'],
      ['2026-03-15T15:20:00', null, 'Left voicemail message to schedule a delivery appointment.', 'in_transit'],
      ['2026-03-15T05:48:00', 'Testville', 'Trailer unloaded at Testville terminal.', 'in_transit'],
      ['2026-03-15T05:41:00', 'Testville', 'Trailer arrived at Testville terminal.', 'in_transit'],
      ['2026-03-14T20:39:00', 'Midtown', 'Trailer dispatched from Midtown terminal to Testville terminal.', 'in_transit'],
      ['2026-03-14T20:10:00', null, 'Trailer Closed - ready for dispatch', 'in_transit'],
      ['2026-03-14T01:31:00', 'Midtown', 'Trailer unloaded at Midtown terminal.', 'in_transit'],
      ['2026-03-12T18:33:00', 'Midtown', 'Trailer arrived at Midtown terminal.', 'in_transit'],
      ['2026-03-10T18:42:00', 'Exampleburg', 'Trailer dispatched from Exampleburg terminal to Midtown terminal.', 'in_transit'],
      ['2026-03-10T18:38:00', null, 'Trailer Closed - ready for dispatch', 'in_transit'],
      ['2026-03-10T04:50:00', 'Exampleburg', 'Trailer unloaded at Exampleburg terminal.', 'in_transit'],
      ['2026-03-10T01:12:00', 'Exampleburg', 'Trailer arrived at Exampleburg terminal.', 'in_transit'],
      ['2026-03-10T00:08:00', 'Sampleton', 'Trailer dispatched from Sampleton terminal to Exampleburg terminal.', 'in_transit'],
      ['2026-03-09T23:59:00', null, 'Trailer Closed - ready for dispatch', 'in_transit'],
      ['2026-03-09T16:10:00', null, 'Shipment was picked up', 'accepted'],
      ['2026-03-09T14:19:00', null, 'Pickup Request Received.', 'registered'],
    ]);
    expect(result.events!.every(event => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result).not.toHaveProperty('summary_only');
    expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('weight_kg');
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', IN_TRANSIT]] as const) {
      expect(JSON.stringify(parseRoadrunner(page(name), number)), name).not.toMatch(PRIVATE);
    }
    // A list already newest first is kept, and a row the page repeats appears once.
    const body = page('delivered');
    const table = /<th>Status<\/th>\s*<\/tr>\s*<\/thead>\s*<tbody>([\s\S]*?)<\/tbody>/.exec(body)![1]!;
    const listed = table.split('</tr>').slice(0, -1).map(row => `${row}</tr>`);
    const reversed = parseRoadrunner(body.replace(table, `${[...listed].reverse().join('')}${listed[0]}\n`), DELIVERED);
    expect(reversed.events).toEqual(result.events);
    // A second delivery row, as the page shows when the stop is recorded twice, is a scan of its own.
    const twice = parseRoadrunner(body.replace(table, `${table}${historyRow('03/17/2026', '12:30 PM', 'Delivered ')}\n`), DELIVERED);
    expect(rows(twice).slice(0, 2)).toEqual([['2026-03-17T12:30:00', null, 'Delivered', 'delivered'], ['2026-03-17T12:07:00', null, 'Delivered', 'delivered']]);
  });

  it('follows the newest staged row past a status the page has not moved on, and keeps the due date as the estimate', () => {
    const result = parseRoadrunner(page('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Phone Number Not Available', last_update: null, last_update_local: '2026-10-30T15:15:00',
      expected_delivery: '2026-11-02' });
    expect(result).not.toHaveProperty('service_name');
    expect(rows(result)).toEqual([
      // The terminal could not reach the consignee: no movement, so no stage.
      ['2026-10-30T15:15:00', null, 'Phone Number Not Available', null],
      ['2026-10-30T09:20:00', 'Midtown', 'Trailer unloaded at Midtown terminal.', 'in_transit'],
      ['2026-10-30T06:45:00', 'Midtown', 'Trailer arrived at Midtown terminal.', 'in_transit'],
      ['2026-10-28T00:10:00', 'Exampleburg', 'Trailer dispatched from Exampleburg terminal to Midtown terminal.', 'in_transit'],
      ['2026-10-27T23:52:00', null, 'Trailer Closed - ready for dispatch', 'in_transit'],
      ['2026-10-27T14:40:00', null, 'Shipment was picked up', 'accepted'],
      ['2026-10-27T09:05:00', null, 'Pickup Request Received.', 'registered'],
    ]);
    // A delivery the page reports before its row comes in counts, and drops the estimate.
    const ahead = parseRoadrunner(page('in-transit').replace('<h5>Picked Up</h5>', '<h5>Delivered</h5>'), IN_TRANSIT);
    expect(ahead).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', expected_delivery: null });
    // A status the map does not know falls to the shared wording rules, and a blank one leaves the rows to decide.
    const shared = parseRoadrunner(page('in-transit').replace('<h5>Picked Up</h5>', '<h5>Returned to Shipper</h5>'), IN_TRANSIT);
    expect(shared).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'wording:returned' });
    const blank = parseRoadrunner(page('in-transit').replace('<h5>Picked Up</h5>', '<h5></h5>'), IN_TRANSIT);
    expect(blank).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Phone Number Not Available' });
    // Only the pickup rows: the page's status decides.
    const table = /<th>Status<\/th>\s*<\/tr>\s*<\/thead>\s*<tbody>([\s\S]*?)<\/tbody>/.exec(page('in-transit'))![1]!;
    const picked = parseRoadrunner(page('in-transit').replace(table, `${table.split('</tr>').slice(0, 2).join('</tr>')}</tr>\n`), IN_TRANSIT);
    expect(picked).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'Shipment was picked up' });
    // A due date that is not a calendar day is no estimate.
    expect(parseRoadrunner(page('in-transit').replace('<td>11/02/2026</td>', '<td>TBD</td>'), IN_TRANSIT).expected_delivery).toBeNull();
  });

  it('reads the older wording, which names each terminal’s town and state, and a row without a time as its day', () => {
    const table = /<th>Status<\/th>\s*<\/tr>\s*<\/thead>\s*<tbody>([\s\S]*?)<\/tbody>/.exec(page('in-transit'))![1]!;
    const older = [
      historyRow('10/27/2026', '02:40 PM', 'Shipment was picked up'),
      historyRow('10/28/2026', '12:10 AM', 'Trailer dispatched from EXAMPLEBURG, CA to MIDTOWN, TX.'),
      historyRow('10/30/2026', '06:45 AM', 'Trailer arrived at terminal in MIDTOWN, TX'),
      historyRow('10/30/2026', '', 'Trailer unloaded at terminal in MIDTOWN, TX'),
      historyRow('10/30/2026', '10:00 AM', 'Attempting to set Delivery Appointment'),
      historyRow('10/31/2026', '08:00 AM', 'Shipment out for delivery from MIDTOWN, TX'),
      historyRow('10/31/2026', '11:30 AM', 'Shipment delivered to consignee'),
    ].join('\n');
    const result = parseRoadrunner(page('in-transit').replace(table, `\n${older}\n`), IN_TRANSIT);
    expect(rows(result)).toEqual([
      ['2026-10-31T11:30:00', null, 'Shipment delivered to consignee', 'delivered'],
      ['2026-10-31T08:00:00', 'MIDTOWN, TX', 'Shipment out for delivery from MIDTOWN, TX', 'out_for_delivery'],
      ['2026-10-30T10:00:00', null, 'Attempting to set Delivery Appointment', 'in_transit'],
      ['2026-10-30', 'MIDTOWN, TX', 'Trailer unloaded at terminal in MIDTOWN, TX', 'in_transit'],
      ['2026-10-30T06:45:00', 'MIDTOWN, TX', 'Trailer arrived at terminal in MIDTOWN, TX', 'in_transit'],
      ['2026-10-28T00:10:00', 'EXAMPLEBURG, CA', 'Trailer dispatched from EXAMPLEBURG, CA to MIDTOWN, TX.', 'in_transit'],
      ['2026-10-27T14:40:00', null, 'Shipment was picked up', 'accepted'],
    ]);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Shipment delivered to consignee', expected_delivery: null });
  });

  it('stages new wording through the shared rules, keeps the rest visible without a stage and drops a signer', () => {
    const shared = parseRoadrunner(page('delivered').replace('<td>Delivered </td>', '<td>Delivery attempted - consignee closed</td>'), DELIVERED);
    expect(shared.events![0]).toMatchObject({ description: 'Delivery attempted - consignee closed', stage: 'failed_attempt' });
    expect(shared.events![0]!.stage_source).toMatch(/^wording:/);
    const unknown = parseRoadrunner(page('in-transit').replace('Phone Number Not Available', 'Freight inspected'), IN_TRANSIT);
    expect(unknown.events![0]).toEqual({ local_time: '2026-10-30T15:15:00', description: 'Freight inspected' });
    const signed = parseRoadrunner(page('delivered').replace('<td>Delivered </td>', '<td>Delivered - Signed by J EXAMPLE</td>'), DELIVERED);
    expect(signed.events![0]).toMatchObject({ description: 'Delivered', stage: 'delivered' });
    expect(JSON.stringify(signed)).not.toContain('J EXAMPLE');
  });

  it('binds the fragment to the requested PRO and rejects fragments it cannot read', () => {
    expect(() => parseRoadrunner(page('delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The portal finds a shipment by its pickup number too, as it does for an eight-digit number.
    expect(() => parseRoadrunner(page('delivered'), '50001111')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseRoadrunner(page('delivered').replace(`<td>Pro:</td><td>${DELIVERED}</td>`, `<td>Pro:</td><td>${DELIVERED}0</td>`), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // An eight-digit PRO is asked with its leading zero, and the page may show it either way.
    for (const shown of ['011122233', '11122233']) {
      expect(parseRoadrunner(page('delivered').replace(`<td>Pro:</td><td>${DELIVERED}</td>`, `<td>Pro:</td><td>${shown}</td>`), '11122233'))
        .toMatchObject({ status: 'delivered' });
    }
    for (const html of ['<html><body>Maintenance</body></html>',
      page('delivered').replace(`<td>Pro:</td><td>${DELIVERED}</td>`, '<td>Pro:</td><td></td>'),
      page('delivered').replace('<td>Pro:</td>', '<td>Order:</td>'),
      page('delivered').replace('<td>Pickup:</td>', '<td>Pro:</td>'),
      page('delivered').replace('<h5>Shipment Overview</h5>', '<h5>Overview</h5>'),
      page('delivered').replace('<h5>Travel History</h5>', '<h5>History</h5>'),
      page('delivered').replace('<h5 class="text-danger">Shipment Status</h5>', '<h5 class="text-danger">Status</h5>'),
      page('delivered').replace('<th>Status</th>', '<th>Activity</th>'),
      page('delivered').replace('<td>12:07 PM</td>', '<td>12:07</td>'),
      page('delivered').replace('<td>12:07 PM</td>', '<td>13:07 PM</td>'),
      page('delivered').replace(/<td>03\/17\/2026<\/td>(\s*)<td>12:07 PM<\/td>/, '<td>02/30/2026</td>$1<td>12:07 PM</td>'),
      page('delivered').replace(/<td>03\/17\/2026<\/td>(\s*)<td>12:07 PM<\/td>/, '<td>2026-03-17</td>$1<td>12:07 PM</td>'),
      page('delivered').replace('<td>Delivered </td>', '<td></td>'),
      page('delivered').replace('<td>Delivered </td>', '<td>Delivered </td><td>Sample</td>')]) {
      expect(() => parseRoadrunner(html, DELIVERED), html.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const table = /<th>Status<\/th>\s*<\/tr>\s*<\/thead>\s*<tbody>([\s\S]*?)<\/tbody>/.exec(page('delivered'))![1]!;
    expect(() => parseRoadrunner(page('delivered').replace(table, '\n'), DELIVERED)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const many = page('delivered').replace(table, Array.from({ length: 501 }, (_, minute) =>
      historyRow('03/10/2026', `${String(1 + Math.floor(minute / 60) % 12).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')} AM`, 'Trailer Closed - ready for dispatch')).join(''));
    expect(() => parseRoadrunner(many, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads only the portal’s alert for an unknown PRO as a missing shipment, and a block page as a challenge', () => {
    expect(() => parseRoadrunner(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseRoadrunner(page('not-found').replace('Invalid PRO number.', 'Something went wrong.'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseRoadrunner(page('not-found').replace('alert-danger', 'alert-info'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const html of ['<html><head><title>Access Denied</title></head><body>Blocked</body></html>',
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body></body></html>']) {
      expect(() => parseRoadrunner(html, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('takes nine-digit PROs, and eight digits with a leading zero, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['5111222', '5111222334', '51112223X', 'ABCDEFGHI', '1Z9999999999999999', '5'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeRoadrunnerNumber('511 122 233')).toBe(DELIVERED);
    expect(normalizeRoadrunnerNumber('11122233')).toBe('011122233');
  });

  it('recognizes a known shipment and the unknown-PRO alert, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('in-transit'))).mockResolvedValueOnce(reply(page('not-found')))
      .mockResolvedValueOnce(reply(page('delivered')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-10-30T15:15:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    // Another shipment's answer is inconclusive.
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([[302, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => status === 302
        ? new Response(null, { status, headers: { Location: '/LTLTrack/' } })
        : reply(status === 500 ? '' : page('not-found'), status));
      await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(UNKNOWN)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps empty replies and oversized ones apart from missing shipments', async () => {
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

  it('routes a PRO filed under Roadrunner to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: DELIVERED, carrier: 'roadrunner' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'roadrunner', source: 'roadrunner', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${ROADRUNNER_ENDPOINT}/`))).toBe(true);
  });
});

describe('Roadrunner numbers', () => {
  it('leaves nine digits unclaimed', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN]) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('roadrunner');
    }
  });
});

describe('Roadrunner status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(roadrunnerMappedStage(entry.wording), entry.wording).toBe((entry as { stage?: string }).stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe((entry as { stage?: string }).stage);
    }
    expect(roadrunnerMappedStage('  Trailer   CLOSED - ready for dispatch ')).toBe('in_transit');
    for (const wording of ['constructor', 'toString', 'Trailer', 'Shipment out for delivery tomorrow', 'Delivered to terminal']) {
      expect(roadrunnerMappedStage(wording), wording).toBeUndefined();
    }
    expect(statusMap.stage('DEL', 'shipment delivered to consignee')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'roadrunner', description: 'Shipment was picked up' })).toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'roadrunner', description: 'Phone Number Not Available' }))
      .toEqual({ kind: 'intentional_gap', note: expect.any(String) });
  });
});
