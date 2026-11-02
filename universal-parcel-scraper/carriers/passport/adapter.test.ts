import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PassportTracker, passportTrackingUrl } from './adapter.js';
import { normalizePassportNumber, parsePassport } from './parser.js';
import { passportScanStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'PG10000000001GB';
const TRANSIT = 'PG1000000002AU';
const ABSENT = 'PG9999999999DE';
const S10 = 'RR123456785GB';
const READ_AT = Date.parse('2026-03-10T12:00:00Z');
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const delivered = fixture('delivered');
const transit = fixture('in-transit');
const absent = fixture('not-found');
const edit = (body: string, change: (document: ReturnType<typeof load>) => void) => { const $ = load(body); change($); return $.html(); };
/** The page with its script's shipment changed. */
const shipment = (body: string, change: (data: Record<string, unknown>) => void) => body.replace(/BrandedPage\.initialize\((\{.*\})/, (_, json: string) => {
  const data = JSON.parse(json) as Record<string, unknown>;
  change(data);
  return `BrandedPage.initialize(${JSON.stringify(data)}`;
});
const scan = (message: string, day: string, clock: string, address = '') => `<div class="detail-item"><span class="message">${message}</span>`
  + `<div class="date">${day}<div class="delimiter"></div><div id="time-0" class="time">${clock}</div></div><span class="address">${address}</span></div>`;
/** The delivered page with its history replaced by these rows, newest first. */
const history = (...rows: string[]) => edit(delivered, ($) => {
  $('.history .accordion .tab').slice(1).remove();
  $('.history .tab-content .details').first().html(rows.join(''));
});
const page = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });
const moved = (location: string) => new Response(`Found. Redirecting to ${location}`, { status: 302, headers: { Location: location } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Passport tracking page', () => {
  it('keeps Passport’s own scans on its UTC clock and the partner’s as wall clocks, with the hand-over to the partner', () => {
    const result = normalizeCarrierResult(parsePassport(delivered, DELIVERED, READ_AT));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', last_update: null,
      last_update_local: '2026-03-06T12:22:00', expected_delivery: null, delivery_carrier: 'royal-mail', delivery_tracking_number: S10,
      destination_country: 'GB' });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events?.map((event) => [event.time ?? event.local_time, event.description, event.location, event.stage])).toEqual([
      ['2026-03-06T12:22:00', 'Delivered', 'EXAMPLETOWN DO, GB', 'delivered'],
      ['2026-03-06T08:38:00', 'Out for delivery - package is enroute to delivery. parcel out for delivery', 'EXAMPLETOWN DO, GB', 'out_for_delivery'],
      ['2026-03-05T00:18:00', 'In transit with last mile carrier', 'EXAMPLETOWN MC, GB', 'in_transit'],
      ['2026-03-03T20:06:00Z', 'Shipped from origin processing center', 'EXAMPLEVILLE, IL, US', 'in_transit'],
      ['2026-03-02T18:50:00Z', 'Processed and preparing for export', 'EXAMPLEVILLE, IL, US', 'in_transit'],
      ['2026-03-02T18:50:00Z', 'Received at origin processing center', 'EXAMPLEVILLE, IL, US', 'accepted'],
      ['2026-03-01T15:30:00Z', 'Passport does not have the package yet. your estimated delivery date will be updated once we receive it.', 'EXAMPLEVILLE, IL, US', 'registered'],
      ['2026-03-01T15:10:00Z', 'Shipment details sent to passport', undefined, 'registered'],
      ['2026-03-01T15:10:00Z', 'Thank you, order information received!', undefined, 'registered'],
    ]);
    expect(result.events?.slice(0, 3).every((event) => event.time === undefined)).toBe(true);
    // The recipient's town, the order reference, the merchant and the partner's phone stay out.
    expect(JSON.stringify(result)).not.toMatch(/Exampletown,|Exampleshire|ORDER-0001|example-shop|\+44|Delivery with in-country/);
    expect(deliveryHandoff('passport', DELIVERED, result)).toEqual({ carrier: 'royal-mail', number: S10, basis: 'partner' });
  });

  it('dates the scans after the order across a new year, skips the rows the page estimates and reads the window', () => {
    const result = parsePassport(transit, TRANSIT, Date.parse('2026-01-06T12:00:00Z'));
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_update: '2026-01-06T05:55:00Z', expected_delivery_from: '2026-01-07', expected_delivery: '2026-01-09',
      delivery_tracking_number: '00300000000000000017', destination_country: 'AU' });
    // Parcel Right is DAI Post's Australian brand; Passport converts its clocks to UTC.
    expect(result.delivery_carrier).toBe('dai-post');
    expect(result.events?.map((event) => event.time)).toEqual(['2026-01-06T05:55:00Z', '2026-01-05T22:02:00Z', '2026-01-05T06:58:00Z',
      '2026-01-03T02:30:00Z', '2026-01-02T14:31:00Z', '2025-12-31T18:55:00Z', '2025-12-31T18:55:00Z', '2025-12-29T18:50:00Z',
      '2025-12-29T18:37:00Z', '2025-12-29T18:37:00Z']);
    expect(result.events?.map((event) => event.description)).not.toContain('Scanned at origin processing center');
    expect(result.events?.find((event) => event.description?.startsWith('Your parcel is being checked'))).toMatchObject({ stage: 'customs' });
    // An order without its time dates the scans by the lookup.
    expect(parsePassport(shipment(transit, (data) => { delete data.time_bought; }), TRANSIT, Date.parse('2026-01-06T12:00:00Z')))
      .toMatchObject({ last_update: '2026-01-06T05:55:00Z', expected_delivery: null });
    // A single estimated day, and an estimate under another title, which is not read.
    const day = parsePassport(edit(transit, ($) => $('.delivery-date-block .date-container .div').last().remove()), TRANSIT);
    expect(day).toMatchObject({ expected_delivery: '2026-01-07' });
    expect(day.expected_delivery_from).toBeUndefined();
    expect(parsePassport(edit(transit, ($) => $('.delivery-date-block .title').text('Delayed')), TRANSIT).expected_delivery).toBeNull();
  });

  it('takes a delivery partner only when its name and link agree, and its number only when it differs', () => {
    const uniuni = parsePassport(edit(transit, ($) => {
      $('.last-mile-carrier .name a').text('UniUni');
      $('.last-mile-carrier a').attr('href', `https://www.uniuni.com/tracking/#tracking-detail?no=${TRANSIT}`);
      $('.last-mile-carrier a.tracking-code').text(TRANSIT);
    }), TRANSIT);
    expect(uniuni).toMatchObject({ delivery_carrier: 'uniuni', last_update: '2026-01-06T05:55:00Z' });
    expect(uniuni.delivery_tracking_number).toBeUndefined();
    const mismatched = parsePassport(edit(delivered, ($) => $('.last-mile-carrier .name a').text('UniUni')), DELIVERED, READ_AT);
    expect(mismatched.delivery_carrier).toBeUndefined();
    expect(mismatched.events?.[0]).toMatchObject({ time: '2026-03-06T12:22:00Z' });
    const none = parsePassport(edit(delivered, ($) => $('.last-mile-carrier').remove()), DELIVERED, READ_AT);
    expect(none).not.toHaveProperty('delivery_carrier');
    expect(none).not.toHaveProperty('delivery_tracking_number');
    // A partner the catalog does not know, for an S10 number, leaves the destination's post to try.
    const unnamed = parsePassport(edit(delivered, ($) => {
      $('.last-mile-carrier .name a').text('GB Post');
      $('.last-mile-carrier a').attr('href', 'https://www.example.com/track');
    }), DELIVERED, READ_AT);
    expect(unnamed.delivery_carrier).toBeUndefined();
    expect(deliveryHandoff('passport', DELIVERED, unnamed)).toEqual({ carrier: 'royal-mail', number: S10, basis: 'destination' });
    const routed = parsePassport(edit(delivered, ($) => $('.last-mile-carrier a.tracking-code').first().text('420123459400111000001234567804')),
      DELIVERED, READ_AT);
    expect(routed.delivery_tracking_number).toBe('9400111000001234567804');
  });

  it('reads a receipt after the parcel moved on as transit, and dedupes repeated rows', () => {
    const result = parsePassport(history(
      scan('Consignment received at the PostNL acceptance centre', 'Mar 05', '10:45'),
      scan('Consignment received at the PostNL acceptance centre', 'Mar 05', '10:45'),
      scan('Shipped from origin processing center', 'Mar 03', '20:06', 'EXAMPLEVILLE, CA, US'),
      scan('Received at origin processing center', 'Mar 02', '19:01', 'EXAMPLEVILLE, CA, US'),
      scan('Received at origin processing center', 'Mar 02', '11:53', 'SAMPLEBURG, CA, US'),
    ), DELIVERED, READ_AT);
    expect(result.events?.map((event) => [event.time ?? event.local_time, event.stage])).toEqual([
      ['2026-03-05T10:45:00', 'in_transit'], ['2026-03-03T20:06:00Z', 'in_transit'], ['2026-03-02T19:01:00Z', 'accepted'],
      ['2026-03-02T11:53:00Z', 'accepted'],
    ]);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: null, last_update_local: '2026-03-05T10:45:00' });
    // A bare country and a place with a digit are no scan places; an unknown wording stays unstaged.
    const quiet = parsePassport(history(scan('Teleported', 'Mar 05', '10:45', 'GB'), scan('Shipped from origin processing center', 'Mar 03', '20:06', 'DOCK 4, US')),
      DELIVERED, READ_AT);
    expect(quiet.events).toEqual([{ local_time: '2026-03-05T10:45:00', description: 'Teleported' },
      { time: '2026-03-03T20:06:00Z', description: 'Shipped from origin processing center', stage: 'in_transit', stage_source: 'carrier_map' }]);
    expect(quiet).toMatchObject({ status: 'in_transit', last_status_text: 'Teleported' });
    const rows = Array.from({ length: 120 }, (_, index) => scan(`Item processed ${index}`, 'Mar 05', '10:45'));
    const long = parsePassport(history(...rows), DELIVERED, READ_AT);
    expect(long).toMatchObject({ history_truncated: true });
    expect(long.events).toHaveLength(100);
    expect(() => parsePassport(history(...rows, ...rows, ...rows), DELIVERED, READ_AT)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('counts a page only when its shipment is the number asked for', () => {
    expect(parsePassport(delivered, ` ${DELIVERED.toLowerCase()} `, READ_AT).status).toBe('delivered');
    for (const body of [shipment(delivered, (data) => { data.tracking_code = 'PG10000000009GB'; }), shipment(delivered, (data) => { data.tracking_code = S10; }),
      shipment(delivered, (data) => { delete data.tracking_code; }), delivered.replace(/BrandedPage\.initialize\(\{/, 'BrandedPage.initialize({,'),
      delivered.replace('BrandedPage.convertTimeToLocalTimeZone();', delivered.match(/BrandedPage\.initialize\(.*\);/)![0])]) {
      expect(() => parsePassport(body, DELIVERED, READ_AT)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reports a number missing only on the notice that names it', () => {
    expect(() => parsePassport(absent, ABSENT)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePassport(absent, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const body of [absent.replace('We can\'t find', 'We are looking for'), edit(absent, ($) => $('.tracking-code').remove()),
      edit(absent, ($) => $('.tracking-code').clone().insertAfter('.tracking-code')), '<html><body>Service unavailable</body></html>', '']) {
      expect(() => parsePassport(body, ABSENT)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parsePassport('<html><head><title>Human Verification</title></head><body></body></html>', ABSENT))
      .toThrowError(expect.objectContaining({ kind: 'challenge' }));
  });

  it('rejects an unexpected history and malformed scans', () => {
    expect(() => parsePassport(history(), DELIVERED, READ_AT)).toThrowError(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    for (const body of [edit(delivered, ($) => $('.history').remove()), edit(delivered, ($) => $('.history').addClass('history-old')),
      edit(delivered, ($) => $('.history').clone().appendTo('.tracking-details')),
      history(scan('Delivered', 'Foo 06', '12:22')), history(scan('Delivered', 'Feb 30', '12:22')), history(scan('Delivered', 'Mar 6', '12:22')),
      history(scan('Delivered', 'Mar 06', '24:00')), history(scan('Delivered', 'Mar 06', '12h22')), history(scan('', 'Mar 06', '12:22'))]) {
      expect(() => parsePassport(body, DELIVERED, READ_AT)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('takes Passport’s own numbers, and nothing else', () => {
    expect(normalizePassportNumber(' pg 1000000002 au ')).toBe(TRANSIT);
    expect(normalizePassportNumber(DELIVERED)).toBe(DELIVERED);
    expect(passportTrackingUrl(TRANSIT)).toBe(`https://track.passportglobal.com/${TRANSIT}`);
    for (const number of ['', S10, '00300000000000000017', 'PG100000000AU', 'PG100000000001AU', 'PG1000000002A1', 'PX1000000002AU']) {
      expect(() => normalizePassportNumber(number), number).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
    for (const link of [`https://track.passportglobal.com/${DELIVERED}`, `https://example-shop.passportglobal.com/${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'passport', source: 'link' });
    }
    expect(parseTrackingInput('https://passportglobal.com/track/')).not.toMatchObject({ carrier: 'passport', source: 'link' });
  });
});

describe('Passport HTTP adapter', () => {
  it('follows the tracker to the merchant’s page for the same number, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(moved(`https://example-shop.passportglobal.com/${DELIVERED}`))
      .mockResolvedValueOnce(page(delivered));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PassportTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${DELIVERED} `, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([`https://track.passportglobal.com/${DELIVERED}`,
      `https://example-shop.passportglobal.com/${DELIVERED}`]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
      expect(init?.method ?? 'GET').toBe('GET');
      const headers = new Headers(init?.headers);
      expect(headers.get('user-agent')).toBe('SyntheticHost/1.0');
      expect(headers.get('accept-language')).toBe('en');
      expect(headers.has('cookie')).toBe(false);
    }
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'passport', step: 'direct', outcome: 'ok' }));
  });

  it('reads a page the tracker answers itself, and the unknown-number notice', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page(transit)).mockResolvedValueOnce(page(absent));
    await expect(carrier(fetcher).track({ number: TRANSIT })).resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('follows no redirect but one to Passport’s page for the same number', async () => {
    for (const location of ['https://example.com/PG10000000001GB', `http://example-shop.passportglobal.com/${DELIVERED}`,
      `https://passportglobal.com.example.com/${DELIVERED}`, `https://example-shop.passportglobal.com/${DELIVERED}/`,
      `https://example-shop.passportglobal.com/PG10000000009GB`, `https://example-shop.passportglobal.com/${DELIVERED}?x=1`,
      `https://example-shop.passportglobal.com:8443/${DELIVERED}`, '']) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(location ? moved(location) : new Response('', { status: 302 }));
      await expect(carrier(fetcher).track({ number: DELIVERED }), location).rejects.toMatchObject({ kind: 'indeterminate' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const again = vi.fn<typeof fetch>().mockResolvedValue(moved(`/${DELIVERED}`));
    await expect(carrier(again).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(again).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => page('', status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known shipment and the unknown-number answer, and asks nothing for a number Passport does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page(delivered)).mockResolvedValueOnce(page(absent));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: expect.stringMatching(/-03-03T20:06:00\.000Z$/) });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(S10)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('sends a read that failed to reach Passport once more, bounds the page and ends a hanging read', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(page(transit));
    await expect(carrier(flaky).track({ number: TRANSIT }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const large = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: TRANSIT })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'response_too_large' });
    const hanging = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(hanging).track({ number: TRANSIT }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(hanging.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const unused = vi.fn<typeof fetch>();
    await expect(carrier(unused).track({ number: S10 })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(unused).not.toHaveBeenCalled();
  });

  it('routes a shipment filed under Passport to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => page(transit));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: TRANSIT, carrier: 'passport' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'passport', source: 'passport', result: { current_stage: 'out_for_delivery' } });
  });
});

describe('Passport status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(passportScanStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(entry.stage);
    }
    expect(passportScanStage('Your parcel\'s on its way to you, almost there!')).toBe('out_for_delivery');
    expect(statusMapAnswer({ carrier: 'passport', description: 'Shipped from origin processing center' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'passport', description: 'Delivered' })).toEqual({ kind: 'unknown' });
    expect(statusMap.stage('7', 'delivered')).toBeUndefined();
  });
});
