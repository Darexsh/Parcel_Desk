import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, GeodisPlTracker, geodisPlHistoryUrl, geodisPlSearchUrl } from './adapter.js';
import { normalizeGeodisPlNumber, parseGeodisPlHistory, parseGeodisPlSummary } from './parser.js';
import { geodisPlStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'PL1234067890123457';
const OTHER = 'PL1234067890123463';
const UNKNOWN = 'PL9999999999999999';
const LATER = Date.parse('2026-12-01T00:00:00Z');

type Row = Record<string, unknown>;

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const history = (name: string) => JSON.parse(text(`${name}.json`)) as Row[];
const search = (number = NUMBER) => text('search-in-transit.html').replaceAll(NUMBER, number);
const summary = { status: 'Shipment in Line-haul', destinationCountry: 'DE' };
const page = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** The search page, then the history, for every lookup. */
const site = (searchPage: string, rows: unknown) => vi.fn<typeof fetch>().mockImplementation(async (input) =>
  (String(input).includes('ltlHistory=') ? json(rows) : page(searchPage)));

describe('GEODIS Poland HTTP adapter', () => {
  it('reads the search page and then the history for the whole number, through the supplied transport', async () => {
    const fetcher = site(search(), history('history-in-transit'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new GeodisPlTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' pl 1234-0678-9012-3457 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit', destination_country: 'DE' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[searchUrl, searchInit], [historyUrl, historyInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(searchUrl).toBe(`https://strefaklienta.pekaes.geodis.pl/en/?ShNumber=${NUMBER}`);
    expect(historyUrl).toBe(`https://strefaklienta.pekaes.geodis.pl/en/?ltlHistory=${NUMBER}`);
    expect(searchInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'Accept-Language': 'en', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(historyInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'SyntheticHost/1.0' } });
    // No session, cookie or form token is sent.
    expect(JSON.stringify([searchInit.headers, historyInit.headers])).not.toMatch(/cookie|token/i);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'geodis-pl', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
    expect(geodisPlSearchUrl('pl1234067890123457')).toBe(searchUrl);
    expect(geodisPlHistoryUrl(NUMBER)).toBe(historyUrl);
  });

  it('reads the summary rows it needs and never the delivery location', () => {
    expect(parseGeodisPlSummary(search(), NUMBER)).toEqual(summary);
    const result = parseGeodisPlHistory(history('history-in-transit'), parseGeodisPlSummary(search(), NUMBER), LATER);
    expect(JSON.stringify(result)).not.toMatch(/00-000|Exampletown|w przewozie|grouoage/);
  });

  it('dates Polish terminals on Polish time, newest first, with the page’s labels', () => {
    const result = parseGeodisPlHistory(history('history-in-transit'), summary, LATER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Inbound Scan from Line-haul to (Delivery) Terminal', last_update: '2026-01-13T03:26:00+01:00',
      expected_delivery: null, destination_country: 'DE' });
    // The repeated collection row is one scan; two departures at different times stay two.
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.location])).toEqual([
      ['2026-01-13T03:26:00+01:00', '40', 'in_transit', 'KATOWICE'],
      ['2026-01-12T20:31:00+01:00', '30', 'in_transit', 'POZNAŃ'],
      ['2026-01-12T19:47:00+01:00', '30', 'in_transit', 'POZNAŃ'],
      ['2026-01-12T11:05:00+01:00', '20', 'in_transit', 'POZNAŃ'],
      ['2026-01-12T08:14:31+01:00', '10', 'accepted', 'POZNAŃ'],
    ]);
    expect(result.events!.at(-1)!.description).toBe('Received from the sender');
    expect(result.events!.every((event) => event.local_time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result).not.toHaveProperty('summary_only');
  });

  it('drops the delivery a pseudo-scan cancels, keeps a later claim out of the status and never reads remarks', () => {
    const result = parseGeodisPlHistory(history('history-delivered'), summary, LATER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered (SMS)',
      delivered_at: '2026-07-08T11:09:00+02:00', last_update: '2026-07-09T09:30:00+02:00' });
    expect(result.events!.map((event) => [event.provider_code, event.stage, event.stage_source])).toEqual([
      ['500', 'delivered', 'none'], ['90', 'delivered', 'carrier_map'], ['50', 'out_for_delivery', 'carrier_map'],
      ['65', 'failed_attempt', 'carrier_map'], ['50', 'out_for_delivery', 'carrier_map'], ['40', 'in_transit', 'carrier_map'],
      ['30', 'in_transit', 'carrier_map'], ['20', 'in_transit', 'carrier_map'], ['10', 'accepted', 'carrier_map'],
    ]);
    expect(result.events![0]!.description).toBe('Claim Received');
    expect(JSON.stringify(result)).not.toMatch(/Synthetic Signer|TS_REMARKS|Pseudoscan|"100"/);
  });

  it('keeps the wall clock of a terminal abroad and a code the page does not label', () => {
    const rows = history('history-in-transit');
    rows.push({ TS_SCAN: 70, TS_SCAN_TEXT: 'Delivered to the consignee', TS_SCAN_BRANCH: 'CZPRG', TS_SCAN_PLACE: 'PRAHA   ', TS_TIME: '2026-01-14T10:02:00' });
    const result = parseGeodisPlHistory(rows, summary, LATER);
    expect(result.events![0]).toEqual({ local_time: '2026-01-14T10:02:00', description: 'Delivered to the consignee', location: 'PRAHA - CZ',
      provider_code: '70', stage: 'delivered', stage_source: 'wording:language' });
    expect(result).toMatchObject({ status: 'delivered', last_update: null, last_update_local: '2026-01-14T10:02:00' });
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('holds back a scan dated over an hour after the read', () => {
    const result = parseGeodisPlHistory(history('history-delivered'), summary, Date.parse('2026-07-07T07:00:00Z'));
    expect(result).toMatchObject({ current_stage: 'out_for_delivery', last_update: '2026-07-07T07:31:00+02:00' });
  });

  it('answers a shipment without scans with the search page’s status alone', () => {
    for (const rows of [null, []]) {
      expect(parseGeodisPlHistory(rows, summary, LATER)).toMatchObject({ summary_only: true, events: [],
        last_status_text: 'Shipment in Line-haul', status: 'in_transit', current_stage: 'in_transit', destination_country: 'DE' });
    }
    expect(JSON.parse(text('history-none.json'))).toBeNull();
  });

  it('rejects a changed history', () => {
    const changed = (change: (rows: Row[]) => void) => {
      const rows = history('history-in-transit');
      change(rows);
      return rows;
    };
    for (const rows of [
      { rows: [] },
      'rows',
      Array.from({ length: 501 }, () => history('history-in-transit')[0]),
      changed((body) => { body[0] = 'row' as never; }),
      changed((body) => { body[0]!.TS_TIME = '2026-01-12 08:14'; }),
      changed((body) => { body[0]!.TS_TIME = '2026-01-12T24:00:00'; }),
      changed((body) => { delete body[0]!.TS_TIME; }),
      changed((body) => { delete body[0]!.TS_SCAN; }),
      changed((body) => { body[0]!.TS_SCAN = 'X'; }),
      changed((body) => { body[0]!.TS_SCAN_PLACE = ['POZNAŃ']; }),
      changed((body) => { body[0]!.TS_SCAN = '70'; delete body[0]!.TS_SCAN_TEXT; }),
    ]) expect(() => parseGeodisPlHistory(rows, summary, LATER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('names what a history other than rows holds, without its values', () => {
    for (const [reply, kind] of [[false, 'false'], ['rows', 'a string'], [{ rows: [] }, 'an object keyed rows'], [{ 0: {}, 2: {} }, 'an object keyed 0, 2']] as const) {
      expect(() => parseGeodisPlHistory(reply, summary, LATER)).toThrow(`GEODIS Poland returned an invalid history (${kind})`);
    }
  });

  it('binds the search page to the number asked', () => {
    // The page answers another shipment, or links another shipment’s history.
    expect(() => parseGeodisPlSummary(search(OTHER), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseGeodisPlSummary(search().replace(`<dd>${NUMBER} </dd>`, `<dd>${OTHER}</dd>`), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseGeodisPlSummary(search().replace(`data-package-no="${NUMBER}"`, `data-package-no="${OTHER}"`), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A summary in another language, without a status, or repeating a row has changed.
    expect(() => parseGeodisPlSummary(search().replace('<dt>Shipment No.</dt>', '<dt>Przesyłka nr.</dt>'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseGeodisPlSummary(search().replace('<dt>Status</dt>', '<dt>State</dt>'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseGeodisPlSummary(search().replace('<dt>Items Number</dt>', '<dt>Status</dt>'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseGeodisPlSummary(search().replace('DE&nbsp;', ''), NUMBER)).toEqual({ status: 'Shipment in Line-haul' });
  });

  it('keeps an unknown number, a refused one, a moved page, a browser check and a broken reply apart', async () => {
    const lookup = (fetcher: typeof fetch, number = UNKNOWN) => carrier(fetcher).track({ number });
    const notFound = vi.fn<typeof fetch>().mockResolvedValue(page(text('search-not-found.html')));
    await expect(lookup(notFound)).rejects.toMatchObject({ kind: 'not_found' });
    // The unknown-number answer ends the lookup before the history.
    expect(notFound).toHaveBeenCalledTimes(1);
    const refused = text('search-not-found.html').replace('Shipment with such number does not exist', 'Proszę wprowadzić właściwy numer przesyłki.');
    await expect(lookup(vi.fn<typeof fetch>().mockResolvedValue(page(refused)))).rejects.toMatchObject({ kind: 'invalid_input' });
    // A notice for another number, or for an empty search, says nothing about this one.
    await expect(lookup(vi.fn<typeof fetch>().mockResolvedValue(page(text('search-not-found.html'))), OTHER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(vi.fn<typeof fetch>().mockResolvedValue(page(refused.replace(`value="${UNKNOWN}"`, 'value=""')))))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(vi.fn<typeof fetch>().mockResolvedValue(page(text('search-not-found.html').replace(/<p>.*<\/p>/, '')))))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(vi.fn<typeof fetch>().mockResolvedValue(page('', { status: 302, headers: { Location: 'https://strefaklienta.pekaes.geodis.pl/' } }))))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(vi.fn<typeof fetch>().mockResolvedValue(page('<html><title>404</title></html>', { status: 404 }))))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(vi.fn<typeof fetch>().mockResolvedValue(page('<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>'))))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(vi.fn<typeof fetch>().mockResolvedValue(page('<html><title>For Client - PEKAES</title></html>'))))
      .rejects.toMatchObject({ kind: 'schema' });
    const historyAs = (body: string) => vi.fn<typeof fetch>().mockImplementation(async (input) =>
      (String(input).includes('ltlHistory=') ? page(body) : page(search())));
    await expect(lookup(historyAs('<html><title>Just a moment...</title></html>'), NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(historyAs('<html><title>Brak dostępu do wybranej strony - PEKAES</title></html>'), NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(NUMBER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known shipment and the unknown-number answer, and asks nothing for a number GEODIS Poland does not issue', async () => {
    await expect(carrier(site(search(), history('history-in-transit'))).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
    const notFound = vi.fn<typeof fetch>().mockResolvedValue(page(text('search-not-found.html')));
    await expect(carrier(notFound).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(notFound).recognize!('PL123456789012345')).resolves.toEqual({ known: false });
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it('rejects numbers GEODIS Poland does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['PL123456789012345', 'PL12345678901234567', 'LV1234567890123456', '1234567890123456', 'XYZ', 'RR000000005PL']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: NUMBER }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeGeodisPlNumber('pl 1234 0678 9012 3457')).toBe(NUMBER);
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementation(async (input) => (String(input).includes('ltlHistory=') ? json(history('history-in-transit')) : page(search())));
    await expect(carrier(fetcher).track({ number: NUMBER }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: NUMBER }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a number filed under GEODIS Poland to the adapter', async () => {
    const fetcher = site(search(), history('history-delivered'));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: NUMBER, carrier: 'geodis-pl' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'geodis-pl', source: 'geodis-pl', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === geodisPlHistoryUrl(NUMBER))).toBe(true);
  });

  it('reads the number from a link to its customer zone, with or without the language', () => {
    for (const path of ['/', '/en/', '/pl']) {
      expect(parseTrackingInput(`https://strefaklienta.pekaes.geodis.pl${path}?ShNumber=${NUMBER}`), path).toMatchObject({ trackingNumber: NUMBER, carrier: 'geodis-pl' });
    }
    expect(parseTrackingInput(`https://strefaklienta.pekaes.geodis.pl/en/other?ShNumber=${NUMBER}`).carrier).not.toBe('geodis-pl');
  });

  it('keeps its aggregator names apart from GEODIS France', () => {
    for (const name of ['Pekaes', 'PEKAES', 'GeodisPL', 'GEODIS Poland', 'GEODIS Road Network']) expect(carrierIdFromName(name), name).toBe('geodis-pl');
    expect(carrierIdFromName('GEODIS')).toBe('geodis');
  });
});

describe('GEODIS Poland status vocabulary', () => {
  it('records every code the map knows with the stage it gives, and the codes it leaves out on purpose', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(stage);
      if (!stage) {
        expect(statusMapAnswer({ carrier: 'geodis-pl', providerCode: entry.code, description: entry.wording }).kind, entry.wording).toBe('intentional_gap');
      }
    }
    expect(statusMapAnswer({ carrier: 'geodis-pl', providerCode: '100', description: 'Delivered' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'geodis-pl', providerCode: '999', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to the shared wording rules.
    expect(geodisPlStage('999', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(geodisPlStage('999', 'Synthetic note')).toBeNull();
    expect(geodisPlStage('500', 'Claim Received')).toBeNull();
  });
});
