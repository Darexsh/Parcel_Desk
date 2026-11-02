import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../app.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { ExpressOneTracker, adapter, expressOneTrackingUrl } from './adapter.js';
import { normalizeExpressOneNumber, parseExpressOne } from './parser.js';
import { expressOneQuiet, expressOneStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '100000000000000000000001';
const OTHER = '100000000000000000000002';
const html = readFileSync(new URL('./fixtures/delivered.html', import.meta.url), 'utf8');
const returned = readFileSync(new URL('./fixtures/returned.html', import.meta.url), 'utf8');
const absent = readFileSync(new URL('./fixtures/not-found.html', import.meta.url), 'utf8');
const edit = (change: (document: ReturnType<typeof load>) => void, body = html) => { const $ = load(body); change($); return $.html(); };
type Scan = readonly [string, string, string, string?];
const row = ([time, code, text, place]: Scan) =>
  `<tr><td width="1">${time}</td><td width="1">${code}</td><td>${text}${place ? ` (${place})` : ''}</td><!--td class="text-right"></td--></tr>`;
const day = (date: string, ...scans: Scan[]) => `<div class="headline"><h5><span>${date}</span></h5></div><table class="table mb-0">${scans.map(row).join('')}</table><br />`;
const history = (...days: string[]) => edit($ => $('div.history').first().html(days.join('')));
const reply = (body = html, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...headers } });
const environment = (fetcher: typeof fetch) => ({ fetcher, env: {}, trawl: null, browserExecutablePath: null, recorder: { step() {}, lookup() {} } });

describe('Express One direct tracking', () => {
  it('reads the scans as wall clocks, newest first, with their codes and places', () => {
    const result = normalizeCarrierResult(parseExpressOne(html, NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Successful delivery', last_update: null, last_update_local: '2026-06-03T14:12:00', expected_delivery: null });
    expect(result.events?.map(event => [event.local_time, event.provider_code, event.description, event.location, event.stage])).toEqual([
      ['2026-06-03T14:12:00', 'D00', 'Successful delivery', undefined, 'delivered'],
      ['2026-06-03T07:21:09', 'OFD', 'Out for delivery', undefined, 'out_for_delivery'],
      ['2026-06-03T06:30:00', 'E82', 'Delivery schedule updated', undefined, undefined],
      ['2026-06-03T05:58:30', 'DEP', 'Arrived at depot', 'Példafalu, HU', 'in_transit'],
      ['2026-06-02T18:05:00', 'DLS', 'Shipment (pan) data uploaded', undefined, 'in_transit'],
      ['2026-06-02T18:04:12', 'OUB', 'Departed central hub', 'Mintaváros, HU', 'in_transit'],
      ['2026-06-02T18:03:41', 'INB', 'Arrived at central hub', 'Mintaváros, HU', 'in_transit'],
      ['2026-06-01T22:10:00', 'PRE', 'Shipping details received, shipment not yet handed over to EXOHU', undefined, 'registered'],
    ]);
    expect(result.events?.every(event => event.time === undefined && (event.stage === undefined || event.stage_source === 'carrier_map'))).toBe(true);
    // The progress rail, the attempt counter and the courier's arrival window stay out.
    expect(JSON.stringify(result)).not.toMatch(/Loaded to delivery tour|attempt|13:00 - 15:00|09:40|extend/i);
  });

  it('files the return leg as returned, in either language', () => {
    const result = parseExpressOne(returned, NUMBER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Sikeres kézbesítés',
      last_update_local: '2026-04-10T11:05:00' });
    expect(result.events?.map(event => [event.provider_code, event.stage])).toEqual([
      ['D00', 'returned'], ['INB', 'returned'], ['DLS', 'returned'], ['OUB', 'in_transit'], ['INB', 'in_transit'], ['V14', 'failed_attempt'],
      ['OFD', 'out_for_delivery'], ['E12', 'failed_attempt'], ['OFD', 'out_for_delivery'], ['OUB', 'in_transit'], ['DLS', 'in_transit'],
      ['INB', 'in_transit'],
    ]);
    expect(result.events?.[1]).toMatchObject({ local_time: '2026-04-09T08:30:12', description: 'Központi raktárba érkezett', location: 'Mintaváros, HU' });
    // The notice beside the history is not read.
    expect(JSON.stringify(result)).not.toContain('Webáruház');
    const swapped = edit($ => {
      $('h5.text-orange').filter((_, node) => $(node).text().includes('Visszaküldés')).text('Return history');
      $('h5.text-orange').filter((_, node) => $(node).text().includes('Kiszállítás történet')).text('Shipment history');
    }, returned);
    expect(parseExpressOne(swapped, NUMBER).current_stage).toBe('returned');
  });

  it('registers a parcel by its data only until a hub scans it', () => {
    const before = parseExpressOne(history(day('01-06-2026', ['10:00:00', 'DLS', 'Shipment (pan) data uploaded'])), NUMBER);
    expect(before).toMatchObject({ status: 'pending', current_stage: 'registered' });
    const after = parseExpressOne(history(day('01-06-2026', ['09:00:00', 'PRE', 'Shipping details received'], ['10:00:00', 'DLS', 'Shipment (pan) data uploaded'],
      ['11:00:00', 'INB', 'Arrived at central hub', 'HU - Mintaváros'], ['11:01:00', 'DLS', 'Shipment (pan) data uploaded'])), NUMBER);
    expect(after.events?.map(event => event.stage)).toEqual(['in_transit', 'in_transit', 'registered', 'registered']);
  });

  it('keeps the stage before a rescheduled day, and leaves an unknown newest code unstaged', () => {
    const quiet = parseExpressOne(history(day('03-06-2026', ['07:00:00', 'OFD', 'Out for delivery'], ['09:00:00', 'E17', 'Delivery date shifted due to time constraint'],
      ['09:30:00', 'E92', "Delivery date changed upon addressee's request, Flexdel"])), NUMBER);
    expect(quiet).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery',
      last_status_text: "Delivery date changed upon addressee's request, Flexdel" });
    expect(quiet.events?.[0]).toEqual({ local_time: '2026-06-03T09:30:00', description: "Delivery date changed upon addressee's request, Flexdel", provider_code: 'E92' });
    const unknown = parseExpressOne(history(day('03-06-2026', ['07:00:00', 'OFD', 'Out for delivery'], ['09:00:00', 'X99', 'Teleported'])), NUMBER);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Teleported' });
    expect(unknown.current_stage).toBeUndefined();
    const weather = parseExpressOne(history(day('03-06-2026', ['07:00:00', 'OFD', 'Out for delivery'], ['15:00:00', 'E05', 'Obstacles of nature'])), NUMBER);
    expect(weather).toMatchObject({ status: 'exception', current_stage: 'failed_attempt' });
  });

  it('orders and dedupes the scans and bounds the history', () => {
    const repeated = parseExpressOne(history(day('03-06-2026', ['07:00:00', 'OFD', 'Out for delivery'], ['07:00:00', 'OFD', 'Out for delivery'],
      ['07:00:00', 'E82', 'Delivery schedule updated']), day('02-06-2026', ['18:00:00', 'INB', 'Arrived at central hub', 'HU - Mintaváros'])), NUMBER);
    expect(repeated.events?.map(event => event.provider_code)).toEqual(['E82', 'OFD', 'INB']);
    expect(repeated.current_stage).toBe('out_for_delivery');
    const scans = (count: number) => Array.from({ length: count }, (_, index) =>
      ['10:00:00', 'INB', `Arrived at central hub ${index}`] as const);
    const long = parseExpressOne(history(day('02-06-2026', ...scans(250))), NUMBER);
    expect(long.events).toHaveLength(200);
    expect(long.events?.[0]?.description).toBe('Arrived at central hub 249');
    expect(() => parseExpressOne(history(day('02-06-2026', ...scans(301))), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('binds the page to the number its language link looks up', () => {
    expect(parseExpressOne(html, ` ${NUMBER.slice(0, 12)} ${NUMBER.slice(12)} `).status).toBe('delivered');
    expect(() => parseExpressOne(edit($ => $('.lang a').attr('href', `https://tracking.expressone.hu/?plc_number=${OTHER}&setlang=hu`)), NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const body of [edit($ => $('.lang a').remove()), edit($ => $('.lang a').attr('href', 'https://tracking.expressone.hu/?setlang=hu')),
      edit($ => $('.lang a').clone().appendTo('.lang')), '<html><body>Karbantartás</body></html>', '']) {
      expect(() => parseExpressOne(body, NUMBER)).toThrowError(expect.objectContaining({ kind: expect.stringMatching(/^(?:indeterminate|schema)$/) }));
    }
  });

  it('takes thirteen- and twenty-four-digit parcel IDs, and nothing else', () => {
    expect(normalizeExpressOneNumber(' 1000 0000 0000 0000 0000 0001 ')).toBe(NUMBER);
    expect(normalizeExpressOneNumber('1000000000001')).toBe('1000000000001');
    expect(expressOneTrackingUrl(NUMBER)).toBe(`https://tracking.expressone.hu/?plc_number=${NUMBER}`);
    for (const number of ['', '100000000000', '10000000000001', '10000000000000000000001', '1000000000000000000000001', 'A00000000000000000000001', 'ABC12345']) {
      expect(() => normalizeExpressOneNumber(number), number).toThrow(InvalidInputError);
    }
  });

  it('reports a parcel absent only on its notice, over the prefilled form, with HTTP 404', () => {
    expect(() => parseExpressOne(absent, NUMBER, 404)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    const hungarian = absent.replace('The requested package is currently unavailable in our system.', 'A keresett csomag jelenleg nem elérhető a rendszerünkben.');
    expect(() => parseExpressOne(hungarian, NUMBER, 404)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    for (const [body, status] of [[absent, 200], [absent.replace('currently unavailable', 'temporarily unavailable'), 404],
      [edit($ => $('.alert-danger').clone().insertAfter('.alert-danger'), absent), 404], [edit($ => $('.alert-danger').remove(), absent), 404],
      [edit($ => $('input#plc_number').attr('value', OTHER), absent), 404], [edit($ => $('input#plc_number').remove(), absent), 404],
      [html, 404], [edit($ => $('div.history').remove()), 200]] as const) {
      expect(() => parseExpressOne(body, NUMBER, status)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseExpressOne(history(), NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects malformed scans and history blocks', () => {
    for (const body of [history(day('30-02-2026', ['10:00:00', 'INB', 'Arrived'])), history(day('2026.06.02', ['10:00:00', 'INB', 'Arrived'])),
      history(day('02-06-2026', ['25:00:00', 'INB', 'Arrived'])), history(day('02-06-2026', ['10:00:00', '', 'Arrived'])),
      history(day('02-06-2026', ['10:00:00', 'INB', ''])), history(day('02-06-2026', ['10:00:00', 'inbound scan', 'Arrived'])),
      history('<table><tr><td>10:00:00</td><td>INB</td><td>Arrived</td></tr></table>'),
      edit($ => $('h5.text-orange').filter((_, node) => $(node).text().includes('Shipment history')).text('Parcel history')),
      edit($ => $('div.history').first().clone().appendTo('div[class_="hidden"]')),
      edit($ => $('h5.text-orange').filter((_, node) => $(node).text().includes('Kiszállítás történet')).text('Visszaküldés történet'), returned)]) {
      expect(() => parseExpressOne(body, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('maps every recorded code, and the status map answers by code alone', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      if (entry.code === 'DLS') {
        expect(stage).toBeUndefined();
        expect(statusMapAnswer({ carrier: 'express-one', providerCode: 'DLS', description: entry.wording })).toEqual({ kind: 'unknown' });
        continue;
      }
      expect(expressOneStage(entry.code), entry.code).toBe(stage);
      expect(expressOneQuiet(entry.code), entry.code).toBe(stage === undefined);
      expect(statusMapAnswer({ carrier: 'express-one', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual(stage ? { kind: 'mapped', stage } : { kind: 'intentional_gap', note: expect.any(String) });
    }
    // The map reads the code, so earlier and Hungarian wordings answer alike.
    expect(statusMapAnswer({ carrier: 'express-one', providerCode: 'INB', description: 'Hub inbound' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'express-one', providerCode: null, description: 'Successful delivery' })).toEqual({ kind: 'unknown' });
    for (const code of ['constructor', 'toString', 'X99']) expect(expressOneStage(code), code).toBeUndefined();
  });

  it('opens the tracker from its link', () => {
    expect(parseTrackingInput(`https://tracking.expressone.hu/?plc_number=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'express-one', source: 'link' });
  });

  it('asks the tracking page once, in English, with no session, and follows no redirect', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init): Promise<Response> => {
      expect(String(url)).toBe(`https://tracking.expressone.hu/?plc_number=${NUMBER}`);
      expect(init).toMatchObject({ redirect: 'manual' });
      expect(init?.method ?? 'GET').toBe('GET');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.get('user-agent')).toBeTruthy();
      expect(headers.get('accept-language')).toBe('en');
      expect(headers.has('cookie')).toBe(false);
      return reply();
    });
    const instance = adapter(environment(fetcher));
    expect(await instance.track({ number: ` ${NUMBER} `, postcode: 'PRIVATE_SYNTHETIC_POSTCODE' })).toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(instance.track({ number: '12345' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps the HTTP failure taxonomy, retries a failed connection once and bounds bodies', async () => {
    const absentOnce = vi.fn(async () => reply(absent, 404));
    await expect(new ExpressOneTracker({ fetcher: absentOnce as unknown as typeof fetch }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    expect(absentOnce).toHaveBeenCalledTimes(1);
    for (const [body, status, kind] of [['', 302, 'indeterminate'], ['<html>Not Found</html>', 404, 'indeterminate'], [absent, 403, 'challenge'],
      [absent, 429, 'rate_limited'], [absent, 503, 'maintenance'], [absent, 500, 'indeterminate']] as const) {
      const fetcher = vi.fn(async () => reply(body, status, status === 302 ? { Location: '/' } : {})) as unknown as typeof fetch;
      await expect(new ExpressOneTracker({ fetcher }).fetch(NUMBER), String(status)).rejects.toMatchObject({ kind });
    }
    const flaky = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply());
    expect(await new ExpressOneTracker({ fetcher: flaky as unknown as typeof fetch }).fetch(NUMBER)).toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const large = vi.fn(async () => new Response(new Uint8Array(600_000))) as unknown as typeof fetch;
    await expect(new ExpressOneTracker({ fetcher: large }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
  });

  it('recognizes a known parcel and treats only the absent answer as unknown', async () => {
    const known = vi.fn<typeof fetch>(async () => reply());
    const instance = adapter(environment(known));
    expect(await instance.recognize!('12345')).toEqual({ known: false });
    expect(known).not.toHaveBeenCalled();
    // A local clock dates the last activity without an instant.
    expect(await instance.recognize!(NUMBER)).toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-06-03T14:12:00' });
    const unknown = vi.fn(async () => reply(absent, 404));
    expect(await adapter(environment(unknown as unknown as typeof fetch)).recognize!(NUMBER)).toEqual({ known: false });
    const outage = vi.fn(async () => reply('<html>Karbantartás</html>'));
    await expect(adapter(environment(outage as unknown as typeof fetch)).recognize!(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('honors cancellation and the whole-lookup budget', async () => {
    const immediate = vi.fn(async () => reply()) as unknown as typeof fetch;
    await expect(new ExpressOneTracker({ fetcher: immediate }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(Error);
    await expect(new ExpressOneTracker({ fetcher: immediate }).fetch(NUMBER, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    // A request that hangs ends with the budget, retried at most once.
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(new ExpressOneTracker({ fetcher: slow }).fetch(NUMBER, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
