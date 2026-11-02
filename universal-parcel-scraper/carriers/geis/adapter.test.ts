import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../app.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { InvalidInputError, UpstreamNetworkError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { GeisTracker, adapter, geisTrackingUrl } from './adapter.js';
import { geisShipmentNumber, parseGeis } from './parser.js';
import { geisQuiet, geisStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '1234500000017';
const BARCODE = '1234500000017012';
const SLOVAK = '9000000000001';
const html = readFileSync(new URL('./fixtures/delivered.html', import.meta.url), 'utf8');
const transit = readFileSync(new URL('./fixtures/in-transit.html', import.meta.url), 'utf8');
const absent = readFileSync(new URL('./fixtures/not-found.html', import.meta.url), 'utf8');
const absentSlovak = absent.replace(NUMBER, SLOVAK);
const edit = (change: (document: ReturnType<typeof load>) => void, body = html) => { const $ = load(body); change($); return $.html(); };
type Scan = readonly [string, string, string, string, string?];
const row = ([apidate, code, text, country, place]: Scan, index: number) => `<tr data-i='${index}' data-v='8'${apidate ? ` data-apidate='${apidate}'` : ''}>`
  + `<td>01. 02. 2026</td><td>10:00</td><td>${country}</td><td>${place ?? ''}</td><td data-code='${code}'>${text}</td></tr>`;
const history = (...scans: Scan[]) => edit($ => {
  const table = $('section.trace2 .trace211').first().find('table');
  table.find('tr').slice(1).remove();
  table.append(scans.map(row).join(''));
});
const reply = (body = html, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...headers } });
const environment = (fetcher: typeof fetch) => ({ fetcher, env: {}, trawl: null, browserExecutablePath: null, recorder: { step() {}, lookup() {} } });
const czech = (number = NUMBER) => `https://www.geis-group.cz/en/detail-of-cargo?packNumber=${number}`;
const slovak = (number = NUMBER) => `https://www.geis-group.sk/en/detail-of-cargo?packNumber=${number}`;

describe('Geis direct tracking', () => {
  it('reads the history newest first, keeping an offset only where the row\'s country keeps it', () => {
    const result = normalizeCarrierResult(parseGeis(html, NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-01-15T10:42:00', expected_delivery: null, weight_kg: 37.5 });
    // The delivery row names no country, so its clock stays a wall clock.
    expect(result.delivered_at).toBeUndefined();
    expect(result.events?.map(event => [event.time ?? event.local_time, event.provider_code, event.description, event.location, event.stage])).toEqual([
      ['2026-01-15T10:42:00', '70', 'Delivered', 'Musterstadt', 'delivered'],
      ['2026-01-15T08:17:00+01:00', '50', 'Loading to delivery truck', 'Musterstadt, DE', 'out_for_delivery'],
      ['2026-01-15T06:05:00+01:00', '215', 'Delivery scheduled on 2nd tour', 'Musterstadt, DE', 'in_transit'],
      ['2026-01-13T13:00:00', '213', 'Delivery requested on another day', 'Vzorovice', undefined],
      ['2026-01-12T22:31:00+01:00', '40', 'Arrival to gateway', 'Musterstadt, DE', 'in_transit'],
      ['2026-01-12T17:46:00+01:00', '30', 'Loading to linehaul', 'Beispielhausen, DE', 'in_transit'],
      ['2026-01-12T09:58:00+01:00', '40', 'Arrival to gateway', 'Beispielhausen, DE', 'in_transit'],
      ['2026-01-09T04:12:19+01:00', '30', 'Loading to linehaul', 'Vzorovice, CZ', 'in_transit'],
      ['2026-01-08T16:21:07+01:00', '20', 'Arrived to depot', 'Vzorovice, CZ', 'in_transit'],
      ['2026-01-08T15:33:52+01:00', '10', 'Shipment collected', 'Vzorovice, CZ', 'accepted'],
    ]);
    expect(result.events?.every(event => Boolean(event.time) !== Boolean(event.local_time))).toBe(true);
    // The recipient, the references, the category and the progress rail stay out.
    expect(JSON.stringify(result)).not.toMatch(/Petra|EXAMPLE-REF|Home Delivery|Pick up of shipment|gportal/);
  });

  it('dates a delivery that names its country, and reads a summer history on the summer offset', () => {
    const delivered = parseGeis(edit($ => $('td[data-code="70"]').prevAll().eq(1).text('Germany')), NUMBER);
    expect(delivered).toMatchObject({ delivered_at: '2026-01-15T10:42:00+01:00', last_update: '2026-01-15T10:42:00+01:00' });
    expect(delivered.last_update_local).toBeUndefined();
    const result = parseGeis(transit, SLOVAK);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Arrival to gateway',
      last_update_local: '2026-05-29T19:25:00', weight_kg: 40 });
    expect(result.events?.map(event => [event.time ?? event.local_time, event.provider_code, event.location])).toEqual([
      ['2026-05-29T19:25:00', '40', undefined],
      ['2026-05-28T08:00:00+02:00', '120', 'Vzorová, SK'],
      ['2026-05-27T10:21:15+02:00', '30', 'Vzorová, SK'],
      ['2026-05-26T18:49:07+02:00', '20', 'Vzorová, SK'],
      ['2026-05-26T18:44:55+02:00', '20', 'Vzorová, SK'],
    ]);
  });

  it('keeps a foreign wall clock under the wrong offset as a wall clock', () => {
    const result = parseGeis(history(['', '70', 'Delivered', 'Czech Republic', 'Vzorovice'],
      ['2026-01-31T10:00:00+01:00', '40', 'Arrival to gateway', 'United Kingdom', 'Exampleton'],
      ['2026-01-30T09:00:00+00:00', '30', 'Loading to linehaul', 'United Kingdom', 'Exampleton'],
      ['2026-01-29T09:00:00+01:00', '10', 'Shipment collected', 'Atlantis', 'Nowhere']), NUMBER);
    expect(result.events?.map(event => [event.time ?? event.local_time, event.location])).toEqual([
      // A row without its clock attribute keeps the date and minute the page prints.
      ['2026-02-01T10:00:00', 'Vzorovice, CZ'],
      ['2026-01-31T10:00:00', 'Exampleton, GB'],
      ['2026-01-30T09:00:00Z', 'Exampleton, GB'],
      ['2026-01-29T09:00:00', 'Nowhere, Atlantis'],
    ]);
  });

  it('keeps the stage before a note or a partial delivery, and leaves an unknown newest code unstaged', () => {
    const quiet = parseGeis(history(['2026-02-01T12:00:00+01:00', '76', 'Confirmation of C.O.D. collection', 'Czech Republic', 'Vzorovice'],
      ['2026-02-01T11:00:00+01:00', '71', 'Partial delivery', 'Czech Republic', 'Vzorovice'],
      ['2026-02-01T08:00:00+01:00', '50', 'Loading to delivery truck', 'Czech Republic', 'Vzorovice']), NUMBER);
    expect(quiet).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Confirmation of C.O.D. collection' });
    expect(quiet.events?.[0]).toEqual({ time: '2026-02-01T12:00:00+01:00', description: 'Confirmation of C.O.D. collection', provider_code: '76', location: 'Vzorovice, CZ' });
    const unknown = parseGeis(history(['2026-02-01T12:00:00+01:00', '999', 'Teleported', 'Czech Republic', 'Vzorovice'],
      ['2026-02-01T08:00:00+01:00', '50', 'Loading to delivery truck', 'Czech Republic', 'Vzorovice']), NUMBER);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Teleported' });
    expect(unknown.current_stage).toBeUndefined();
    const refused = parseGeis(history(['2026-02-01T12:00:00+01:00', '176', 'Acceptance refused', 'Czech Republic', 'Vzorovice']), NUMBER);
    expect(refused).toMatchObject({ status: 'exception', current_stage: 'failed_attempt' });
  });

  it('bounds the history', () => {
    const scans = (count: number) => Array.from({ length: count }, (_, index) =>
      [`2026-02-01T10:${String(index % 60).padStart(2, '0')}:00+01:00`, '40', `Arrival to gateway ${index}`, 'Czech Republic', 'Vzorovice'] as const);
    const long = parseGeis(history(...scans(250)), NUMBER);
    expect(long.events).toHaveLength(200);
    expect(() => parseGeis(history(...scans(301)), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('binds the page to the consignment its heading names', () => {
    expect(() => parseGeis(html, '1234500000018')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseGeis(absent, '1234500000018')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const body of [edit($ => $('.karieraheadline').remove()), edit($ => $('.karieraheadline').clone().insertAfter('.karieraheadline')),
      edit($ => $('.karieraheadline h2').text('Zásilka č. 1234500000017')), edit($ => $('.karieraheadline h2').text(`Shipment No. ${NUMBER} and more`)),
      '<html><body>Service unavailable</body></html>', '']) {
      expect(() => parseGeis(body, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('reports a consignment absent only on its notice, without a history', () => {
    expect(() => parseGeis(absent, NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseGeis(absent.replace('was not found', 'is not available'), NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    const withHistory = edit($ => $('.karieraheadline h2').html(`The shipment no. ${NUMBER} was not found<br />or was not handed over for transportation.`));
    expect(() => parseGeis(withHistory, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseGeis(edit($ => $('section.trace2').remove()), NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects malformed rows', () => {
    for (const body of [history(['2026-02-30T10:00:00+01:00', '40', 'Arrival', 'Czech Republic', 'Vzorovice']),
      history(['2026-02-01T10:00:00', '40', 'Arrival', 'Czech Republic', 'Vzorovice']),
      history(['2026-02-01T10:00:00+01:00', '40', '', 'Czech Republic', 'Vzorovice']),
      history(['2026-02-01T10:00:00+01:00', 'arrival scan', 'Arrival', 'Czech Republic', 'Vzorovice']),
      edit($ => $('td[data-code="70"]').prev().remove())]) {
      expect(() => parseGeis(body, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('takes thirteen-digit consignment numbers and the consignment in a label barcode', () => {
    expect(geisShipmentNumber(' 12345 00000 017 ')).toBe(NUMBER);
    expect(geisShipmentNumber(BARCODE)).toBe(NUMBER);
    expect(geisShipmentNumber('1234500000017029')).toBe(NUMBER);
    // The integration manual's example.
    expect(geisShipmentNumber('6130080000005016')).toBe('6130080000005');
    for (const number of ['', '12345000000', '123450000001', '12345000000170', '1234500000017013', '12345000000170120', 'A234500000017', 'ABC12']) {
      expect(() => geisShipmentNumber(number), number).toThrow(InvalidInputError);
    }
    expect(geisTrackingUrl('www.geis-group.cz', NUMBER)).toBe(czech());
  });

  it('maps every recorded status, and the status map answers by number alone', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(geisStage(entry.code), entry.code).toBe(stage);
      expect(geisQuiet(entry.code), entry.code).toBe(stage === undefined);
      expect(statusMapAnswer({ carrier: 'geis', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual(stage ? { kind: 'mapped', stage } : { kind: 'intentional_gap', note: expect.any(String) });
    }
    expect(statusMapAnswer({ carrier: 'geis', providerCode: '10', description: 'Collection of consignment' })).toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'geis', providerCode: null, description: 'Delivered' })).toEqual({ kind: 'unknown' });
    for (const code of ['constructor', 'toString', '999']) expect(geisStage(code), code).toBeUndefined();
  });

  it('opens the tracker from its links', () => {
    for (const link of [`https://www.geis-group.cz/cs/detail-zasilky?packNumber=${NUMBER}`, czech(), slovak(),
      `https://www.geis-group.sk/sk/detail-zasielky?packNumber=${NUMBER}`, `https://www.geis-group.cz/cs/sledovani-zasilky?p=${NUMBER}`,
      `https://www.geis-group.sk/sk/sledovanie-zasielok?p=${NUMBER}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: NUMBER, carrier: 'geis', source: 'link' });
    }
  });

  it('asks the Czech site, then the Slovak one, in English, without a session', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init): Promise<Response> => {
      expect(init).toMatchObject({ redirect: 'manual' });
      expect(init?.method ?? 'GET').toBe('GET');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.get('user-agent')).toBeTruthy();
      expect(headers.has('cookie')).toBe(false);
      return String(url) === slovak(SLOVAK) ? reply(transit) : reply(absentSlovak);
    });
    const instance = adapter(environment(fetcher));
    expect(await instance.track({ number: ` ${SLOVAK} ` })).toMatchObject({ status: 'in_transit' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([czech(SLOVAK), slovak(SLOVAK)]);
    const czechOnly = vi.fn<typeof fetch>(async () => reply());
    const result = await adapter(environment(czechOnly)).track({ number: BARCODE });
    expect(result).toMatchObject({ status: 'delivered', canonical_tracking_number: NUMBER });
    expect(czechOnly.mock.calls.map(([url]) => String(url))).toEqual([czech()]);
    expect((await adapter(environment(czechOnly)).track({ number: NUMBER })).canonical_tracking_number).toBeUndefined();
    await expect(instance.track({ number: '12345' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reports not found only when both sites do, and keeps the HTTP failure taxonomy', async () => {
    const both = vi.fn(async () => reply(absent));
    await expect(new GeisTracker({ fetcher: both as unknown as typeof fetch }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    expect(both).toHaveBeenCalledTimes(2);
    for (const [body, status, kind] of [['', 302, 'indeterminate'], [absent, 403, 'challenge'], [absent, 429, 'rate_limited'],
      [absent, 503, 'maintenance'], [absent, 500, 'indeterminate'], ['<html>Service unavailable</html>', 200, 'indeterminate']] as const) {
      // One site's failure leaves the answer open, whichever site it is.
      for (const failing of [czech(), slovak()]) {
        const fetcher = vi.fn(async (url: string) => String(url) === failing
          ? reply(body, status, status === 302 ? { Location: '/' } : {}) : reply(absent)) as unknown as typeof fetch;
        await expect(new GeisTracker({ fetcher }).fetch(NUMBER), `${status} ${failing}`).rejects.toMatchObject({ kind });
      }
    }
    const czechDown = vi.fn(async (url: string) => {
      if (String(url) === czech(SLOVAK)) throw new TypeError('fetch failed');
      return reply(transit);
    }) as unknown as typeof fetch;
    expect(await new GeisTracker({ fetcher: czechDown }).fetch(SLOVAK)).toMatchObject({ status: 'in_transit' });
    const large = vi.fn(async () => new Response(new Uint8Array(600_000))) as unknown as typeof fetch;
    await expect(new GeisTracker({ fetcher: large }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
  });

  it('tries both sites once more after a failed connection', async () => {
    const flaky = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(absent)).mockResolvedValueOnce(reply());
    expect(await new GeisTracker({ fetcher: flaky as unknown as typeof fetch }).fetch(NUMBER)).toMatchObject({ status: 'delivered' });
    expect(flaky.mock.calls.map(([url]) => String(url))).toEqual([czech(), slovak(), czech()]);
    const down = vi.fn(async () => { throw new TypeError('fetch failed'); });
    await expect(new GeisTracker({ fetcher: down as unknown as typeof fetch }).fetch(NUMBER)).rejects.toBeInstanceOf(UpstreamNetworkError);
    expect(down).toHaveBeenCalledTimes(4);
  });

  it('recognizes a known consignment and treats only both sites\' notice as unknown', async () => {
    const known = vi.fn<typeof fetch>(async () => reply());
    const instance = adapter(environment(known));
    expect(await instance.recognize!('12345')).toEqual({ known: false });
    expect(known).not.toHaveBeenCalled();
    expect(await instance.recognize!(NUMBER)).toEqual({ known: true, lastActivityAt: '2026-01-15T07:17:00.000Z' });
    const unknown = vi.fn(async () => reply(absent));
    expect(await adapter(environment(unknown as unknown as typeof fetch)).recognize!(NUMBER)).toEqual({ known: false });
    const outage = vi.fn(async (url: string) => String(url) === slovak() ? reply('<html>Service unavailable</html>') : reply(absent));
    await expect(adapter(environment(outage as unknown as typeof fetch)).recognize!(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('honors cancellation and the whole-lookup budget', async () => {
    const immediate = vi.fn(async () => reply()) as unknown as typeof fetch;
    await expect(new GeisTracker({ fetcher: immediate }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(Error);
    await expect(new GeisTracker({ fetcher: immediate }).fetch(NUMBER, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(new GeisTracker({ fetcher: slow }).fetch(NUMBER, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(4);
  });
});
