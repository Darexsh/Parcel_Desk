import { readFileSync } from 'node:fs';
import { load, type CheerioAPI } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TFORCE_FREIGHT_TRACKING, TforceFreightTracker } from './adapter.js';
import { normalizeTforceFreightNumber, parseTforceFreight, parseTforceFreightForm } from './parser.js';
import { statusMap, tforceFreightStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '111111114';
const IN_TRANSIT = '222222221';
const UNKNOWN = '999999991';
const TOKEN = 'SyntheticAntiForgeryToken-0000000000_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789';
const ANTIFORGERY = '__RequestVerificationToken_L2x0bA2';
const NOT_DELIVERED = 'Shipment not delivered. Delivery attempted after normal business hours. Tforce will attempt delivery on next business day we service this area.';
const PRIVATE = /SAMPLE (?:CONSIGNEE|SHIPPER|SIGNER)|SAMPLETOWN|ORIGIN CITY IL|\bSMP\b|\bORG\b|0000000|SAMPLE-PO|SMPL|Appointment|10:00 AM|Pieces/;
// The F5 firewall's JavaScript check, which the site serves with HTTP 200 to clients presenting a browser's User-Agent.
const FIREWALL = '<!DOCTYPE html><html><head><script type="text/javascript">(function(){ window["bobcmn"] = "1011/TSPD/"; })();</script>'
  + '<script src="/TSPD/0000000000000000000000000000000000000000?type=7"></script></head><body></body></html>';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
/** The page with a change made through cheerio. */
const edited = (name: string, edit: ($: CheerioAPI) => void) => {
  const $ = load(fixture(name));
  edit($);
  return $.html();
};
const formPage = (cookies: string[] = [`${ANTIFORGERY}=SyntheticCookie_0-a; path=/ltl; HttpOnly`,
  `${ANTIFORGERY}=SyntheticCookie_0-a; path=/ltl; SameSite=Strict`, 'TS0123abcd=0123456789abcdef; Path=/', 'visitor=sample; Path=/'], body = fixture('form')) =>
  new Response(body, { headers: cookies.map(cookie => ['set-cookie', cookie] as [string, string]) });
/** A transport that serves the search page, then the given result. */
const site = (result: () => Response | Promise<Response>) => vi.fn<typeof fetch>().mockImplementation(async (_url, init) =>
  (init?.method === 'POST' ? result() : formPage()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('TForce Freight tracking page', () => {
  it('opens a session on the tracking page and posts the PRO with its token, through the supplied transport', async () => {
    const fetcher = site(() => new Response(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TforceFreightTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 222-222-221 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[page, landing], [lookup, post]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect([String(page), String(lookup)]).toEqual([TFORCE_FREIGHT_TRACKING, TFORCE_FREIGHT_TRACKING]);
    expect(landing).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0', Accept: 'text/html' } });
    expect(landing.method).toBeUndefined();
    expect(post).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'User-Agent': 'SyntheticHost/1.0', 'Content-Type': 'application/x-www-form-urlencoded',
      // The anti-forgery cookie once, and the firewall's; nothing else the page sets.
      Cookie: `${ANTIFORGERY}=SyntheticCookie_0-a; TS0123abcd=0123456789abcdef` } });
    // The token as the page's script reads it: its entities decoded.
    expect(Object.fromEntries(new URLSearchParams(String(post.body)))).toEqual({
      __RequestVerificationToken: TOKEN, ProNumbers: `${IN_TRANSIT};`, TrackingByPROresponseToken: '' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'tforce-freight', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each scan’s wall clock and service center, and stages a shipment waiting for its appointment', () => {
    const result = parseTforceFreight(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'A DELIVERY APPOINTMENT HAS BEEN SCHEDULED WITH THE CONSIGNEE.', last_update: null,
      last_update_local: '2026-10-15T16:18:00', expected_delivery: '2026-10-16', weight_kg: 226.796, destination_country: 'US' });
    expect(result).not.toHaveProperty('service_name');
    expect(result.events!.map((event) => [event.local_time, event.stage, event.location])).toEqual([
      ['2026-10-15T16:18:00', 'in_transit', 'Sampleton, OH'],
      ['2026-10-15T16:18:00', 'in_transit', 'Sampleton, OH'],
      ['2026-10-15T05:13:00', 'in_transit', 'Sampleton, OH'],
      ['2026-10-14T20:40:00', 'in_transit', 'Hubville, IN'],
      ['2026-10-14T01:55:00', 'in_transit', 'Hubville, IN'],
      ['2026-10-13T23:05:00', 'in_transit', 'Origin City, IL'],
      ['2026-10-13T20:25:00', 'in_transit', 'Origin City, IL'],
      ['2026-10-13T19:35:00', 'accepted', 'Origin City, IL'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !('time' in event) && !event.provider_code)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);
  });

  it('keeps the delivery, its failed attempt and the repeated scan once, without the people, references or trailers', () => {
    const result = parseTforceFreight(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'SHIPMENT HAS BEEN DELIVERED TO THE CONSIGNEE.', last_update: null, last_update_local: '2026-06-18T12:13:00',
      expected_delivery: null, weight_kg: 566.99, service_name: 'TForce Freight LTL', destination_country: 'US' });
    expect(result.events!.map((event) => [event.local_time, event.stage])).toEqual([
      ['2026-06-18T12:13:00', 'delivered'],
      // The tracker lists records in its own order: the appointment recorded after the delivery comes below it.
      ['2026-06-18T12:40:00', 'in_transit'],
      ['2026-06-18T09:54:00', 'out_for_delivery'],
      ['2026-06-17T19:32:00', 'in_transit'],
      ['2026-06-17T18:06:00', 'failed_attempt'],
      ['2026-06-17T11:33:00', 'out_for_delivery'],
      ['2026-06-16T21:39:00', 'in_transit'],
      ['2026-06-16T19:35:00', 'in_transit'],
      ['2026-06-15T23:48:00', 'in_transit'],
      ['2026-06-15T18:10:00', 'in_transit'],
      ['2026-06-15T16:28:00', 'in_transit'],
      ['2026-06-15T13:30:00', 'accepted'],
    ]);
    expect(result.events![4]).toMatchObject({ description: NOT_DELIVERED, location: 'Sampleton, OH' });
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(metadata.tracking).toMatchObject({ adapter: 'tforce-freight', steps: ['direct', 'retry'], recognition: { rank: 946 }, localClocks: true });
  });

  it('takes the status’s word for a delivery, and the newest scan’s for a more precise stage', () => {
    const status = (value: string) => ($: CheerioAPI) => { $('.trackingResultCard .card-header button > span').eq(1).text(value); };
    // A delivery the history does not show yet.
    expect(parseTforceFreight(edited('in-transit', status('Delivered')), IN_TRANSIT)).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered', expected_delivery: null });
    const outForDelivery = edited('in-transit', ($) => { $('tbody td').eq(3).text('OUT FOR DELIVERY '); });
    expect(parseTforceFreight(outForDelivery, IN_TRANSIT)).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'OUT FOR DELIVERY' });
    // A status the map does not know leaves the stage to the history.
    expect(parseTforceFreight(edited('delivered', status('Sample Status')), DELIVERED)).toMatchObject({ current_stage: 'delivered' });
    // An activity the map does not know is staged by the shared wording rules, or not at all.
    const unknown = edited('in-transit', ($) => {
      $('tbody td').eq(3).text('SYNTHETIC NOTE');
      $('tbody tr').slice(1).remove();
    });
    expect(parseTforceFreight(unknown, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'SYNTHETIC NOTE', events: [{ description: 'SYNTHETIC NOTE' }] });
    expect(parseTforceFreight(unknown, IN_TRANSIT).events![0]).not.toHaveProperty('stage');
    // Without a history, the status alone.
    const summaryOnly = edited('in-transit', ($) => { $('tbody tr').remove(); });
    expect(parseTforceFreight(summaryOnly, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit', summary_only: true, last_status_text: 'In Transit',
      last_update_local: null, events: [] });
    expect(() => parseTforceFreight(edited('in-transit', ($) => { status('Sample Status')($); $('tbody tr').remove(); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('drops a stale estimate, phone numbers in an activity and details it cannot read', () => {
    const result = parseTforceFreight(edited('in-transit', ($) => {
      $('label#deliveredOnDate').text('10/14/2026');
      $('tbody td').eq(3).text('SHIPMENT NOT DELIVERED. CONSIGNEE CLOSED. CALL (800) 000-0000');
      $('#lblOrigShipToCityState').text('SAMPLETOWN OH');
      $('label#shipTo').filter((_, label) => $(label).text() === '500 lbs').text('heavy');
    }), IN_TRANSIT);
    expect(result).toMatchObject({ expected_delivery: null, current_stage: 'failed_attempt',
      last_status_text: 'SHIPMENT NOT DELIVERED. CONSIGNEE CLOSED. CALL' });
    expect(result).not.toHaveProperty('destination_country');
    expect(result).not.toHaveProperty('weight_kg');
  });

  it('reads a PRO it has no shipment for as not found, and other empty answers as inconclusive', () => {
    expect(() => parseTforceFreight(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The notice repeats a PRO typed with eight digits without the card's leading zero.
    const typed = fixture('not-found').replaceAll(UNKNOWN, '011111111').replace('<span>011111111</span>', '<span>11111111</span>');
    expect(() => parseTforceFreight(typed, '11111111')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const silent = edited('not-found', ($) => { $('span:contains("Please check ProNumber")').remove(); });
    expect(() => parseTforceFreight(silent, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const other = edited('not-found', ($) => { $('span:contains("Please check ProNumber") > span').text('333333333'); });
    expect(() => parseTforceFreight(other, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The page as it is before a search, and the site's error page.
    expect(() => parseTforceFreight(fixture('form'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTforceFreight('<html><h3>Unable to process your request. Please try again later.</h3></html>', UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The tracker's own check refusing the PRO.
    const refused = edited('form', ($) => { $('body').prepend('<ul><li id="errorText">Invalid&#x20;Data&#x2E;</li></ul>'); });
    expect(() => parseTforceFreight(refused, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('counts a result only when its card names the PRO asked', () => {
    expect(() => parseTforceFreight(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'TForce Freight answered for another shipment' }));
    expect(() => parseTforceFreight(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // Among the cards of several PROs, the one asked.
    const other = load(fixture('in-transit'));
    const both = edited('delivered', ($) => { $('#accordionExample').append(other.html(other('.GrouptrackingResultCard'))); });
    expect(parseTforceFreight(both, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit', last_update_local: '2026-10-15T16:18:00' });
    const twice = edited('in-transit', ($) => { $('.trackingResultCard').after($.html($('.trackingResultCard'))); });
    expect(() => parseTforceFreight(twice, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects a changed page', () => {
    for (const [name, change] of [
      ['no results', ($: CheerioAPI) => { $('#accordionExample').remove(); }],
      ['renamed cards', ($: CheerioAPI) => { $('.trackingResultCard').removeClass('trackingResultCard'); }],
      ['no status', ($: CheerioAPI) => { $('.trackingResultCard .card-header button > span').eq(1).text(''); }],
      ['no table', ($: CheerioAPI) => { $('table').remove(); }],
      ['renamed columns', ($: CheerioAPI) => { $('thead th').eq(1).text('Day'); }],
      ['short row', ($: CheerioAPI) => { $('tbody td').slice(2, 5).remove(); }],
      ['ISO date', ($: CheerioAPI) => { $('tbody td').eq(1).text('2026-10-15'); }],
      ['impossible date', ($: CheerioAPI) => { $('tbody td').eq(1).text('2/30/2026'); }],
      ['24-hour time', ($: CheerioAPI) => { $('tbody td').eq(2).text('16:18'); }],
      ['hour 13', ($: CheerioAPI) => { $('tbody td').eq(2).text('13:05 PM'); }],
      ['time without date', ($: CheerioAPI) => { $('tbody td').eq(1).text(''); }],
      ['too many rows', ($: CheerioAPI) => { $('tbody').append($.html($('tbody tr').first()).repeat(500)); }],
    ] as const) {
      expect(() => parseTforceFreight(edited('in-transit', change), IN_TRANSIT), name).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A row without an activity is left out; one without a clock keeps none.
    const sparse = parseTforceFreight(edited('in-transit', ($) => {
      $('tbody td').eq(3).text(' ');
      $('tbody td').eq(6).text('');
      $('tbody td').eq(7).text('');
    }), IN_TRANSIT);
    expect(sparse.events).toHaveLength(7);
    expect(sparse.events![0]).not.toHaveProperty('local_time');
  });

  it('reads its anti-forgery token, and a firewall page or a CAPTCHA as a challenge', () => {
    expect(parseTforceFreightForm(fixture('form'))).toBe(TOKEN);
    expect(() => parseTforceFreightForm(FIREWALL)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseTforceFreight(FIREWALL, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    const captcha = edited('form', ($) => { $('#requiredreCaptchaPROhidden').attr('value', 'True'); });
    expect(() => parseTforceFreightForm(captcha)).toThrow(expect.objectContaining({ kind: 'challenge', message: 'TForce Freight asks for a CAPTCHA' }));
    for (const change of [
      ($: CheerioAPI) => { $('form#trackingByProForm').remove(); },
      ($: CheerioAPI) => { $('form#trackingByProForm').attr('action', '/ltl/apps/Track'); },
      ($: CheerioAPI) => { $('#requiredreCaptchaPROhidden').remove(); },
      ($: CheerioAPI) => { $('input[value^="SyntheticAntiForgeryToken"]').remove(); },
      ($: CheerioAPI) => { $('input[value^="SyntheticAntiForgeryToken"]').attr('value', 'short'); },
    ]) {
      expect(() => parseTforceFreightForm(edited('form', change))).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseTforceFreightForm('<html><h3>Unable to process your request. Please try again later.</h3></html>'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps a firewall page, a CAPTCHA, a moved page and a session it cannot open apart from a missing shipment', async () => {
    const track = (fetcher: typeof fetch) => new TforceFreightTracker({ fetcher }).fetch(IN_TRANSIT);
    const landingBlocked = vi.fn<typeof fetch>().mockImplementation(async () => new Response(FIREWALL));
    await expect(track(landingBlocked)).rejects.toMatchObject({ kind: 'challenge' });
    expect(landingBlocked).toHaveBeenCalledOnce();
    await expect(track(site(() => new Response(FIREWALL)))).rejects.toMatchObject({ kind: 'challenge' });
    const rejected = '<html><head><title>Request Rejected</title></head><body>The requested URL was rejected.</body></html>';
    await expect(track(site(() => new Response(rejected)))).rejects.toMatchObject({ kind: 'challenge' });
    // A CAPTCHA the page asks for stops the lookup before it is posted.
    const captcha = vi.fn<typeof fetch>().mockImplementation(async () => formPage(undefined,
      edited('form', ($) => { $('#requiredreCaptchaPROhidden').attr('value', 'true'); })));
    await expect(track(captcha)).rejects.toMatchObject({ kind: 'challenge' });
    expect(captcha).toHaveBeenCalledOnce();
    const cookieless = vi.fn<typeof fetch>().mockImplementation(async () => formPage(['TS0123abcd=0123456789abcdef; Path=/', 'other=1; Path=/']));
    await expect(track(cookieless)).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(cookieless).toHaveBeenCalledOnce();
    for (const status of [301, 302, 404, 410]) {
      const moved = () => new Response('', { status, headers: { Location: '/' } });
      await expect(track(vi.fn<typeof fetch>().mockImplementation(async () => moved())), String(status)).rejects.toMatchObject({ kind: 'transport' });
      await expect(track(site(moved)), String(status)).rejects.toMatchObject({ kind: 'transport' });
    }
    await expect(track(site(() => new Response(fixture('not-found'))))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s on either request as %s during retrieval and recognition', async (status, kind) => {
      const landing = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(landing).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(landing).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(landing).toHaveBeenCalledTimes(2);
      const lookup = site(() => new Response('', { status }));
      await expect(carrier(lookup).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(lookup).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(lookup).toHaveBeenCalledTimes(4);
    });

  it('recognizes a known PRO and the unknown-PRO answer, and asks nothing for a number TForce Freight does not issue', async () => {
    const known = site(() => new Response(fixture('delivered')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(known).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-06-18T12:40:00' });
    await expect(carrier(site(() => new Response(fixture('not-found')))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const unused = vi.fn<typeof fetch>();
    await expect(carrier(unused).recognize!('222222222')).resolves.toEqual({ known: false });
    expect(unused).not.toHaveBeenCalled();
  });

  it('is asked, with XPO and TNT, about nine digits that pass its check', () => {
    for (const number of [DELIVERED, IN_TRANSIT]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['tnt', 'tforce-freight', 'xpo-ltl'] });
      expect(recognitionAskedCarriers(number, { countryHint: 'US' }), number).toContain('tforce-freight');
    }
    for (const number of ['222222222', '11111112', '1111111114', '2205222222222', '2206222222221']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('tforce-freight');
      expect(recognitionAskedCarriers(number), number).not.toContain('tforce-freight');
    }
  });

  it('suggests itself for eight digits that pass its check, and is asked first about a PARS number, which gives its PRO', () => {
    // Eight digits are suggested only: recognition does not ask about them.
    expect(detectCarrierMatch('11111111').candidates).toContain('tforce-freight');
    expect(recognitionAskedCarriers('11111111', { countryHint: 'US' })).not.toContain('tforce-freight');
    const pars = `2205${IN_TRANSIT}`;
    expect(detectCarrierMatch(pars)).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['tforce-freight'] });
    expect(detectCarrierMatch(pars).candidates[0]).toBe('tforce-freight');
    expect(recognitionAskedCarriers(pars, { countryHint: 'CA' })[0]).toBe('tforce-freight');
    expect(normalizeTforceFreightNumber(` 2205-${IN_TRANSIT} `)).toBe(IN_TRANSIT);
  });

  it('tries once more in a new session after a network failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementationOnce(async () => formPage()).mockImplementationOnce(async () => new Response(fixture('delivered')));
    await expect(new TforceFreightTracker({ fetcher }).fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects other numbers before I/O and bounds cancellation, elapsed time and response size', async () => {
    const unused = vi.fn<typeof fetch>();
    // A wrong check digit, other lengths, a PARS number with a wrong PRO, letters, two PROs and an oversized paste.
    for (const number of ['222222222', '1234567', '1234567890', '2205222222222', 'PRO222222221', `${IN_TRANSIT};${DELIVERED}`, '', '2'.repeat(65)]) {
      await expect(new TforceFreightTracker({ fetcher: unused }).fetch(number), number).rejects.toThrow(InvalidInputError);
    }
    await expect(new TforceFreightTracker({ fetcher: unused }).fetch(IN_TRANSIT, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    expect(unused).not.toHaveBeenCalled();
    expect(normalizeTforceFreightNumber(' 222-222.221 ')).toBe(IN_TRANSIT);
    // The tracker reads eight digits with a leading zero.
    expect(normalizeTforceFreightNumber('11111111')).toBe('011111111');
    const hanging = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await expect(new TforceFreightTracker({ fetcher: hanging }).fetch(IN_TRANSIT, { budgetMs: 60 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(hanging.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    const huge = vi.fn<typeof fetch>().mockImplementation(async () => new Response('x'.repeat(1_100_000)));
    await expect(new TforceFreightTracker({ fetcher: huge }).fetch(IN_TRANSIT)).rejects.toThrow('unexpectedly large');
  });

  it('routes a number filed under TForce Freight to the adapter', async () => {
    const fetcher = site(() => new Response(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'tforce-freight' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'tforce-freight', source: 'tforce-freight', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === TFORCE_FREIGHT_TRACKING)).toBe(true);
  });
});

describe('TForce Freight status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string; unmapped?: boolean }[]) {
      const wording = normalizeStatusWording(entry.wording);
      if (entry.unmapped) {
        expect(statusMap.stage(null, wording), entry.wording).toBeUndefined();
        expect(statusMapAnswer({ carrier: 'tforce-freight', providerCode: null, description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(null, wording), entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'tforce-freight', providerCode: null, description: NOT_DELIVERED }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'tforce-freight', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // The tracker has no codes.
    expect(statusMap.stage('DEPARTURE', 'departure')).toBeUndefined();
    expect(tforceFreightStage('Synthetic note')).toBeNull();
    expect(tforceFreightStage('Delivered to the sample dock')).toMatchObject({ stage: 'delivered' });
  });
});
