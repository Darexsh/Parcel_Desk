import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fetchTrusting } from '../../core/transport/https.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { SECTIGO_DV_R36 } from '../homexpress/certificate.js';
import { adapter, EXPRESS_ONE_BG_TRACKING, ExpressOneBgTracker } from './adapter.js';
import { normalizeExpressOneBgNumber, parseExpressOneBg, readExpressOneBgToken } from './parser.js';
import { expressOneBgMappedStage, expressOneBgPlace, expressOneBgStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const BILL = '10000017';
const BARCODE = '100000000000000000009999';
const TOKEN = '0a1b2c3d.SyntheticTokenPart-One_000.SyntheticTokenPart-Two_000';
const COOKIE = 'PHPSESSID=0123456789abcdef0123456789abcdef';

const trusting = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock('../../core/transport/https.js', () => ({ fetchTrusting: vi.fn(() => trusting) }));

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}, cookies: string[] = []) => new Response(body, { ...init,
  headers: [['Content-Type', 'text/html; charset=UTF-8'], ...Object.entries(init.headers ?? {}), ...cookies.map((cookie) => ['Set-Cookie', cookie] as [string, string])] });
const page = () => html(text('tracking-page.html'), {}, [`${COOKIE}; path=/; secure; httponly; samesite=lax`]);
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The tracking page, then the form's answer.
const answering = (answer: () => Response, opening: () => Response = page) => vi.fn<typeof fetch>()
  .mockImplementationOnce(async () => opening()).mockImplementation(async () => answer());
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
// A row as the page prints it, above the newest.
const row = (day: string, minute: string, status: string) => `<tbody>
                            <tr class="">
                                <td><span></span></td>
                                <td><span class="mobile-title">Date</span><p>${day}</p></td>
                                <td class="flexible-col"><span class="mobile-title">Day of the week</span><p>Monday</p></td>
                                <td class="flexible-col"><span class="mobile-title">Time</span><p>${minute}</p></td>
                                <td class="flexible-col"><span class="mobile-title">Status</span><p>${status}</p></td>
                            </tr>`;
const above = (status: string, day = '11.03.2026', minute = '17:48') => text('delivered.html').replace('<tbody>', row(day, minute, status));
// The shipment before its delivery: the newest row removed.
const waiting = () => text('delivered.html').replace(/<tr class="active">[\s\S]*?<tr class="row-separator">[\s\S]*?<\/tr>/, '');

describe('Express One Bulgaria HTTP adapter', () => {
  it('opens the tracking page’s session and posts the number with its form token', async () => {
    const fetcher = answering(() => html(text('delivered.html')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ExpressOneBgTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1000 0017 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[pageUrl, pageInit], [formUrl, formInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(pageUrl).toBe(EXPRESS_ONE_BG_TRACKING);
    expect(pageInit).toMatchObject({ method: 'GET', redirect: 'manual', headers: { 'Accept-Language': 'en', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(pageInit.headers).not.toHaveProperty('Cookie');
    expect(formUrl).toBe(`${EXPRESS_ONE_BG_TRACKING}/${BILL}`);
    expect(formInit).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/x-www-form-urlencoded', Cookie: COOKIE, Origin: 'https://expressone.bg', Referer: `${EXPRESS_ONE_BG_TRACKING}/${BILL}` } });
    expect(Object.fromEntries(new URLSearchParams(String(formInit.body)))).toEqual({ 'form[bols]': BILL, 'form[_token]': TOKEN });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'express-one-bg', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the site over the global fetch trusting the intermediate it leaves out, and a host’s own fetcher as given', async () => {
    const reply = async (url: RequestInfo | URL) => (String(url) === EXPRESS_ONE_BG_TRACKING ? page() : html(text('delivered.html')));
    trusting.mockImplementation(reply);
    await expect(new ExpressOneBgTracker().fetch(BILL)).resolves.toMatchObject({ status: 'delivered' });
    await expect(createTracker({ providers: [], env: {} }).track({ number: BILL, carrier: 'express-one-bg' }))
      .resolves.toMatchObject({ source: 'express-one-bg' });
    expect(trusting).toHaveBeenCalledTimes(4);
    expect(fetchTrusting).toHaveBeenCalledWith([SECTIGO_DV_R36]);
    const own = vi.fn<typeof fetch>().mockImplementation(reply);
    await expect(createTracker({ fetcher: own, providers: [], env: {} }).track({ number: BILL, carrier: 'express-one-bg' }))
      .resolves.toMatchObject({ source: 'express-one-bg' });
    expect(own).toHaveBeenCalledTimes(2);
    expect(trusting).toHaveBeenCalledTimes(4);
  });

  it('keeps the statuses as wall clocks with their office and town, newest first', () => {
    const result = parseExpressOneBg(text('delivered.html'), BILL);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2026-03-10T15:39:00', expected_delivery: null });
    expect(result).not.toHaveProperty('canonical_tracking_number');
    // The row the page lists twice is kept once; of equal clocks, the higher row is the newer.
    expect(result.events!.map((event) => [event.local_time, event.description, event.location, event.stage])).toEqual([
      ['2026-03-10T15:39:00', 'Delivered', 'Примерно- Е1, SAMPLEVILLE', 'delivered'],
      ['2026-03-06T14:48:00', 'Confirmed for delivery by PUDO', 'Примерно- Е1, SAMPLEVILLE', 'ready_for_pickup'],
      ['2026-03-06T14:48:00', 'Available for office pickup', 'SAMPLEVILLE', 'ready_for_pickup'],
      ['2026-03-05T16:45:00', 'Parcel is in ExpressOne office', 'SAMPLEVILLE', 'in_transit'],
      ['2026-03-05T09:46:00', 'Not delivered', 'Примерно- Е1, SAMPLEVILLE', 'failed_attempt'],
      ['2026-03-05T07:48:00', 'The shipment has been loaded to the van', 'Примерно- Е1, SAMPLEVILLE', 'out_for_delivery'],
      ['2026-03-05T07:47:00', 'Parcel is in ExpressOne office', 'SAMPLEVILLE', 'in_transit'],
      ['2026-03-04T17:52:00', 'HUB Inbound', 'SPECIMEN CITY', 'in_transit'],
      ['2026-03-02T02:17:00', 'Data received - shipment pending', undefined, 'registered'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
  });

  it('reads a shipment waiting at an office, a closed record and a wording the map does not know', () => {
    expect(parseExpressOneBg(waiting(), BILL)).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup',
      last_status_text: 'Confirmed for delivery by PUDO', last_update_local: '2026-03-06T14:48:00' });
    // "Finalized" moves nothing: the delivery before it stands.
    const finalized = parseExpressOneBg(above('Finalized - \n Примерно- Е1 | SAMPLEVILLE'), BILL);
    expect(finalized).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Finalized', last_update_local: '2026-03-11T17:48:00' });
    expect(finalized.events![0]).toEqual({ local_time: '2026-03-11T17:48:00', description: 'Finalized', location: 'Примерно- Е1, SAMPLEVILLE' });
    // A wording the map does not know goes to the shared wording rules, and one they do not know has no stage.
    expect(parseExpressOneBg(above('Returned to sender - | SAMPLEVILLE'), BILL)).toMatchObject({ current_stage: 'returned', current_stage_source: 'wording:language' });
    const odd = parseExpressOneBg(above('Sample state - | SAMPLEVILLE'), BILL);
    expect(odd).toMatchObject({ current_stage: 'delivered', last_status_text: 'Sample state' });
    expect(odd.events![0]).not.toHaveProperty('stage');
  });

  it('keeps only the shipment the heading names, or the one shipment a barcode finds', () => {
    expect(() => parseExpressOneBg(text('delivered.html'), '10000025'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Express One Bulgaria answered for another shipment' }));
    expect(() => parseExpressOneBg(text('delivered.html').replace('N 10000017', 'N 1000001'), BILL)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A barcode is answered with the bill of lading of its shipment.
    expect(parseExpressOneBg(text('delivered.html'), BARCODE)).toMatchObject({ status: 'delivered', canonical_tracking_number: BILL });
    expect(parseExpressOneBg(text('delivered.html').replace('N 10000017', `N ${BARCODE}`), BARCODE)).not.toHaveProperty('canonical_tracking_number');
    expect(() => parseExpressOneBg(text('delivered.html').replace('N 10000017', 'N 1000001700'), BARCODE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const shipment = /<div class="card-wrapper card-full-wrapper">\s*<div class="card-item-holder">\s*<div class="accordion-container">[\s\S]*?<\/table>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/.exec(text('delivered.html'))![0];
    const twice = text('delivered.html').replace(shipment, `${shipment}${shipment.replace('N 10000017', 'N 10000025')}`);
    for (const number of [BILL, BARCODE]) {
      expect(() => parseExpressOneBg(twice, number), number)
        .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Express One Bulgaria answered with several shipments' }));
    }
  });

  it('reads the page’s notice after a lookup as not found, and after a refused token as no answer', async () => {
    expect(() => parseExpressOneBg(text('not-found.html'), '10000025')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(answering(() => html(text('not-found.html')))).track({ number: '10000025' })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(answering(() => html(text('not-found.html'), { status: 422 }))).track({ number: '10000025' }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    // A page that opens no session, or carries no token, makes no lookup.
    const sessionless = answering(() => html(text('delivered.html')), () => html(text('tracking-page.html')));
    await expect(carrier(sessionless).track({ number: BILL })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    expect(sessionless).toHaveBeenCalledTimes(1);
    const tokenless = answering(() => html(text('delivered.html')),
      () => html(text('tracking-page.html').replace(/<input type="hidden"[^>]*>/, ''), {}, [COOKIE]));
    await expect(carrier(tokenless).track({ number: BILL })).rejects.toMatchObject({ kind: 'schema' });
    expect(tokenless).toHaveBeenCalledTimes(1);
    expect(readExpressOneBgToken(text('tracking-page.html'))).toBe(TOKEN);
  });

  it('rejects a changed page', () => {
    const delivered = text('delivered.html');
    for (const [index, body] of [
      '',
      '<html><body><main>Sample maintenance page</main></body></html>',
      text('not-found.html').replace('No results found', 'Sample notice'),
      delivered.replace('data-controller="bol-tracking-page"', 'data-controller="tracking"'),
      delivered.replace('Shipment N 10000017', 'Пратка N 10000017'),
      delivered.replace('>Day of the week<', '>Weekday<'),
      delivered.replace(/<td class="flexible-col">\s*<span class="mobile-title">Day of the week<\/span>\s*<p>Tuesday<\/p>\s*<\/td>/, ''),
      delivered.replace('10.03.2026', '2026-03-10'),
      delivered.replace('10.03.2026', '30.02.2026'),
      delivered.replace('>15:39<', '>24:00<'),
      delivered.replace('>15:39<', '>3:39 PM<'),
      delivered.replace('Data received - shipment pending', ' '),
      delivered.replace('<tbody>', `<tbody>${'<tr><td><span></span></td><td><span class="mobile-title">Date</span><p>01.03.2026</p></td><td class="flexible-col"><span class="mobile-title">Day of the week</span><p>Sunday</p></td><td class="flexible-col"><span class="mobile-title">Time</span><p>10:00</p></td><td class="flexible-col"><span class="mobile-title">Status</span><p>HUB Inbound</p></td></tr>'.repeat(501)}`),
    ].entries()) {
      expect(() => parseExpressOneBg(body, BILL), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('has no history for a shipment without statuses', () => {
    const empty = text('delivered.html').replace(/<tbody>[\s\S]*<\/tbody>/, '<tbody></tbody>');
    expect(() => parseExpressOneBg(empty, BILL)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('keeps a firewall page, a refusal and a moved route apart from an unknown number', async () => {
    const lookup = (answer: () => Response, opening?: () => Response) => carrier(answering(answer, opening)).track({ number: BILL });
    await expect(lookup(() => html(CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html(CLOUDFLARE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(page, () => html(CLOUDFLARE, {}, [COOKIE]))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(page, () => html(CLOUDFLARE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(() => html('', { status: 302, headers: { Location: 'https://expressone.bg/en/' } })))
      .rejects.toMatchObject({ kind: 'transport', status: 302 });
    await expect(lookup(page, () => html('', { status: 301, headers: { Location: 'https://expressone.bg/' } })))
      .rejects.toMatchObject({ kind: 'transport', status: 301 });
    await expect(lookup(() => html('<html><body>Sample maintenance page</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %s as %s without the session', async (status, kind) => {
    const error = await carrier(answering(() => new Response('', { status }))).track({ number: BILL }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind });
    expect(JSON.stringify(error)).not.toMatch(/PHPSESSID|SyntheticToken/);
  });

  it('refuses what is no tracking number, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['1000001', '100000171', '10000000000000000000999', 'AB100000', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: BILL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeExpressOneBgNumber(' 1000-0017 ')).toBe(BILL);
    expect(normalizeExpressOneBgNumber(BARCODE)).toBe(BARCODE);
  });

  it('tries a read that hangs once more, in a new session inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: BILL }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([EXPRESS_ONE_BG_TRACKING, EXPRESS_ONE_BG_TRACKING]);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('recognizes a number the tracker knows, and not one it does not', async () => {
    await expect(carrier(answering(() => html(text('delivered.html')))).recognize!(BILL)).resolves.toMatchObject({ known: true });
    await expect(carrier(answering(() => html(text('not-found.html')))).recognize!('10000025')).resolves.toEqual({ known: false });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('12345')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('routes a number filed under Express One Bulgaria to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url) === EXPRESS_ONE_BG_TRACKING ? page() : html(text('delivered.html'))));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: BILL, carrier: 'express-one-bg' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'express-one-bg', source: 'express-one-bg', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${EXPRESS_ONE_BG_TRACKING}/${BILL}`)).toBe(true);
  });

  it('names Express One Bulgaria for its tracking links and names, and leaves Hungary’s to Express One', () => {
    for (const url of [`https://expressone.bg/en/tracking/${BILL}`, `https://expressone.bg/bg/tracking/${BARCODE}`, `https://www.expressone.bg/tracking/${BILL}`]) {
      expect(carrierIdFromPartner('', url), url).toBe('express-one-bg');
    }
    expect(carrierIdFromPartner('', 'https://tracking.expressone.hu/?plc_number=1000000000017')).toBe('express-one');
    for (const name of ['Express One BG', 'ExpressOne BG', 'Express One Bulgaria']) expect(carrierIdFromPartner(name), name).toBe('express-one-bg');
    expect(carrierIdFromPartner('Express One')).toBe('express-one');
  });
});

describe('Express One Bulgaria status vocabulary', () => {
  it('records every wording with the stage the map gives it, and the one it leaves without', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string }[]) {
      if (!entry.stage) {
        expect(statusMapAnswer({ carrier: 'express-one-bg', providerCode: null, description: entry.wording }), entry.wording).toMatchObject({ kind: 'intentional_gap' });
        expect(expressOneBgStage(entry.wording), entry.wording).toBeNull();
        continue;
      }
      expect(statusMapAnswer({ carrier: 'express-one-bg', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(expressOneBgStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('splits a status into its wording, office and town', () => {
    expect(expressOneBgPlace('Delivered - Примерно- Е1 | SAMPLEVILLE')).toEqual({ wording: 'Delivered', office: 'Примерно- Е1', town: 'SAMPLEVILLE' });
    expect(expressOneBgPlace('Available for office pickup - | SAMPLEVILLE')).toEqual({ wording: 'Available for office pickup', town: 'SAMPLEVILLE' });
    expect(expressOneBgPlace('Delivered - PUP 9001 | SPECIMEN CITY')).toEqual({ wording: 'Delivered', office: 'PUP 9001', town: 'SPECIMEN CITY' });
    expect(expressOneBgPlace('Data received - shipment pending')).toEqual({ wording: 'Data received - shipment pending' });
    // A wording with a dash of its own is known whole.
    expect(expressOneBgPlace('Data received - shipment pending - | SAMPLEVILLE')).toEqual({ wording: 'Data received - shipment pending', town: 'SAMPLEVILLE' });
    expect(expressOneBgPlace('Sample state - Office - East | SAMPLEVILLE')).toEqual({ wording: 'Sample state', office: 'Office - East', town: 'SAMPLEVILLE' });
    expect(expressOneBgPlace('Sample | state')).toEqual({ wording: 'Sample | state' });
  });

  it('leaves an unknown wording to the shared rules', () => {
    expect(statusMap.stage(null, 'sample state')).toBeUndefined();
    expect(expressOneBgMappedStage('Delivered')).toBeUndefined();
    expect(expressOneBgMappedStage('delivered')).toBe('delivered');
    expect(expressOneBgStage('Returned to sender')).toEqual({ stage: 'returned', source: 'wording:language' });
    expect(expressOneBgStage('Sample state')).toBeNull();
    expect(statusMapAnswer({ carrier: 'express-one-bg', providerCode: null, description: 'Sample state' })).toEqual({ kind: 'unknown' });
  });
});
