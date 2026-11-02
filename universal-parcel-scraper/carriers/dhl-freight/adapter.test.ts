import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, DHL_FREIGHT_SEARCH, DhlFreightTracker } from './adapter.js';
import { dhlFreightQuery, parseDhlFreight } from './parser.js';
import { dhlFreightStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'SMP-DL-0000001';
const IN_TRANSIT = 'JND00000000000000031';
const UNKNOWN = 'SMP-DL-0000009';
// A synthetic SSCC whose last digit is its GS1 check.
const SSCC = '340000000000000014';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const parse = (html: string, number: string) => parseDhlFreight(html, dhlFreightQuery(number));
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html;charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** The delivered page with its history rows replaced. */
const withRows = (rows: string) => fixture('delivered')
  .replace(/(<table[^>]*id="sendungsHistorieOne">[\s\S]*?Status date<\/th>\s*<\/tr>)[\s\S]*?(<\/table>)/, `$1${rows}$2`);
const row = (status: string, terminal: string, date: string) =>
  `<tr><td>&nbsp;</td><td valign="top">${status}</td><td valign="top"><a href="#">${terminal}</a></td><td valign="top">${date}</td></tr>`;
// F5's answer to a request its firewall turns away.
const REJECTED = '<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Please consult with your administrator.<br><br>Your support ID is: 0000000000000000000</body></html>';

describe('DHL Freight HTTP adapter', () => {
  it('asks ActiveTracing’s English search for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new DhlFreightTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' smp dl 0000001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${DHL_FREIGHT_SEARCH}?autoSearch=true&search=consignmentId&l=EN&a=${DELIVERED}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dhl-freight', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('types a package ID in the package field and an SSCC with its 00', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('in-transit')));
    await carrier(fetcher).track({ number: IN_TRANSIT.toLowerCase() });
    await expect(carrier(fetcher).track({ number: SSCC })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).search)).toEqual([
      `?search=consignmentId&at=package&valuePackageField=${IN_TRANSIT}&focus=search3&searchConsignmentId=track&l=EN`,
      `?search=consignmentId&at=package&valuePackageField=00${SSCC}&focus=search3&searchConsignmentId=track&l=EN`,
    ]);
    expect(dhlFreightQuery('900000002')).toEqual({ number: '900000002', field: 'consignment', value: '900000002' });
    expect(dhlFreightQuery('SMPDL0000002')).toEqual({ number: 'SMPDL0000002', field: 'consignment', value: 'SMP-DL-0000002' });
  });

  it('keeps each terminal’s wall clock, or only its day, newest first', () => {
    const result = parse(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-03-04T14:55:00', expected_delivery: null,
      service_name: 'DHL Road Freight Standard', weight_kg: 1250, destination_country: 'AT' });
    expect(result.events!.map((event) => [event.local_time, event.description, event.location ?? null, event.stage ?? null])).toEqual([
      // The delivery rows name no terminal.
      ['2026-03-04T14:55:00', 'Delivered', null, 'delivered'],
      ['2026-03-04T08:30:00', 'Out for Delivery', null, 'out_for_delivery'],
      ['2026-03-03T06:20:00', 'Received at terminal', 'PROBEDORF, AT', 'in_transit'],
      ['2026-03-02T19:05:00', 'Shipped from terminal', 'MUSTERSTADT, DE', 'in_transit'],
      ['2026-03-02T17:40:00', 'Received at terminal', 'MUSTERSTADT, DE', 'in_transit'],
      ['2026-03-02', 'Collected', 'BEISPIELHEIM, DE', 'accepted'],
      ['2026-03-02T07:15:00', 'Out for Collection', 'MUSTERSTADT, DE', 'registered'],
      ['2026-03-02', 'Consignment created', 'MUSTERSTADT, DE', 'registered'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    // The consignee's town, the IDs, the volume and the package list stay out.
    expect(JSON.stringify(result)).not.toMatch(/ZIELDORF|00012345678|900000001|SMP-DL|JND|1\.2|pallet|captcha/i);
  });

  it('reads a consignment between terminals, asked by one of its packages', () => {
    const result = parse(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Shipped from terminal',
      last_update_local: '2026-03-05T18:10:00', service_name: 'DHL Road Freight Standard', weight_kg: 8 });
    expect(result).not.toHaveProperty('destination_country');
    expect(result.events!.map((event) => event.stage)).toEqual(['in_transit', 'in_transit', 'accepted', 'registered']);
  });

  it('counts a page only when it lists the number asked among the consignment’s IDs, order code or packages', () => {
    for (const number of ['00012345678', '900000001', 'SMPDL0000001', 'smp-dl-0000001', 'JND00000000000000024']) {
      expect(parse(fixture('delivered'), number).current_stage, number).toBe('delivered');
    }
    for (const number of ['900000002', '00012345685', 'SMPDL0000002']) {
      expect(parse(fixture('in-transit'), number).current_stage, number).toBe('in_transit');
    }
    for (const number of ['SMP-DL-0000002', '00012345679', 'JND00000000000000031', SSCC]) {
      expect(() => parse(fixture('delivered'), number), number)
        .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'DHL Freight answered for another consignment' }));
    }
    // An SSCC the page lists without its 00 matches either form.
    const sscc = fixture('in-transit').replace(/JND00000000000000031/g, SSCC);
    expect(parse(sscc, `00${SSCC}`).current_stage).toBe('in_transit');
    expect(parse(sscc, SSCC).current_stage).toBe('in_transit');
  });

  it('keeps a repeated row once and reads a history listed newest first', () => {
    const scans = [row('Collected', 'DE-BEISPIELHEIM', '02.03.2026'), row('Received at terminal', 'DE-MUSTERSTADT', '02.03.2026 17:40'),
      row('Received at terminal', 'DE-MUSTERSTADT', '02.03.2026 17:40'), row('Out for Delivery', '', '03.03.2026 08:30')];
    const oldestFirst = parse(withRows(scans.join('')), DELIVERED);
    expect(oldestFirst.events!.map((event) => event.description)).toEqual(['Out for Delivery', 'Received at terminal', 'Collected']);
    expect(oldestFirst).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    const newestFirst = parse(withRows([...scans].reverse().join('')), DELIVERED);
    expect(newestFirst.events).toEqual(oldestFirst.events);
  });

  it('keeps a row the map does not know, staged by the shared wording rules or not at all', () => {
    const result = parse(withRows(row('Synthetic note', 'DE-MUSTERSTADT', '05.03.2026 10:00')
      + row('Attempted DHL delivery - consignee not met', '', '05.03.2026 11:00')
      + row('Synthetic remark', '', '05.03.2026 12:00')), DELIVERED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: 'Synthetic remark' });
    expect(result.events!.map((event) => event.stage ?? null)).toEqual([null, 'failed_attempt', null]);
    expect(() => parse(withRows(''), DELIVERED)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('reads the search page’s notice for the number it repeats as not found', () => {
    expect(() => parse(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const packageSearch = fixture('not-found').replace(`value="${UNKNOWN}" id="quicksearch_01"`, 'value="" id="quicksearch_01"')
      .replace('name="valuePackageField" maxlength="35" size="20" value=""', `name="valuePackageField" maxlength="35" size="20" value="${IN_TRANSIT}"`);
    expect(() => parse(packageSearch, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The page repeating another number, or no notice at all, is not an answer about this one.
    expect(() => parse(fixture('not-found'), 'SMP-DL-0000008'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'DHL Freight answered for another number' }));
    expect(() => parse(packageSearch, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse(fixture('not-found').replace('There is no consignment matching your search criteria.', ''), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'DHL Freight did not complete the search' }));
  });

  it('rejects a changed page', () => {
    for (const html of [
      '<html><head><title>Active Tracing</title></head><body></body></html>',
      '',
      fixture('delivered').replace('id="sendungsHistorieOne"', ''),
      withRows(row('Delivered', '', '31.02.2026 10:00')),
      withRows(row('Delivered', '', '04.03.2026 24:00')),
      withRows(row('Delivered', '', '2026-03-04 10:00')),
      withRows(row('', 'DE-MUSTERSTADT', '04.03.2026 10:00')),
      withRows('<tr><td>&nbsp;</td><td>Delivered</td><td>04.03.2026 10:00</td></tr>'),
      withRows(row('Received at terminal', 'DE-MUSTERSTADT', '04.03.2026 10:00').repeat(301)),
    ]) {
      expect(() => parse(html, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a refusal, a browser check and a broken page apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The search answers an unknown number with its own page: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: '/DatPublic/datSelection.do' } })).rejects.toMatchObject({ kind: 'transport' });
    // F5 turns a request away with HTTP 200 as well as 403.
    await expect(lookup(REJECTED)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(REJECTED, { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><head><script src="/TSPD/0000?type=7"></script></head><body></body></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>DHL</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries a read that fails to reach ActiveTracing once more', async () => {
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(new DhlFreightTracker({ fetcher, recorder }).fetch(DELIVERED, { budgetMs: 3000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
  });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number DHL Freight does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-04T14:55:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('SMP-0000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers DHL Freight does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['SMP-D-0000001', '0001234567', 'JND0000000000000003', '340000000000000015', 'SAMPLETRACKING', `00${'0'.repeat(63)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('routes a number filed under DHL Freight to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'dhl-freight' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'dhl-freight', source: 'dhl-freight', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(`${DHL_FREIGHT_SEARCH}?`))).toBe(true);
  });
});

describe('DHL Freight status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string }[]) {
      expect(statusMap.stage('', entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(dhlFreightStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'dhl-freight', providerCode: null, description: 'Out for Collection' }))
      .toEqual({ kind: 'mapped', stage: 'registered' });
    expect(statusMapAnswer({ carrier: 'dhl-freight', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A reason the event table does not list keeps its family's stage.
    expect(dhlFreightStage('Not Collected - synthetic reason')).toEqual({ stage: 'registered', source: 'carrier_map' });
    expect(dhlFreightStage('Shipment in warehouse – awaiting delivery appointment.')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(dhlFreightStage('Synthetic note')).toBeNull();
  });
});
