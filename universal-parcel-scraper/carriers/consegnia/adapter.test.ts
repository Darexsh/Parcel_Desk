import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, CONSEGNIA_LOOKUP, CONSEGNIA_PAGE, ConsegniaTracker } from './adapter.js';
import { consegniaToken, normalizeConsegniaNumber, parseConsegnia } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'CLC999999917';
const UNKNOWN = 'CLC999999990';
const TOKEN = 'SyntheticToken00000000000000000000000000';
const COOKIES = ['XSRF-TOKEN=c3ludGhldGljLXhzcmY%3D', 'consegnia_session=c3ludGhldGljLXNlc3Npb24%3D', 'Synthetic0000Cookie=c3ludGhldGljLXNpdGU%3D']; // gitleaks:allow

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
type Reply = { success: boolean; message: null; data: { html: string } };
const delivered = () => JSON.parse(text('delivered.json')) as Reply;
/** The delivered reply with its fragment changed. */
const edited = (change: (html: string) => string) => {
  const reply = delivered();
  reply.data.html = change(reply.data.html);
  return reply;
};
/** The fragment's history replaced by the rows given, newest first. */
const history = (rows: [string, string, string][]) => (html: string) => html.replace(/<ol class="track-timeline">[\s\S]*<\/ol>/, `<ol class="track-timeline">${
  rows.map(([day, time, status]) => `<li class="track-timeline__item"><div class="track-timeline__date"><span>${day}</span><span>${time}</span></div>`
    + `<div class="track-timeline__content"><p class="track-timeline__status">${status}</p></div></li>`).join('')}</ol>`);
const summary = (status: string) => (html: string) => html.replace(/<span class="track-badge[^"]*">Delivered<\/span>/, `<span class="track-badge">${status}</span>`);

const page = (body = text('page.html'), init: ResponseInit = {}, cookies = COOKIES.map((cookie) => `${cookie}; Max-Age=7200; path=/; secure; httponly; samesite=lax`)) =>
  new Response(body, { status: 200, ...init, headers: [['Content-Type', 'text/html; charset=utf-8'],
    ...cookies.map((cookie) => ['set-cookie', cookie] as [string, string])] });
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const notFound = () => reply(text('not-found.json'), { status: 404 });
/** A transport that answers the tracking page and then the lookup with the reply given. */
const site = (lookup: () => Response, tracker: () => Response = () => page()) =>
  vi.fn<typeof fetch>(async (url) => (String(url) === CONSEGNIA_PAGE ? tracker() : lookup()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Consegnia numbers', () => {
  it('offers Consegnia alone for CLC and nine digits, which settles the carrier without asking a tracker', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'consegnia', confidence: 'high', candidates: ['consegnia'] });
    expect(recognitionCandidates(NUMBER)).toEqual([]);
    expect(normalizeConsegniaNumber(` ${NUMBER.toLowerCase()} `)).toBe(NUMBER);
    for (const other of ['CLC99999991', 'CLC9999999170', '999999917', 'CLX999999917']) {
      expect(() => normalizeConsegniaNumber(other), other).toThrow('CLC and nine digits');
    }
  });

  it('reads a link to the tracking page', () => {
    expect(parseTrackingInput(`https://clc-express.com/track-delivery?awb=${NUMBER}`)).toMatchObject({ trackingNumber: NUMBER, carrier: 'consegnia' });
  });
});

describe('Consegnia tracking', () => {
  it('opens a session on the tracking page and posts the number with its token, as the page does, through the supplied transport', async () => {
    const fetcher = site(() => reply(text('delivered.json')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ConsegniaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${NUMBER.toLowerCase()} `, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[pageUrl, pageInit], [lookupUrl, lookupInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(pageUrl).toBe('https://clc-express.com/track-delivery');
    expect(pageInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(lookupUrl).toBe(CONSEGNIA_LOOKUP);
    expect(lookupUrl).toBe('https://clc-express.com/track-delivery-result');
    expect(lookupInit).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': 'SyntheticHost/1.0',
      Cookie: COOKIES.join('; '), 'X-Requested-With': 'XMLHttpRequest', Referer: CONSEGNIA_PAGE,
    } });
    expect([...new URLSearchParams(String(lookupInit.body))]).toEqual([['_token', TOKEN], ['awb_number', NUMBER]]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'consegnia', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the page’s token from its form, even beside the firewall’s script that runs on every page', () => {
    expect(consegniaToken(text('page.html'))).toBe(TOKEN);
    expect(consegniaToken(text('page.html').replace(/<input type="hidden" name="_token"[^>]*>/, ''))).toBe(TOKEN);
    expect(consegniaToken('<html><body><form id="track-form"></form></body></html>')).toBeNull();
  });

  it('reads the history newest first, on wall clocks with no zone, with the reason for a failed delivery', () => {
    const result = parseConsegnia(delivered(), NUMBER);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2026-03-04T12:30:00', expected_delivery: null,
      events: [
        { local_time: '2026-03-04T12:30:00', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-03-04T07:58:00', description: 'Out for Delivery', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2026-03-03T19:52:00', description: 'Delivery Failed: COT - Courier Out of Time', stage: 'failed_attempt', stage_source: 'carrier_map' },
        { local_time: '2026-03-03T08:05:00', description: 'Out for Delivery', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2026-03-02T16:40:00', description: 'Arrived at Hub', stage: 'in_transit', stage_source: 'carrier_map' },
        // A booking just after midnight: twelve o'clock AM is the day's first hour.
        { local_time: '2026-03-02T00:10:00', description: 'Ready for Pick-up', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
  });

  it('keeps rows of one clock in the tracker’s order, as histories copied from its former tracker show them', () => {
    const result = parseConsegnia(edited(history([
      ['Nov 18, 2025', '06:05 PM', 'Delivered'], ['Nov 18, 2025', '06:05 PM', 'Ready for Pick-up'],
      ['Nov 18, 2025', '06:05 PM', 'Arrived at Hub'], ['Nov 18, 2025', '06:05 PM', 'Out for Delivery'],
    ])), NUMBER);
    expect(result.events!.map((event) => event.description)).toEqual(['Delivered', 'Ready for Pick-up', 'Arrived at Hub', 'Out for Delivery']);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update_local: '2025-11-18T18:05:00' });
  });

  it('reads a booking waiting for its pickup from the shipper as registered', () => {
    const result = parseConsegnia(edited((html) => history([['Mar 02, 2026', '11:04 PM', 'Ready for Pick-up']])(summary('Ready for Pick-up')(html))), NUMBER);
    expect(result).toMatchObject({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'Ready for Pick-up', last_update_local: '2026-03-02T23:04:00' });
    expect(result.events).toHaveLength(1);
  });

  it('stages a status its map does not list by the shared English rules, and leaves one no rule reads without a stage', () => {
    const picked = parseConsegnia(edited((html) => history([['Mar 02, 2026', '02:15 PM', 'Picked Up'], ['Mar 02, 2026', '12:10 AM', 'Ready for Pick-up']])(
      summary('Picked Up')(html))), NUMBER);
    expect(picked).toMatchObject({ status: 'in_transit', current_stage: 'accepted', current_stage_source: 'wording:language' });
    expect(picked.events![0]).toMatchObject({ description: 'Picked Up', stage: 'accepted', stage_source: 'wording:language' });

    const noted = parseConsegnia(edited((html) => history([['Mar 02, 2026', '02:15 PM', 'Synthetic note'], ['Mar 02, 2026', '12:10 AM', 'Ready for Pick-up']])(
      summary('Synthetic note')(html))), NUMBER);
    expect(noted.events![0]).toEqual({ local_time: '2026-03-02T14:15:00', description: 'Synthetic note' });
    expect(noted).toMatchObject({ current_stage: 'registered', last_status_text: 'Synthetic note' });
  });

  it('reads a shipment with a status and no history from its summary', () => {
    const empty = (status: string) => edited((html) => summary(status)(html).replace(/<ol class="track-timeline">[\s\S]*<\/ol>/,
      '<p class="track-card__empty">No updates yet.</p>'));
    expect(parseConsegnia(empty('Ready for Pick-up'), NUMBER)).toEqual({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'Ready for Pick-up', last_update: null, last_update_local: '2026-03-04T12:30:00', expected_delivery: null, summary_only: true, events: [] });
    expect(() => parseConsegnia(empty('Synthetic note'), NUMBER)).toThrow(NoHistoryError);
  });

  it('reads the lookup’s 404 as not found, in one session', async () => {
    const fetcher = site(notFound);
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps a refused session, a missing route, a refusal, a firewall page, a rate limit and an outage apart from a missing shipment', async () => {
    const cases: [Response, string][] = [
      [reply({ message: 'CSRF token mismatch.' }, { status: 419 }), 'indeterminate'],
      [new Response('<html><title>Not Found</title></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }), 'transport'],
      [reply({ success: false, message: 'Synthetic' }, { status: 404 }), 'transport'],
      [new Response('', { status: 302, headers: { Location: 'https://clc-express.com/' } }), 'transport'],
      [new Response('<html><title>Just a moment...</title></html>', { status: 403 }), 'challenge'],
      [reply({ message: 'Too Many Attempts.' }, { status: 429, headers: { 'Retry-After': '42' } }), 'rate_limited'],
      [new Response('', { status: 500 }), 'indeterminate'],
      [new Response('', { status: 503 }), 'maintenance'],
      [new Response('<html><head><title>Just a moment...</title></head></html>', { headers: { 'Content-Type': 'text/html' } }), 'challenge'],
      [new Response('<html><body>Synthetic page</body></html>', { headers: { 'Content-Type': 'text/html' } }), 'schema'],
      [reply({ success: false, message: 'Synthetic' }), 'schema'],
      [reply({ success: true, data: {} }), 'schema'],
    ];
    for (const [response, kind] of cases) {
      const fetcher = site(() => response.clone());
      await expect(carrier(fetcher).track({ number: NUMBER }), kind).rejects.toMatchObject({ kind });
      expect(fetcher, kind).toHaveBeenCalledTimes(2);
    }
  });

  it('asks nothing when the tracking page is refused, moved, a firewall’s, or opens no session', async () => {
    const cases: [Response, string][] = [
      [new Response('<html><title>Attention Required!</title></html>', { status: 403 }), 'challenge'],
      [page('<html><head><title>Just a moment...</title></head><body><div class="cf-turnstile"></div></body></html>'), 'challenge'],
      [page('<html><body>Synthetic page</body></html>'), 'schema'],
      [page(undefined, {}, ['XSRF-TOKEN=c3ludGhldGljLXhzcmY%3D; path=/']), 'schema'], // gitleaks:allow
      [new Response('', { status: 301, headers: { Location: 'https://clc-express.com/' } }), 'transport'],
      [new Response('', { status: 404 }), 'transport'],
      [new Response('', { status: 429 }), 'rate_limited'],
      [new Response('', { status: 503 }), 'maintenance'],
    ];
    for (const [response, kind] of cases) {
      const fetcher = site(() => reply(text('delivered.json')), () => response.clone());
      await expect(carrier(fetcher).track({ number: NUMBER }), kind).rejects.toMatchObject({ kind });
      expect(fetcher, kind).toHaveBeenCalledTimes(1);
    }
  });

  it('leaves an answer for another shipment, an empty history and a changed reply open or failed, never found', () => {
    expect(() => parseConsegnia(edited((html) => html.replace(NUMBER, UNKNOWN)), NUMBER)).toThrow('another shipment');
    expect(() => parseConsegnia(edited((html) => html.replace(/<h4 class="track-card__awb">[^<]*<\/h4>/, '')), NUMBER)).toThrow('without its number');
    expect(() => parseConsegnia(edited((html) => html.replace(/<dt>Current Status<\/dt>/, '<dt>Status</dt>')), NUMBER)).toThrow('without its status');
    expect(() => parseConsegnia(edited((html) => html.replace(/<ol class="track-timeline">[\s\S]*<\/ol>/, '')), NUMBER)).toThrow('invalid history');
    for (const [day, time] of [['Feb 30, 2026', '10:00 AM'], ['Mar 04, 2026', '13:00 PM'], ['Mar 04, 2026', '00:15 AM'], ['2026-03-04', '10:00 AM'],
      ['Mar 04, 2026', '10:00'], ['Sept 04, 2026', '10:00 AM']]) {
      expect(() => parseConsegnia(edited(history([[day!, time!, 'Delivered']])), NUMBER), `${day} ${time}`).toThrow('invalid scan time');
    }
    expect(() => parseConsegnia(edited(history([['Mar 04, 2026', '10:00 AM', '']])), NUMBER)).toThrow('invalid history row');
    expect(() => parseConsegnia(edited((html) => html.replace('<span>07:58 AM</span>', '')), NUMBER)).toThrow('invalid history row');
    expect(() => parseConsegnia({ success: false, message: 'Synthetic' }, NUMBER)).toThrow('unexpected reply');
  });

  it('recognizes a number its tracker knows, and not one it does not', async () => {
    await expect(carrier(site(() => reply(text('delivered.json')))).recognize!(NUMBER))
      .resolves.toMatchObject({ known: true, lastActivityLocal: '2026-03-04T12:30:00' });
    await expect(carrier(site(notFound)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const fetcher = site(() => reply(text('delivered.json')));
    await expect(carrier(fetcher).recognize!('CLC123')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Consegnia status map', () => {
  it('stages every status its tracker showed, with or without a failed delivery’s reason, and the app reads it', () => {
    const wordings = statuses.entries.map((entry) => normalizeStatusWording(entry.wording));
    expect(new Set(wordings).size).toBe(wordings.length);
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMap.stage(null, normalizeStatusWording('Delivery Failed: Synthetic reason'))).toBe('failed_attempt');
    expect(statusMapAnswer({ carrier: 'consegnia', providerCode: null, description: 'Delivery Failed: COT - Courier Out of Time' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'consegnia', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
