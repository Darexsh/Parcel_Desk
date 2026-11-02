import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, WHISTL_ENDPOINT, WhistlTracker } from './adapter.js';
import { normalizeWhistlNumber, parseWhistl } from './parser.js';
import { statusMap, whistlCodeStage, whistlQuiet, whistlStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const OWN = 'WHI0000GB00000000123';
const FINAL_MILE = '00000000000000000123';
const SHIPMENT = 'TSTREF0000001';
const PARTNER = 'YS000000001GB';
const MULTI = 'TSTREF0000002';
const SECOND = 'TSTPARCEL0002';
const ABSENT = 'WHI9999GB99999999999';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
const rows = (result: ReturnType<typeof parseWhistl>) =>
  result.events!.map(event => [event.local_time, event.description, event.location, event.stage]);
// A row of the page, found by its sub category, for edited copies.
const rowOf = (code: string) => new RegExp(String.raw`\s*<tr class="[^"]*">\s*<td>[^<]*</td>\s*<td>${code}</td>[\s\S]*?</tr>`);
const recode = (html: string, from: string, to: string) => html.replace(`<td>${from}</td>`, `<td>${to}</td>`);
// Details the page shows that the adapter never reads.
const PRIVATE = /SENDER-REF|RECIPIENT-REF|A RECIPIENT|NEIGHBOUR|\b101\b|\b102\b/;

describe('Whistl tracking adapter', () => {
  it('asks the Parcelhub tracker once for the whole reference through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('own')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new WhistlTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' whi 0000 gb 00000000123 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://web.parcelhub.net/Tracking/reference/${OWN}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'whistl', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a parcel on Whistl’s network newest first, as wall clocks, with its final-mile number and no private details', () => {
    const result = parseWhistl(page('own'), OWN);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-06-18T12:43:52', expected_delivery: null,
      service_name: 'Standard Parcel DDU', delivery_tracking_number: FINAL_MILE });
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('canonical_tracking_number');
    // The repeated scan once; notes read as pending.
    expect(rows(result)).toEqual([
      ['2026-06-18T12:43:52', 'Delivered', undefined, 'delivered'],
      ['2026-06-18T07:38:20', 'Shipment is Out for Delivery', undefined, 'out_for_delivery'],
      ['2026-06-16T17:34:00', 'Customs cleared', undefined, 'in_transit'],
      ['2026-06-16T17:33:00', 'Received by carrier', undefined, 'in_transit'],
      ['2026-06-15T11:07:00', 'Shipment Arrived to Destination Hub and Prepared to be Out For Delivery', undefined, 'in_transit'],
      ['2026-06-11T08:26:07', 'Handed over to Delivery Carrier', 'WHISTL TESTPORT', 'in_transit'],
      ['2026-06-10T15:53:05', 'Item receipted and processed by Whistl', 'WHISTL TESTTOWN', 'accepted'],
      ['2026-06-10T15:53:05', 'Item Processed by Whistl - Weight Captured', undefined, 'pending'],
      ['2026-06-10T11:08:10', 'Parcel Created', undefined, 'registered'],
      ['2026-06-10T11:08:10', `Final Mile Tracking Number changed to: ${FINAL_MILE}`, undefined, 'pending'],
      ['2026-06-10T10:08:11', 'Shipment Created', undefined, 'registered'],
    ]);
    expect(result.events!.map(event => event.provider_code)).toContain('with Whistl');
    expect(result.events!.every(event => event.time === undefined)).toBe(true);
    for (const [name, number] of [['own', OWN], ['partner', SHIPMENT], ['partner', PARTNER], ['multi', SECOND]] as const) {
      expect(JSON.stringify(parseWhistl(page(name), number)), name).not.toMatch(PRIVATE);
    }
  });

  it('never reads a signatory, even when the scan names no place or its wording cannot be split', () => {
    const signed = page('own').replace('Shipment is Out for Delivery   ', 'Shipment is Out for Delivery  B COURIER ')
      .replace('Customs cleared   ', 'Customs cleared');
    const result = parseWhistl(signed, OWN);
    expect(rows(result).slice(0, 3).map(([, description]) => description)).toEqual(['Delivered', 'Shipment is Out for Delivery', 'In transit']);
    expect(JSON.stringify(result)).not.toMatch(/B COURIER/);
    const placed = parseWhistl(page('partner').replace('(WHISTL TESTTOWN - 101)  ', '(WHISTL TESTTOWN - 101) C SIGNER '), SHIPMENT);
    expect(JSON.stringify(placed)).not.toMatch(/C SIGNER/);
    expect(rows(placed)[3]).toEqual(['2026-06-18T16:00:00', 'Handed over to Royal Mail', 'WHISTL TESTTOWN', 'in_transit']);
  });

  it('names the carrier a shipment was handed to, and that carrier’s number when it differs from the one asked', () => {
    const shipment = parseWhistl(page('partner'), SHIPMENT);
    expect(shipment).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'DELIVERED - Left as authorised',
      service_name: '(M) LBT NON POD', delivery_carrier: 'royal-mail', delivery_tracking_number: PARTNER });
    expect(shipment).not.toHaveProperty('canonical_tracking_number');
    expect(rows(shipment)).toEqual([
      ['2026-06-19T11:02:00', 'DELIVERED - Left as authorised', undefined, 'delivered'],
      ['2026-06-19T07:15:00', 'Due to be delivered today', undefined, 'out_for_delivery'],
      ['2026-06-18T21:10:00', 'Parcel accepted', undefined, 'in_transit'],
      ['2026-06-18T16:00:00', 'Handed over to Royal Mail', 'WHISTL TESTTOWN', 'in_transit'],
      ['2026-06-18T09:30:00', 'Item receipted by Whistl', 'WHISTL TESTTOWN', 'accepted'],
      ['2026-06-17T14:00:00', 'Shipment Created', undefined, 'registered'],
    ]);
    const parcel = parseWhistl(page('partner'), PARTNER);
    expect(parcel).toMatchObject({ delivery_carrier: 'royal-mail' });
    expect(parcel).not.toHaveProperty('delivery_tracking_number');
    expect(parseWhistl(page('partner').replace('<b>Carrier:</b> Royal Mail', '<b>Carrier:</b> Parcelforce'), SHIPMENT))
      .toMatchObject({ delivery_carrier: 'parcelforce' });
    // A carrier name the catalog cannot place keeps only its number.
    const unnamed = parseWhistl(page('partner').replace('<b>Carrier:</b> Royal Mail', '<b>Carrier:</b> Example Couriers'), SHIPMENT);
    expect(unnamed).toMatchObject({ delivery_tracking_number: PARTNER });
    expect(unnamed).not.toHaveProperty('delivery_carrier');
    expect(parseWhistl(page('partner').replace('<b>Carrier:</b> Royal Mail', '<b>Carrier:</b> InPost'), SHIPMENT))
      .toMatchObject({ delivery_carrier: 'inpost' });
    // Whistl's own parcel asked by its shipment's reference has the parcel's number as its own.
    const byReference = parseWhistl(page('own').replace(`<h3>${OWN}</h3>`, `<h3>${SHIPMENT}</h3>`), SHIPMENT);
    expect(byReference).toMatchObject({ canonical_tracking_number: OWN, delivery_tracking_number: FINAL_MILE });
    const domestic = parseWhistl(page('own').replace(rowOf('Information'), '').replace(rowOf('Information'), ''), OWN);
    expect(domestic).not.toHaveProperty('delivery_tracking_number');
    expect(domestic).not.toHaveProperty('delivery_carrier');
  });

  it('reads one parcel of a shipment of several only by its own number', () => {
    expect(() => parseWhistl(page('multi'), MULTI)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const second = parseWhistl(page('multi'), SECOND);
    expect(second).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', delivery_carrier: 'inpost',
      last_status_text: 'Recipient not available', last_update_local: '2026-06-22T13:20:00' });
    expect(second).not.toHaveProperty('delivery_tracking_number');
    expect(rows(second)).toEqual([
      ['2026-06-22T13:20:00', 'Recipient not available', undefined, 'failed_attempt'],
      ['2026-06-21T09:05:00', 'In Transit with Whistl', undefined, 'accepted'],
      ['2026-06-20T12:00:00', 'Shipment Created', undefined, 'registered'],
    ]);
  });

  it('stages scans by their sub category, in order, and keeps a note from moving the parcel', () => {
    // A delivery once the parcel was sent back reaches its sender.
    const returned = parseWhistl(recode(page('partner'), 'Out for delivery', 'Returned to sender'), SHIPMENT);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned' });
    expect(rows(returned).slice(0, 2).map(([, , , stage]) => stage)).toEqual(['returned', 'returned']);
    // A collection after the parcel moved on is part of its way.
    const collected = parseWhistl(recode(page('partner'), 'In transit', 'Collected'), SHIPMENT);
    expect(rows(collected)[2]).toEqual(['2026-06-18T21:10:00', 'Parcel accepted', undefined, 'in_transit']);
    const noted = parseWhistl(page('own').replace(/<td>Delivered<\/td>(\s*)<td>Delivered<\/td>/, '<td>Information</td>$1<td>Item Weight Changed</td>')
      .replace('Delivered  A RECIPIENT ', 'Item weight updated   '), OWN);
    expect(noted).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Item weight updated',
      last_update_local: '2026-06-18T12:43:52' });
    expect(noted.events![0]).toMatchObject({ provider_code: 'Item Weight Changed', stage: 'pending', stage_source: 'carrier_map' });
    // A sub category the list does not have falls back on the wording.
    const worded = parseWhistl(recode(page('partner'), 'Out for delivery', 'Courier Update').replace('Due to be delivered today   ', 'Out for delivery   '), SHIPMENT);
    expect(worded.events![1]).toMatchObject({ provider_code: 'Courier Update', stage: 'out_for_delivery', stage_source: expect.stringMatching(/^wording:/) });
    const unstaged = parseWhistl(recode(page('partner'), 'Out for delivery', 'Courier Update').replace('Due to be delivered today   ', 'Zone 7   '), SHIPMENT);
    expect(unstaged.events![1]).toMatchObject({ description: 'Zone 7' });
    expect(unstaged.events![1]).not.toHaveProperty('stage');
    // Parcelhub capitalizes some sub categories two ways.
    expect(whistlCodeStage('Processed at hub')).toBe('in_transit');
    expect(whistlCodeStage(' Processed  At Hub ')).toBe('in_transit');
  });

  it('binds the page to the whole requested number and rejects pages it cannot read', () => {
    expect(() => parseWhistl(page('own'), SHIPMENT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseWhistl(page('partner'), 'TSTREF000000')).toThrow(expect.objectContaining({ kind: 'schema' }));
    const card = /\s*<div class="row">\s*<div class="col-md-12">[\s\S]*?<\/tbody>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/;
    for (const html of ['', '<html><body>Maintenance</body></html>',
      page('own').replace('<h3>', '<h3>A</h3><h3>'),
      page('own').replace('Tracking Number:', 'Parcel:'),
      page('own').replace(card, (found: string) => found + found),
      page('not-found').replace('</main>', page('own').match(card)![0] + '</main>'),
      page('own').replace('<td>18/06/2026 12:43:52</td>', '<td>31/02/2026 12:43:52</td>'),
      page('own').replace('<td>18/06/2026 12:43:52</td>', '<td>18/06/2026 25:43:52</td>'),
      page('own').replace('<td>18/06/2026 12:43:52</td>', '<td>2026-06-18 12:43:52</td>'),
      page('own').replace('<td>Out for delivery</td>', '<td></td>'),
      page('own').replace('<td>18/06/2026 12:43:52</td>', '')]) {
      expect(() => parseWhistl(html, OWN), html.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const many = page('own').replace(rowOf('Out for delivery'), (row: string) => row.replace(/18\/06\/2026 07:38:20/, '17/06/2026 07:38:20').repeat(501));
    expect(() => parseWhistl(many, OWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // A shipment without scans yet.
    expect(() => parseWhistl(page('own').replace(/<tbody>[\s\S]*<\/tbody>/, '<tbody></tbody>'), OWN))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
    expect(() => parseWhistl(page('own').replace(card, ''), OWN)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('reads only the tracker’s not-found heading as a missing shipment', () => {
    expect(() => parseWhistl(page('not-found'), ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseWhistl(page('error'), ABSENT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseWhistl(page('not-found').replace('Unable to find shipment', 'Unable to search'), ABSENT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const html of ['<html><head><title>Request Rejected</title></head><body>The requested URL was rejected.</body></html>',
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>']) {
      expect(() => parseWhistl(html, ABSENT)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('takes references of letters and digits and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'ABCDEF', 'A12', 'WHI-0000/GB', 'ÄB123456', 'A'.repeat(40) + '1']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeWhistlNumber(' ys 000 000 001 gb ')).toBe(PARTNER);
  });

  it('recognizes a known shipment and the not-found heading, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('own'))).mockResolvedValueOnce(reply(page('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(OWN)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-06-18T12:43:52' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[302, 'indeterminate'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => status === 302
        ? new Response(null, { status, headers: { Location: '/' } })
        : reply(status === 500 ? page('error') : page('not-found'), status));
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps the error page, empty pages and oversized replies apart from missing shipments', async () => {
    for (const [body, kind] of [[page('error'), 'indeterminate'], ['', 'indeterminate'], ['  ', 'indeterminate'],
      ['{"shipments":[]}', 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
      await expect(carrier(fetcher).recognize!(ABSENT), body.slice(0, 40)).rejects.toMatchObject({ kind });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(1_100_000)));
    await expect(carrier(large).track({ number: OWN })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(page('own')));
    await expect(carrier(flaky).track({ number: OWN })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(page('own')));
    await expect(carrier(immediate).track({ number: OWN }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: OWN }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: OWN }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a shipment filed under Whistl to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('own')));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: OWN, carrier: 'whistl' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'whistl', source: 'whistl', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(WHISTL_ENDPOINT))).toBe(true);
  });

  it('opens the tracker’s links, with or without a postcode, and is offered by detection only for L and seventeen digits', () => {
    for (const link of [`https://web.parcelhub.net/Tracking/reference/${OWN}`, `https://web.parcelhub.net/tracking/Reference/${OWN}/postcode/ZZ99`,
      `https://despatch.whistl.co.uk/Tracking/reference/${OWN}`, `https://trackmyitem.whistl.co.uk/tracking/${OWN}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: OWN, carrier: 'whistl', source: 'link' });
    }
    // Parcelhub references share no format, so only a chosen carrier or a link asks Whistl about them.
    for (const number of [OWN, SHIPMENT, PARTNER, 'L1234567890123456', 'L123456789012345678', 'LL12345678901234567', '12345678901234567L']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('whistl');
      expect(recognitionAskedCarriers(number), number).not.toContain('whistl');
    }
    // Its own tracker's archived pages, and a parcel it answered, share L and seventeen digits, with no check digit.
    for (const number of ['L12345678901234567', 'l 1234 5678 9012 3456 7']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['whistl'] });
      expect(recognitionAskedCarriers(number), number).toEqual(['whistl']);
    }
  });
});

describe('Whistl status vocabulary', () => {
  it('records every sub category the list knows with the stage the map gives it, and the status map answers by code alone', () => {
    expect(statusMap.gaps).toEqual([]);
    for (const entry of statuses.entries) {
      const quiet = whistlQuiet(entry.code);
      // A quiet sub category reads as pending, which no movement has.
      expect(whistlCodeStage(entry.code), entry.code).toBe(quiet ? undefined : entry.stage);
      expect(entry.stage === 'pending', entry.code).toBe(quiet);
      expect(whistlStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'whistl', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'whistl', providerCode: null, description: 'Delivered' })).toEqual({ kind: 'unknown' });
    for (const code of ['constructor', 'toString', 'Return', 'Delivered elsewhere']) {
      expect(whistlCodeStage(code), code).toBeUndefined();
      expect(whistlQuiet(code), code).toBe(false);
    }
  });
});
