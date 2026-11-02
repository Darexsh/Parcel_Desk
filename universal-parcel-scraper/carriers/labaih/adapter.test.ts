import { readFileSync } from 'node:fs';
import { load, type CheerioAPI } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, LABAIH_TRACKING, LabaihTracker } from './adapter.js';
import { labaihWording, normalizeLabaihNumber, parseLabaih } from './parser.js';
import { labaihStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '12345078901235';
const OTHER = '00000000000000';
// The shop, its reference and the recipient's district, which the result must not keep.
const PRIVATE = /Sample Shop|Sample Item|REF0|Sample District|Sample Street|whatsapp/i;
const CHALLENGE = '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body>'
  + '<script>(function(){window._cf_chl_opt={cvId:"3",cType:"managed"};})();</script></body></html>';
const NOT_FOUND_LOCATION = 'https://track.mylabaih.com/error/404';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
/** The page with a change made through cheerio. */
const edited = (name: string, edit: ($: CheerioAPI) => void) => {
  const $ = load(fixture(name));
  edit($);
  return $.html();
};
const entry = (wording: string, clock: string, city = '') => `<div class="list-update"><div class="vi"><div class="ti">`
  + `<div class="up-short-det"><h3>${wording}</h3><div class="up-meta"><i class="time-icon"> </i> ${clock}`
  + `${city ? ` <i class="loc-icon"> </i> <strong>${city}</strong>` : ''}</div></div></div></div></div>`;
const history = ($: CheerioAPI) => $('.collapsible');
const serving = (html: string, init?: ResponseInit) => vi.fn<typeof fetch>().mockImplementation(async () => new Response(html, init));
const redirecting = (location: string, status = 302) => serving('<!DOCTYPE html><html><body></body></html>', { status, headers: { Location: location } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('LaBaih tracking page', () => {
  it('asks for the English page of the number through the supplied transport', async () => {
    const fetcher = serving(fixture('in-transit'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new LabaihTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1234 5078-9012.35 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit', last_update_local: '2026-10-16T08:05:00' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(String(url)).toBe(`https://track.mylabaih.com/track/en/?cn=${NUMBER}`);
    expect(String(url)).toBe(`${LABAIH_TRACKING}${NUMBER}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0', Accept: 'text/html' } });
    expect(init.method).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'labaih', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each scan\'s wall clock and city, and drops the shop, its reference and the recipient\'s district', () => {
    const result = parseLabaih(fixture('delivered'), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Shipment Delivered', last_update: null, last_update_local: '2026-10-14T21:05:10', expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.local_time, event.description, event.location, event.stage])).toEqual([
      ['2026-10-14T21:05:10', 'Shipment Delivered', undefined, 'delivered'],
      ['2026-10-13T16:20:30', 'Returned To Facility', undefined, 'in_transit'],
      ['2026-10-13T01:10:00', 'Unsuccessful Delivery: Wrong Customer District', undefined, 'failed_attempt'],
      ['2026-10-12T18:00:45', 'In-Transit to Customer', undefined, 'out_for_delivery'],
      ['2026-10-11T22:40:05', 'Arrived at Exampleville Facility', 'Exampleville', 'in_transit'],
      ['2026-10-11T20:15:00', 'Customer sent location', undefined, undefined],
      ['2026-10-11T19:50:20', 'SMS sent requesting location to customer', undefined, undefined],
      ['2026-10-11T17:30:00', 'Shipment Collected From Partner', undefined, 'accepted'],
      ['2026-10-11T09:00:02', 'Shipment created', undefined, 'registered'],
    ]);
    // Wall clocks without a zone stay local; the commented-out sample list is not read.
    expect(result.events!.every((event) => !('time' in event))).toBe(true);
    expect(result.events!.filter((event) => event.stage).every((event) => event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);
    expect(JSON.stringify(result)).not.toContain('Out for Delivery');
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(metadata.tracking).toMatchObject({ adapter: 'labaih', steps: ['direct', 'retry'], recognition: { rank: 788 }, localClocks: true });
  });

  it('stages a shipment that arrived at a facility', () => {
    const result = parseLabaih(fixture('in-transit'), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Arrived at Sampleton Facility', last_update_local: '2026-10-16T08:05:00' });
    expect(result.events!.map((event) => [event.local_time, event.location, event.stage])).toEqual([
      ['2026-10-16T08:05:00', 'Sampleton', 'in_transit'], ['2026-10-15T15:00:00', undefined, 'accepted'], ['2026-10-15T11:30:00', undefined, 'registered']]);
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);
  });

  it('takes the newest scan with a stage, sorts by clock and keeps a scan listed twice once', () => {
    const result = parseLabaih(edited('in-transit', ($) => {
      history($).append(entry('Synthetic note', '2026-10-16 09:00:00'));
      history($).prepend(entry('Arrived at Sampleton Facility', '2026-10-16 08:05:00', 'Sampleton'));
    }), NUMBER);
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Synthetic note', last_update_local: '2026-10-16T09:00:00' });
    expect(result.events!.map((event) => event.description)).toEqual(['Synthetic note', 'Arrived at Sampleton Facility',
      'Shipment Collected From Partner', 'Shipment created']);
    expect(result.events![0]).not.toHaveProperty('stage');
    // Only scans without a stage.
    const unstaged = parseLabaih(edited('in-transit', ($) => { history($).html(entry('Customer sent location', '2026-10-16 09:00:00')); }), NUMBER);
    expect(unstaged).toMatchObject({ status: 'unknown', last_status_text: 'Customer sent location' });
    expect(unstaged).not.toHaveProperty('current_stage');
    // A page without scans.
    expect(() => parseLabaih(edited('in-transit', ($) => { history($).empty(); }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('keeps a failed attempt\'s reason only, and drops phone numbers', () => {
    expect(labaihWording('Unsuccessful Delivery: Wrong Customer City: Sample Town')).toBe('Unsuccessful Delivery: Wrong Customer City');
    expect(labaihWording('Unsuccessful Delivery: Waiting time exceed')).toBe('Unsuccessful Delivery: Waiting time exceed');
    expect(labaihWording('Unsuccessful Delivery: Call 0500000000')).toBe('Unsuccessful Delivery');
    expect(labaihWording('Unsuccessful Delivery:')).toBe('Unsuccessful Delivery');
    expect(labaihWording('Customer asked to call +966 50 000 0000')).toBe('Customer asked to call');
    const result = parseLabaih(edited('in-transit', ($) => {
      history($).prepend(entry('Unsuccessful Delivery: Wrong Customer City: Sample Town', '2026-10-17 01:00:00'));
    }), NUMBER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: 'Unsuccessful Delivery: Wrong Customer City' });
    expect(JSON.stringify(result)).not.toContain('Sample Town');
  });

  it('counts a shipment only when its page names the number asked', () => {
    expect(() => parseLabaih(fixture('delivered'), OTHER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'LaBaih answered for another shipment' }));
    // A heading without the shop's reference still names the shipment.
    const bare = edited('delivered', ($) => { $('.shipper-details h1').text(`Shipment Tracking - ${NUMBER}`); });
    expect(parseLabaih(bare, NUMBER)).toMatchObject({ current_stage: 'delivered' });
  });

  it('rejects a changed page', () => {
    const first = ($: CheerioAPI) => $('.list-update').first();
    for (const [name, change] of [
      ['no heading', ($: CheerioAPI) => { $('.shipper-details h1').remove(); }],
      ['two shipments', ($: CheerioAPI) => { $('.shipper-details').after($.html($('.shipper-details'))); }],
      ['another heading', ($: CheerioAPI) => { $('.shipper-details h1').text(`Tracking ${NUMBER}`); }],
      ['no history', ($: CheerioAPI) => { history($).removeClass('collapsible'); }],
      ['no wording', ($: CheerioAPI) => { first($).find('h3').remove(); }],
      ['empty wording', ($: CheerioAPI) => { first($).find('h3').text(' '); }],
      ['no clock', ($: CheerioAPI) => { first($).find('.up-meta').text(''); }],
      ['twelve-hour clock', ($: CheerioAPI) => { first($).find('.up-meta').text('11:30:00 AM'); }],
      ['impossible date', ($: CheerioAPI) => { first($).find('.up-meta').text('2026-02-30 10:00:00'); }],
      ['too many rows', ($: CheerioAPI) => { history($).append(entry('Shipment created', '2026-10-15 11:30:00').repeat(301)); }],
    ] as const) {
      expect(() => parseLabaih(edited('in-transit', change), NUMBER), name).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseLabaih('<html><body><p>Synthetic</p></body></html>', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads the redirect to the tracker\'s not-found page as not found, and keeps other answers apart', async () => {
    const track = (fetcher: typeof fetch) => new LabaihTracker({ fetcher }).fetch(NUMBER);
    await expect(track(redirecting(NOT_FOUND_LOCATION))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(track(redirecting('/error/404'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(track(redirecting('https://track.mylabaih.com/errors/404', 301))).rejects.toMatchObject({ kind: 'not_found' });
    // A redirect elsewhere, or a 404, is a moved page.
    for (const fetcher of [redirecting('https://track.mylabaih.com/'), redirecting('https://example.test/error/404'),
      redirecting(`http://track.mylabaih.com/track/en/?cn=${NUMBER}`, 301), serving('', { status: 302 }), serving('', { status: 404 }), serving('', { status: 410 })]) {
      await expect(track(fetcher)).rejects.toMatchObject({ kind: 'transport' });
      expect(fetcher).toHaveBeenCalledOnce();
    }
    expect(() => parseLabaih(CHALLENGE, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    await expect(track(serving(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = serving('', { status });
      await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(NUMBER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number LaBaih does not issue', async () => {
    // A local clock dates the last activity without an instant.
    await expect(carrier(serving(fixture('delivered'))).recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-10-14T21:05:10' });
    await expect(carrier(redirecting(NOT_FOUND_LOCATION)).recognize!(OTHER)).resolves.toEqual({ known: false });
    await expect(carrier(serving(fixture('delivered'))).recognize!(OTHER)).rejects.toMatchObject({ kind: 'indeterminate' });
    const unused = vi.fn<typeof fetch>();
    await expect(carrier(unused).recognize!('1234567890123')).resolves.toEqual({ known: false });
    expect(unused).not.toHaveBeenCalled();
  });

  it('tries once more after a network failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementationOnce(async () => new Response(fixture('delivered')));
    await expect(new LabaihTracker({ fetcher }).fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects other numbers before I/O and bounds cancellation, elapsed time and response size', async () => {
    const unused = vi.fn<typeof fetch>();
    // Other lengths, letters, two numbers and an oversized paste.
    for (const number of ['1234567890123', '123456789012345', 'LB123456789012', `${NUMBER},${OTHER}`, '', '1'.repeat(65)]) {
      await expect(new LabaihTracker({ fetcher: unused }).fetch(number), number).rejects.toThrow(InvalidInputError);
    }
    await expect(new LabaihTracker({ fetcher: unused }).fetch(NUMBER, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    expect(unused).not.toHaveBeenCalled();
    expect(normalizeLabaihNumber(' 1234-5078 9012.35 ')).toBe(NUMBER);
    const hanging = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await expect(new LabaihTracker({ fetcher: hanging }).fetch(NUMBER, { budgetMs: 60 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(hanging.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    await expect(new LabaihTracker({ fetcher: serving('x'.repeat(1_100_000)) }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
  });

  it('routes a number filed under LaBaih to the adapter', async () => {
    const fetcher = serving(fixture('delivered'));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: NUMBER, carrier: 'labaih' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'labaih', source: 'labaih', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === `${LABAIH_TRACKING}${NUMBER}`)).toBe(true);
  });
});

describe('LaBaih status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string; note: string }[]) {
      const stage = statusMap.stage(null, normalizeStatusWording(entry.wording));
      // The progress rail's steps, which the adapter does not read, need not be in the map.
      if (/progress bar/.test(entry.note)) expect([undefined, entry.stage], entry.wording).toContain(stage);
      else expect(stage, entry.wording).toBe(entry.stage);
    }
    // A city's facility, in either language, and a failed attempt with its reason.
    expect(statusMapAnswer({ carrier: 'labaih', providerCode: null, description: 'Arrived at Sample Facility' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMap.stage(null, normalizeStatusWording('وصلت الشحنة إلى مركز التوزيع بـمثال'))).toBe('in_transit');
    expect(statusMap.stage(null, normalizeStatusWording('Unsuccessful Delivery: Synthetic reason'))).toBe('failed_attempt');
    expect(statusMapAnswer({ carrier: 'labaih', providerCode: null, description: 'Customer sent location' }))
      .toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'labaih', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // The tracker has no codes; the shared rules stage what the map does not know.
    expect(statusMap.stage('X', 'shipment delivered')).toBeUndefined();
    expect(labaihStage('Synthetic note')).toBeNull();
    expect(labaihStage('Customer sent location')).toBeNull();
    expect(labaihStage('Returned to sender')).toMatchObject({ stage: 'returned' });
  });
});
