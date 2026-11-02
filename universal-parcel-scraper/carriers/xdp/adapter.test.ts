import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../app.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { InputRequiredError, InvalidInputError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { XdpTracker, adapter, xdpTrackingUrl } from './adapter.js';
import { normalizeXdpNumber, normalizeXdpPostcode, parseXdp } from './parser.js';
import { xdpStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'ZDBQQQ000001';
const RETURNED = 'ZDBQQQ000002';
const UNKNOWN = 'ZDBQQQ999999';
const POSTCODE = 'ZZ99 9ZZ';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = fixture('delivered');
const returned = fixture('returned');
const absent = fixture('not-found');
const ask = fixture('postcode');
const edit = (change: (document: ReturnType<typeof load>) => void, body = html) => { const $ = load(body); change($); return $.html(); };
type Scan = readonly [string, string, string, string];
const row = ([time, barcode, type, data]: Scan) =>
  `<div class="xdp_content"><table><tr><td style="color:#ebb84e">${time}</td><td>${barcode}</td><td>101</td><td>${type}</td><td>${data}</td></tr></table></div>`;
// Rows newest first, as the page lists them, after the header.
const history = (...scans: Scan[]) => edit($ => {
  $('#leftCol tr').slice(1).closest('div.xdp_content').remove();
  $('#leftCol').append(scans.map(row).join(''));
});
const at = (day: string, clock: string) => `${day}<br />${clock}`;
const reply = (body = html, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...headers } });
const environment = (fetcher: typeof fetch) => ({ fetcher, env: {}, trawl: null, browserExecutablePath: null, recorder: { step() {}, lookup() {} } });

describe('XDP direct tracking', () => {
  it('reads the scans as wall clocks, newest first, with their types, weight and service', () => {
    const result = normalizeCarrierResult(parseXdp(html, NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-03-04T13:42:00', expected_delivery: null,
      weight_kg: 12.5, service_name: 'ECON' });
    expect(result.events?.map(event => [event.local_time, event.provider_code, event.description, event.stage])).toEqual([
      ['2026-03-04T13:42:00', 'DELIVERED', 'Delivered', 'delivered'],
      ['2026-03-04T13:29:00', 'NEXT STOP', 'Next stop: Late by 4 minutes', 'out_for_delivery'],
      ['2026-03-04T08:05:00', 'DELIVERY', 'Scheduled for Delivery - Route 07 - ETA: 11:25am to 1:25pm', 'out_for_delivery'],
      ['2026-03-04T07:10:00', 'DELIVERY', 'Allocated to Delivery Vehicle - Route 07', 'in_transit'],
      ['2026-03-04T05:12:00', 'DELIVERY', 'At Delivery Depot', 'in_transit'],
      ['2026-03-03T20:58:00', 'COLLECT', 'At Collection Depot', 'accepted'],
      ['2026-03-02T00:20:00', 'CREATE', 'Order received', 'registered'],
      ['2026-03-02T00:20:00', 'PRINT', 'Label printed', undefined],
    ]);
    expect(result.events?.every(event => event.time === undefined && event.location === undefined
      && (event.stage === undefined || event.stage_source === 'carrier_map'))).toBe(true);
    // The recipient, the references, the depot and driver codes and the messages XDP sent stay out.
    expect(JSON.stringify(result)).not.toMatch(/Alex Example|Sam Sender|ZZ99|EXAMPLE000001|9001|9Z999Z|\b90[123]\b|alert sent|Manifested|notification/);
  });

  it('files the return leg as returned and counts each scan once for several pieces', () => {
    const result = parseXdp(returned, RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'At Collection Depot',
      last_update_local: '2026-02-11T08:40:00', weight_kg: 60, service_name: 'O/N' });
    expect(result.events?.map(event => [event.provider_code, event.description, event.stage])).toEqual([
      ['COLLECT', 'At Collection Depot', 'returned'],
      ['PRINT', 'Label printed', undefined],
      ['EXCEPTION', 'RETURN LABEL CREATED', 'exception'],
      ['EXCEPTION', 'Return', 'exception'],
      ['NEXT STOP', 'Next stop: Early by an hour', 'out_for_delivery'],
      ['DELIVERY', 'Scheduled for Delivery - Route 12 - ETA: 2:10pm to 4:10pm', 'out_for_delivery'],
      ['DELIVERY', 'At Delivery Depot', 'in_transit'],
      ['COLLECT', 'At Collection Depot', 'accepted'],
      ['CREATE', 'Order received', 'registered'],
      ['PRINT', 'Label printed', undefined],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Robin Sample|Sample Works|SAMPLE1/);
  });

  it('leaves an unknown type unstaged and cuts a name from its wording', () => {
    const result = parseXdp(history([at('5 Mar 2026', '10:00AM'), 'All Barcodes', 'CALLBACK', 'Callback booked by phone sent to Jo Person'],
      [at('5 Mar 2026', '09:00AM'), `${NUMBER}001`, 'DELIVERY', 'Spirit Status: "At Delivery Depot"']), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Callback booked by phone' });
    expect(result.events?.[0]).toEqual({ local_time: '2026-03-05T10:00:00', description: 'Callback booked by phone', provider_code: 'CALLBACK' });
    const unstaged = parseXdp(history([at('5 Mar 2026', '09:00AM'), '', 'DELIVERY', 'Teleported to the moon']), NUMBER);
    expect(unstaged).toMatchObject({ status: 'unknown', last_status_text: 'Teleported to the moon' });
    expect(unstaged.current_stage).toBeUndefined();
  });

  it('reads the 24-hour clock beside its meridiem, and rejects one that disagrees', () => {
    const late = parseXdp(history([at('31 Dec 2025', '23:59PM'), '', 'DELIVERY', 'At Delivery Depot'],
      [at('1 Dec 2025', '00:05AM'), '', 'CREATE', '--'], [at('1 Dec 2025', '12:00PM'), '', 'PRINT', '--']), NUMBER);
    expect(late.events?.map(event => event.local_time)).toEqual(['2025-12-31T23:59:00', '2025-12-01T12:00:00', '2025-12-01T00:05:00']);
    for (const clock of ['08:00PM', '20:00AM', '8:00AM', '24:00PM', '10:61AM', '10:00', '10:00 AM']) {
      expect(() => parseXdp(history([at('5 Mar 2026', clock), '', 'DELIVERY', 'At Delivery Depot']), NUMBER), clock)
        .toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    for (const day of ['30 Feb 2026', '5 March 2026', '2026-03-05', '']) {
      expect(() => parseXdp(history([at(day, '10:00AM'), '', 'DELIVERY', 'At Delivery Depot']), NUMBER), day)
        .toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('binds the page to the whole consignment number', () => {
    expect(parseXdp(html, ' zdbqqq 000001 ').status).toBe('delivered');
    for (const body of [edit($ => $('input#c').attr('value', 'ZDBQQQ000003')),
      history([at('5 Mar 2026', '10:00AM'), 'ZDBQQQ000003001', 'DELIVERY', 'At Delivery Depot']),
      history([at('5 Mar 2026', '10:00AM'), `${NUMBER}001<br /> ZDBQQQ000003002`, 'CREATE', '--']),
      history([at('5 Mar 2026', '10:00AM'), `${NUMBER}0001`, 'DELIVERY', 'At Delivery Depot'])]) {
      expect(() => parseXdp(body, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    // A consignment number that only starts the requested one is another consignment.
    expect(() => parseXdp(html, NUMBER.slice(0, 11))).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const body of [edit($ => $('form#trackform').remove()), edit($ => $('form#trackform').clone().appendTo('#leftCol')),
      '<html><body>Service unavailable</body></html>', '']) {
      expect(() => parseXdp(body, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('takes letter-and-digit consignment numbers without a printed leading zero, and a postcode', () => {
    expect(normalizeXdpNumber(' zdbqqq-000001 ')).toBe(NUMBER);
    expect(normalizeXdpNumber('0ZDBQQQ000001')).toBe(NUMBER);
    expect(normalizeXdpNumber('GB0000000001')).toBe('GB0000000001');
    for (const number of ['', 'ZDBQQQ1', 'ZDBQQQQQQQQQ', 'A'.repeat(19) + '12', 'ZDB/QQQ000001']) {
      expect(() => normalizeXdpNumber(number), number).toThrow(InvalidInputError);
    }
    expect(normalizeXdpPostcode(' zz99  9zz ')).toBe(POSTCODE);
    for (const postcode of ['', '  ', null, undefined]) expect(() => normalizeXdpPostcode(postcode)).toThrow(InputRequiredError);
    for (const postcode of ['ZZ', 'NOPOSTCODE', 'ZZ99_9ZZ']) expect(() => normalizeXdpPostcode(postcode), postcode).toThrow(InvalidInputError);
    expect(xdpTrackingUrl('0zdbqqq000001', 'zz99 9zz')).toBe('https://www.xdp.co.uk/track.php?c=ZDBQQQ000001&code=ZZ99+9ZZ');
  });

  it('reports a consignment absent only on its notice for the number, and asks for a missing postcode', () => {
    expect(() => parseXdp(absent, UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseXdp(ask, UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'input_required' }));
    for (const body of [absent.replace(`number: ${UNKNOWN}`, 'number: ZDBQQQ999998'), absent.replace('Consignment not found', 'Consignment withheld'),
      edit($ => $('#leftCol .xdp_content > p').last().clone().insertAfter($('#leftCol .xdp_content > p').last()), absent),
      edit($ => $('#leftCol .xdp_content > p').remove(), absent)]) {
      expect(() => parseXdp(body, UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseXdp(absent.replace(`value="${UNKNOWN}"`, 'value="ZDBQQQ999998"'), UNKNOWN))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects a changed history and bounds it', () => {
    expect(() => parseXdp(html.replace('>Status Type<', '>Status<'), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const type of ['', 'DELIVERY: DEPOT', 'X'.repeat(41)]) {
      expect(() => parseXdp(history([at('5 Mar 2026', '10:00AM'), '', type, 'At Delivery Depot']), NUMBER), type)
        .toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseXdp(history(), NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    // Messages alone are no history.
    expect(() => parseXdp(history([at('5 Mar 2026', '10:00AM'), 'All Barcodes', 'EMAIL', 'Collect Email alert sent']), NUMBER))
      .toThrowError(expect.objectContaining({ name: 'NoHistoryError' }));
    const scans = (count: number) => Array.from({ length: count }, (_, index) =>
      [at('5 Mar 2026', '10:00AM'), '', 'DELIVERY', `At Delivery Depot ${index}`] as const);
    expect(parseXdp(history(...scans(250)), NUMBER).events).toHaveLength(200);
    expect(() => parseXdp(history(...scans(501)), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('maps every recorded type and wording, and the status map answers by them', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(xdpStage(entry.code, entry.wording), entry.code).toBe(stage);
      expect(statusMapAnswer({ carrier: 'xdp', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual(stage ? { kind: 'mapped', stage } : { kind: 'intentional_gap', note: expect.any(String) });
    }
    expect(statusMapAnswer({ carrier: 'xdp', providerCode: 'DELIVERY', description: 'Scheduled for Delivery - Route 40 - ETA: 9:00am to 11:00am' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'xdp', providerCode: 'DELIVERY', description: 'Delivery attempted' })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'xdp', providerCode: null, description: 'Delivered' })).toEqual({ kind: 'unknown' });
    for (const code of ['constructor', 'toString', 'EMAIL']) expect(xdpStage(code, ''), code).toBeUndefined();
  });

  it('opens the tracker from its links', () => {
    expect(parseTrackingInput(`https://xdp.co.uk/track/${NUMBER}`)).toMatchObject({ trackingNumber: NUMBER, carrier: 'xdp', source: 'link' });
    expect(parseTrackingInput(`https://www.xdp.co.uk/track.php?c=${NUMBER}&code=ZZ99+9ZZ`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'xdp', source: 'link' });
  });

  it('asks the tracker once with the number and postcode, follows no redirect, and needs the postcode', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init): Promise<Response> => {
      expect(String(url)).toBe(`https://www.xdp.co.uk/track.php?c=${NUMBER}&code=ZZ99+9ZZ`);
      expect(init).toMatchObject({ redirect: 'manual' });
      expect(init?.method ?? 'GET').toBe('GET');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.get('user-agent')).toBeTruthy();
      expect(headers.has('cookie')).toBe(false);
      return reply();
    });
    const instance = adapter(environment(fetcher));
    expect(instance.recognize).toBeUndefined();
    expect(await instance.track({ number: ` ${NUMBER} `, postcode: 'zz99 9zz' })).toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    // Without a postcode other sources answer; nothing is asked of XDP.
    await expect(instance.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'input_required' });
    await expect(instance.track({ number: NUMBER, postcode: null })).rejects.toMatchObject({ kind: 'input_required' });
    await expect(instance.track({ number: '12345', postcode: POSTCODE })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps the HTTP failure taxonomy, retries a failed connection once and bounds bodies', async () => {
    const absentOnce = vi.fn(async () => reply(absent.replaceAll(UNKNOWN, NUMBER)));
    await expect(new XdpTracker({ fetcher: absentOnce as unknown as typeof fetch }).fetch(NUMBER, POSTCODE)).rejects.toMatchObject({ kind: 'not_found' });
    expect(absentOnce).toHaveBeenCalledTimes(1);
    for (const [body, status, kind] of [['', 302, 'indeterminate'], ['<html>Not Found</html>', 404, 'indeterminate'], [html, 403, 'challenge'],
      [html, 429, 'rate_limited'], [html, 503, 'maintenance'], [html, 500, 'indeterminate']] as const) {
      const fetcher = vi.fn(async () => reply(body, status, status === 302 ? { Location: '/' } : {})) as unknown as typeof fetch;
      await expect(new XdpTracker({ fetcher }).fetch(NUMBER, POSTCODE), String(status)).rejects.toMatchObject({ kind });
    }
    const flaky = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply());
    expect(await new XdpTracker({ fetcher: flaky as unknown as typeof fetch }).fetch(NUMBER, POSTCODE)).toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const large = vi.fn(async () => new Response(new Uint8Array(1_100_000))) as unknown as typeof fetch;
    await expect(new XdpTracker({ fetcher: large }).fetch(NUMBER, POSTCODE)).rejects.toThrow('unexpectedly large');
  });

  it('honors cancellation and the whole-lookup budget', async () => {
    const immediate = vi.fn(async () => reply()) as unknown as typeof fetch;
    await expect(new XdpTracker({ fetcher: immediate }).fetch(NUMBER, POSTCODE, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(Error);
    await expect(new XdpTracker({ fetcher: immediate }).fetch(NUMBER, POSTCODE, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    // A request that hangs ends with the budget, retried at most once.
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(new XdpTracker({ fetcher: slow }).fetch(NUMBER, POSTCODE, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
