import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../app.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { adapter, FargoCourierTracker } from './adapter.js';
import { normalizeFargoCourierNumber, parseFargoCourier } from './parser.js';
import { fargoCourierMappedStage, fargoCourierStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'FCLIN00000000';
const OLDER = '0000001';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const delivered = fixture('delivered.html');
const transit = fixture('in-transit.html');
const error = fixture('error.html');
const edit = (change: (document: ReturnType<typeof load>) => void, body = delivered) => { const $ = load(body); change($); return $.html(); };
const row = (code: string, event: string, day: string, clock: string, location: string) =>
  `<tr><td>${code}</td><td>${event}</td><td>${day}</td><td>${clock}</td><td>${location}</td></tr>`;
/** The delivered page with these rows, newest first, as its events. */
const history = (...rows: string[]) => edit($ => $('table.table').last().find('tbody').html(rows.join('')));
const URL_OF = (number: string) => `https://portal.fargocourier.co.ke/track?blank=1&wayBillNumber=${number}`;
const reply = (body = delivered, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...headers } });
const environment = (fetcher: typeof fetch) => ({ fetcher, env: {}, trawl: null, browserExecutablePath: null, recorder: { step() {}, lookup() {} } });

describe('Fargo Courier direct tracking', () => {
  it('reads a delivered waybill on Nairobi clocks, without the invoicing and the people', () => {
    const result = normalizeCarrierResult(parseFargoCourier(delivered, NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Waybill has been PODed', last_update: '2026-03-03T11:20:00+03:00', expected_delivery: null });
    expect(result.last_update_local).toBeUndefined();
    expect(result.events?.map(event => [event.time, event.provider_code, event.description, event.location, event.stage])).toEqual([
      ['2026-03-03T11:20:00+03:00', 'PODCRE', 'Waybill has been PODed', 'HUB', 'delivered'],
      ['2026-03-03T11:18:00+03:00', 'WBLDLV', 'Waybill FCLIN00000000 delivered', 'HUB', 'delivered'],
      ['2026-03-03T08:00:00+03:00', 'WBLALD', 'Waybill allocated to delivery HUB-7 - HUB', 'HUB', 'out_for_delivery'],
      ['2026-03-03T08:00:00+03:00', 'DELCRE', 'Parcel FCG5 scanned onto delivery HUB-7', 'HUB', 'out_for_delivery'],
      // The event's second line joins the first.
      ['2026-03-03T05:30:00+03:00', 'WBLDAL', 'Waybill scanned into Depot from manifest SPL12 SPL to HUB', 'HUB', 'in_transit'],
      ['2026-03-03T02:50:00+03:00', 'WBLLIN', 'Waybill on linehaul for manifest SPL12 SPL to HUB', 'SPL', 'in_transit'],
      ['2026-03-03T02:50:00+03:00', 'WBLLIN', 'Waybill in transit on manifest SPL12 SPL to HUBAAA BBB CCC', 'SPL', 'in_transit'],
      ['2026-03-02T20:10:00+03:00', 'WBLALL', 'Waybill allocated to linehaul SPL12 SPL to HUB', 'SPL', 'in_transit'],
      ['2026-03-02T14:25:00+03:00', 'WBLCRE', 'Waybill created', 'SPL', 'registered'],
    ]);
    expect(result.events?.every(event => event.stage_source === 'carrier_map' && event.local_time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/invoice|Sample Receiver|Sample Shop|Sample Receiving|Sampletown|Sample Fargo Hub|SAMPLE-REF|0700|OVS|0\.50|fwo\.|1015/i);
  });

  it('reads an older seven-digit waybill on its way', () => {
    const result = normalizeCarrierResult(parseFargoCourier(transit, OLDER));
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text:
      'Waybill scanned into Depot from manifest SPL12 SPL to HUB', last_update: '2026-03-03T05:30:00+03:00' });
    expect(result.events?.map(event => event.provider_code)).toEqual(['WBLDAL', 'WBLLIN', 'WBLLIN', 'WBLALL', 'WBLCRE']);
    // A waybill only just created is registered.
    const created = parseFargoCourier(history(row('WBLCRE', 'Waybill created', '02-03-2026', '14:25', 'SPL')), NUMBER);
    expect(created).toMatchObject({ status: 'pending', current_stage: 'registered' });
  });

  it('keeps wall clocks when a scan is not at a branch code', () => {
    const elsewhere = parseFargoCourier(history(row('WBLDAL', 'Waybill received', '03-03-2026', '05:30', 'Sample Agent'),
      row('WBLCRE', 'Waybill created', '02-03-2026', '14:25', 'SPL')), NUMBER);
    expect(elsewhere).toMatchObject({ last_update: null, last_update_local: '2026-03-03T05:30:00' });
    expect(elsewhere.events?.map(event => [event.local_time, event.time])).toEqual([['2026-03-03T05:30:00', undefined], ['2026-03-02T14:25:00', undefined]]);
    const unplaced = parseFargoCourier(history(row('WBLCRE', 'Waybill created', '02-03-2026', '14:25', '')), NUMBER);
    expect(unplaced.events).toEqual([{ local_time: '2026-03-02T14:25:00', description: 'Waybill created', provider_code: 'WBLCRE',
      stage: 'registered', stage_source: 'carrier_map' }]);
  });

  it('binds the page to the whole waybill, in any case', () => {
    expect(parseFargoCourier(edit($ => $('th:contains("Waybill Number")').next('td').text(' : fclin00000000')), NUMBER).status).toBe('delivered');
    expect(parseFargoCourier(delivered, ' fclin 0000 0000 ').status).toBe('delivered');
    // The tracker also finds a waybill by its parcels' labels.
    for (const asked of ['FCLIN00000001', 'FCG0000005', '0000000']) {
      expect(() => parseFargoCourier(delivered, asked), asked).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
    for (const body of [edit($ => $('th:contains("Waybill Number")').closest('tr').remove()),
      edit($ => $('th:contains("Waybill Number")').closest('tr').clone().appendTo($('table').first().find('tbody')))]) {
      expect(() => parseFargoCourier(body, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('takes waybill-shaped numbers only', () => {
    expect(normalizeFargoCourierNumber(' fclin0000-0000 ')).toBe(NUMBER);
    expect(normalizeFargoCourierNumber(OLDER)).toBe(OLDER);
    for (const number of ['', '12345', 'FCLIN', 'FCLIN00000000000', 'ABCDEFG0000000', 'FCLIN0000000A', '0'.repeat(65)]) {
      expect(() => normalizeFargoCourierNumber(number), number).toThrow(InvalidInputError);
    }
  });

  it('reads the error page as inconclusive and a bot check as a challenge', () => {
    expect(() => parseFargoCourier(error, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(() => parseFargoCourier(challenge, NUMBER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    const sucuri = '<html><head><title>Sucuri WebSite Firewall - Access Denied</title></head><body>Access Denied</body></html>';
    expect(() => parseFargoCourier(sucuri, NUMBER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseFargoCourier(history(), NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    // Invoicing alone is no scan.
    expect(() => parseFargoCourier(history(row('WBLINV', 'Waybill FCLIN00000000 invoiced on invoice number 42', '06-04-2026', '09:00', 'HUB')), NUMBER))
      .toThrowError(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('rejects a malformed page and bounds the history', () => {
    for (const body of ['<html><body><p>Fargo Courier</p></body></html>', '',
      history(row('WBLCRE', 'Waybill created', '31-02-2026', '14:25', 'SPL')),
      history(row('WBLCRE', 'Waybill created', '2026-03-02', '14:25', 'SPL')),
      history(row('WBLCRE', 'Waybill created', '02-03-2026', '24:00', 'SPL')),
      history(row('WBLCRE', '', '02-03-2026', '14:25', 'SPL')),
      history('<tr><td>WBLCRE</td><td>Waybill created</td><td>02-03-2026</td><td>14:25</td></tr>'),
      edit($ => $('table.table').last().find('thead th').eq(2).text('Date')),
      edit($ => $('table.table').last().clone().appendTo('.table-responsive')),
      history(...Array.from({ length: 501 }, () => row('WBLLIN', 'Waybill on linehaul', '02-03-2026', '14:25', 'SPL')))]) {
      expect(() => parseFargoCourier(body, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    const long = history(...Array.from({ length: 150 }, (_, index) =>
      row('WBLLIN', `Waybill on linehaul for manifest SPL${index}`, `${String(28 - Math.floor(index / 60)).padStart(2, '0')}-02-2026`,
        `${String(23 - Math.floor((index % 60) / 6)).padStart(2, '0')}:${String(59 - index % 6).padStart(2, '0')}`, 'SPL')));
    const result = parseFargoCourier(long, NUMBER);
    expect(result.events).toHaveLength(100);
    expect(result).toMatchObject({ history_truncated: true, last_update: '2026-02-28T23:59:00+03:00' });
  });

  it('turns an oldest-first page round, merges repeated rows and drops phone numbers', () => {
    const result = parseFargoCourier(history(row('WBLCRE', 'Waybill created', '02-03-2026', '14:25', 'SPL'),
      row('WBLALL', 'Waybill allocated to linehaul SPL12 SPL to HUB', '02-03-2026', '20:10', 'SPL'),
      row('WBLALL', 'Waybill allocated to linehaul SPL12 SPL to HUB', '02-03-2026', '20:10', 'SPL'),
      row('WBLRTS', 'Receiver not available, called +254 700 000 000 .', '03-03-2026', '09:00', 'HUB')), NUMBER);
    // A code without a map entry falls to the wording rules.
    expect(result.events?.map(event => [event.provider_code, event.description, event.stage, event.stage_source])).toEqual([
      ['WBLRTS', 'Receiver not available, called.', 'failed_attempt', expect.stringMatching(/^wording:/)],
      ['WBLALL', 'Waybill allocated to linehaul SPL12 SPL to HUB', 'in_transit', 'carrier_map'],
      ['WBLCRE', 'Waybill created', 'registered', 'carrier_map'],
    ]);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt' });
    // One the rules do not stage either leaves the stage to the events before it.
    const noted = parseFargoCourier(history(row('WBLNOT', 'Waybill noted', '03-03-2026', '09:00', 'HUB'),
      row('WBLALL', 'Waybill allocated to linehaul SPL12 SPL to HUB', '02-03-2026', '20:10', 'SPL')), NUMBER);
    expect(noted).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Waybill noted' });
    expect(noted.events?.[0]).toEqual({ time: '2026-03-03T09:00:00+03:00', location: 'HUB', description: 'Waybill noted', provider_code: 'WBLNOT' });
  });

  it('maps every recorded code, and the status map answers as the parser stages', () => {
    for (const { code, stage, wording } of statuses.entries as { code?: string; stage?: string; wording: string }[]) {
      // The Waybill Status above the proof of delivery stages nothing.
      if (!code) continue;
      expect(fargoCourierMappedStage(code), code).toBe(stage);
      expect(statusMapAnswer({ carrier: 'fargo-courier', providerCode: code, description: wording }))
        .toEqual(stage ? { kind: 'mapped', stage } : { kind: 'unknown' });
    }
    expect(fargoCourierStage('WBLXYZ', 'Waybill delivered')).toMatchObject({ stage: 'delivered' });
    expect(fargoCourierStage('WBLXYZ', 'Waybill noted')).toBeNull();
    for (const code of ['constructor', 'toString']) expect(fargoCourierMappedStage(code), code).toBeUndefined();
  });

  it('detects FCLIN waybills and leaves seven digits to the user', () => {
    expect(detectCarrierMatch(NUMBER).carrier).toBe('fargo-courier');
    expect(detectCarrierMatch(OLDER).carrier).not.toBe('fargo-courier');
  });

  it('asks the tracker the home page frames, with the host User-Agent and the caller signal', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply());
    const instance = adapter({ ...environment(fetcher), userAgent: 'SyntheticAgent/1.0' });
    expect(instance.recognize).toBeUndefined();
    expect(await instance.track({ number: ' fclin00000000 ' })).toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(URL_OF(NUMBER));
    expect(init).toMatchObject({ redirect: 'manual' });
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get('user-agent')).toBe('SyntheticAgent/1.0');
    await expect(instance.track({ number: '12345' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps the HTTP failure taxonomy', async () => {
    for (const [response, kind] of [[() => reply(error, 500), 'indeterminate'], [() => reply('<html><body>Server Error</body></html>', 500), 'indeterminate'],
      [() => reply(delivered.replace(NUMBER, 'FCLIN00000001')), 'indeterminate'], [() => reply('<html><title>Sucuri WebSite Firewall</title></html>', 500), 'challenge'],
      [() => reply('', 302, { Location: 'https://portal.fargocourier.co.ke/login' }), 'transport'], [() => reply('', 404), 'transport'],
      [() => reply('', 410), 'transport'], [() => reply('', 403), 'challenge'], [() => reply('', 429), 'rate_limited'],
      [() => reply('', 503), 'maintenance'], [() => reply('{"error":"changed"}', 200, { 'Content-Type': 'application/json' }), 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>(async () => response());
      await expect(new FargoCourierTracker({ fetcher }).fetch(NUMBER), kind).rejects.toMatchObject({ kind });
      expect(fetcher, kind).toHaveBeenCalledTimes(1);
    }
    const large = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(600_000)));
    await expect(new FargoCourierTracker({ fetcher: large }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
  });

  it('retries a failed connection once, inside the budget, and honors cancellation', async () => {
    let calls = 0;
    const flaky = vi.fn<typeof fetch>(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return reply();
    });
    expect(await new FargoCourierTracker({ fetcher: flaky }).fetch(NUMBER)).toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>(async () => reply());
    await expect(new FargoCourierTracker({ fetcher: immediate }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(Error);
    await expect(new FargoCourierTracker({ fetcher: immediate }).fetch(NUMBER, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(new FargoCourierTracker({ fetcher: slow }).fetch(NUMBER, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
