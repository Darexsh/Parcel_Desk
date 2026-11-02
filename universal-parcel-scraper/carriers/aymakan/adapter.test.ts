import { readFileSync } from 'node:fs';
import { load, type CheerioAPI } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, AYMAKAN_TRACKING, AymakanTracker } from './adapter.js';
import { aymakanDay, aymakanWording, latestScanDay, normalizeAymakanNumber, parseAymakan } from './parser.js';
import { aymakanStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'AY10000000001';
const IN_TRANSIT = 'AY200000002';
const UNKNOWN = 'AY999999999';
// The lookup's time, which sets the years of the scans' days.
const NOW = Date.parse('2026-10-16T09:00:00Z');
const PRIVATE = /سارة|مثال|Received by|Sampleton →|Exampleville|\*{3}/;
// Cloudflare's managed challenge, which the site's CDN can serve in place of the page.
const CHALLENGE = '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body>'
  + '<script>(function(){window._cf_chl_opt={cvId:"3",cType:"managed"};})();</script></body></html>';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
/** The page with a change made through cheerio. */
const edited = (name: string, edit: ($: CheerioAPI) => void) => {
  const $ = load(fixture(name));
  edit($);
  return $.html();
};
const entry = (wording: string, day: string) => `<div class="relative pb-8"><h4 class="text-[18px] font-bold">${wording}</h4>`
  + `<p class="mt-2 text-[15px]">${day}</p></div>`;
const timeline = ($: CheerioAPI) => $('aside .progress-line-y');
const parse = (html: string, number: string) => parseAymakan(html, number, NOW);
const serving = (html: string, init?: ResponseInit) => vi.fn<typeof fetch>().mockImplementation(async () => new Response(html, init));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('AyMakan tracking page', () => {
  it('asks for the page of the number, in capitals, through the supplied transport', async () => {
    const fetcher = serving(fixture('in-transit'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new AymakanTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0', now: () => NOW }).fetch(' ay-200 000 002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit', last_update_local: '2026-10-13' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(String(url)).toBe(`${AYMAKAN_TRACKING}${IN_TRANSIT}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0', Accept: 'text/html' } });
    expect(init.method).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'aymakan', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('dates each scan to its day, and drops who took the parcel, the route and the masked parties', () => {
    const result = parse(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Shipment is delivered to customer', last_update: null, last_update_local: '2026-10-07', expected_delivery: null });
    expect(result).not.toHaveProperty('summary_only');
    expect(result.events!.map((event) => [event.local_time, event.description, event.stage])).toEqual([
      ['2026-10-07', 'Shipment is delivered to customer', 'delivered'],
      ['2026-10-07', 'Shipment is out for its final destination.', 'out_for_delivery'],
      ['2026-10-06', 'Received at Sampleton Warehouse', 'in_transit'],
      ['2026-10-05', 'Shipment is received at hub', 'in_transit'],
      ['2026-10-05', 'Shipment was collected from collection point', 'accepted'],
      ['2026-10-04', 'Shipment is created at collection point', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !('time' in event) && !event.location)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(metadata.tracking).toMatchObject({ adapter: 'aymakan', steps: ['direct', 'retry'], recognition: { rank: 942 }, localClocks: true });
  });

  it('stages a shipment received at a hub, and reads the older wordings and six-digit numbers', () => {
    const result = parse(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Shipment is received at Sampleton hub', last_update_local: '2026-10-13' });
    expect(result.events!.map((event) => [event.local_time, event.stage])).toEqual([
      ['2026-10-13', 'in_transit'], ['2026-10-12', 'accepted'], ['2026-10-11', 'registered']]);
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);
    expect(parse(fixture('in-transit').replaceAll(IN_TRANSIT, '123456'), '123456')).toMatchObject({ current_stage: 'in_transit' });
  });

  it('takes the status over the shipment for its stage, and the newest staged scan for a status it does not know', () => {
    const status = (value: string) => ($: CheerioAPI) => { $('main section h3').first().text(value); };
    // A delivery the timeline does not show yet.
    expect(parse(edited('in-transit', status('Delivered')), IN_TRANSIT)).toMatchObject({ status: 'delivered', current_stage: 'delivered',
      current_stage_source: 'carrier_map', last_status_text: 'Shipment is received at Sampleton hub' });
    expect(parse(edited('delivered', status('Synthetic Status')), DELIVERED)).toMatchObject({ current_stage: 'delivered' });
    // Scans the map does not know are staged by the shared wording rules, or not at all.
    const unknown = edited('in-transit', ($) => {
      status('Synthetic Status')($);
      timeline($).html(entry('Synthetic note', 'Tue, Oct 13'));
    });
    const result = parse(unknown, IN_TRANSIT);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic note', events: [{ description: 'Synthetic note' }] });
    expect(result).not.toHaveProperty('current_stage');
    expect(result.events![0]).not.toHaveProperty('stage');
    // Without a timeline, the status alone.
    const summaryOnly = edited('in-transit', ($) => { timeline($).empty(); });
    expect(parse(summaryOnly, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit', summary_only: true,
      last_status_text: 'Received at Warehouse', last_update_local: null, events: [] });
    expect(() => parse(edited('in-transit', ($) => { status('Synthetic Status')($); timeline($).empty(); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('drops phone numbers and repeated scans, and bounds the history it keeps', () => {
    const failed = parse(edited('in-transit', ($) => {
      $('main section h3').first().text('Not Delivered');
      timeline($).prepend(entry('Shipment delivery attempt failed - Call +966 50 000 0000', 'Wed, Oct 14')
        + entry('Shipment is received at Sampleton hub', 'Tue, Oct 13'));
    }), IN_TRANSIT);
    expect(failed).toMatchObject({ current_stage: 'failed_attempt', last_status_text: 'Shipment delivery attempt failed - Call' });
    expect(failed.events).toHaveLength(4);
    expect(aymakanWording('Shipment retrieved from locker - Retrieved by Sample Person')).toBe('Shipment retrieved from locker');
    const long = parse(edited('in-transit', ($) => {
      timeline($).html(Array.from({ length: 120 }, (_, index) => entry(`Received at Hub ${index}`, 'Tue, Oct 13')).join(''));
    }), IN_TRANSIT);
    expect(long).toMatchObject({ history_truncated: true, last_status_text: 'Received at Hub 0' });
    expect(long.events).toHaveLength(100);
  });

  it('gives each day the latest year, up to the day after the lookup in Saudi Arabia, in which it falls on its weekday', () => {
    expect(latestScanDay(NOW)).toBe('2026-10-17');
    // Late in the evening, Riyadh is already a day ahead of UTC.
    expect(latestScanDay(Date.parse('2026-10-16T22:00:00Z'))).toBe('2026-10-18');
    expect(aymakanDay('Sat, Oct 17', '2026-10-17')).toBe('2026-10-17');
    // A day after the latest one belongs to an earlier year.
    expect(aymakanDay('Sun, Oct 18', '2026-10-17')).toBe('2020-10-18');
    // Across New Year.
    expect(aymakanDay('Thu, Dec 31', '2027-01-03')).toBe('2026-12-31');
    expect(aymakanDay('Sat, Jan 02', '2027-01-03')).toBe('2027-01-02');
    expect(aymakanDay('Sun, Oct 14', '2026-10-17')).toBe('2018-10-14');
    expect(aymakanDay('Sat, Feb 29', '2026-10-17')).toBe('2020-02-29');
    for (const label of ['Mon, Feb 30', 'Thu, Apr 31', 'Tuesday, Oct 13', 'Tue, Oct 3', '2026-10-13', 'Tue Oct 13', '']) {
      expect(() => aymakanDay(label, '2026-10-17'), label).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads the notice under a search for the number as not found, and other answers as inconclusive', () => {
    expect(() => parse(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parse(fixture('not-found').replace(`value="${UNKNOWN}"`, `value="${UNKNOWN.toLowerCase()}"`), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The notice under a search for another number, or without the search.
    expect(() => parse(fixture('not-found'), 'AY999999998'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'AyMakan answered for another search' }));
    expect(() => parse(edited('not-found', ($) => { $('form').remove(); }), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The search page without an answer.
    expect(() => parse(edited('not-found', ($) => { $('h3').remove(); }), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('counts a shipment only when its page names the number asked', () => {
    expect(() => parse(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'AyMakan answered for another shipment' }));
    expect(() => parse(fixture('in-transit'), 'AY2000000020')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed page', () => {
    const first = ($: CheerioAPI) => $('aside h4').first();
    for (const [name, change] of [
      ['no main', ($: CheerioAPI) => { $('main').replaceWith($('main').html()!); }],
      ['two mains', ($: CheerioAPI) => { $('body').append('<main></main>'); }],
      ['two shipments', ($: CheerioAPI) => {
        const card = $('p:contains("Tracking #:")').closest('section');
        card.after($.html(card));
      }],
      ['no status', ($: CheerioAPI) => { $('main section h3').first().text(' '); }],
      ['no timeline', ($: CheerioAPI) => { $('aside h3').text('History'); }],
      ['timeline out of its panel', ($: CheerioAPI) => { $('aside').replaceWith($('aside').html()!); }],
      ['no day', ($: CheerioAPI) => { first($).siblings('p').remove(); }],
      ['two days', ($: CheerioAPI) => { first($).after('<p>Tue, Oct 13</p>'); }],
      ['empty wording', ($: CheerioAPI) => { first($).text(' '); }],
      ['ISO date', ($: CheerioAPI) => { first($).siblings('p').text('2026-10-13'); }],
      ['impossible date', ($: CheerioAPI) => { first($).siblings('p').text('Thu, Apr 31'); }],
      ['too many rows', ($: CheerioAPI) => { timeline($).append(entry('Shipment is in transit', 'Tue, Oct 13').repeat(301)); }],
    ] as const) {
      expect(() => parse(edited('in-transit', change), IN_TRANSIT), name).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parse('<html><body><p>Synthetic</p></body></html>', IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps a browser check, a moved page and HTTP refusals apart from a missing shipment', async () => {
    const track = (fetcher: typeof fetch) => new AymakanTracker({ fetcher, now: () => NOW }).fetch(IN_TRANSIT);
    expect(() => parse(CHALLENGE, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    await expect(track(serving(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(track(serving(CHALLENGE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    const turnstile = edited('in-transit', ($) => { $('form').append('<div class="cf-turnstile" data-sitekey="0x0000000000000000000000"></div>'); });
    await expect(track(serving(turnstile))).rejects.toMatchObject({ kind: 'challenge' });
    for (const status of [301, 302, 307, 308, 404, 410]) {
      const moved = serving('', { status, headers: { Location: '/' } });
      await expect(track(moved), String(status)).rejects.toMatchObject({ kind: 'transport' });
      expect(moved).toHaveBeenCalledOnce();
    }
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = serving('', { status });
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number AyMakan does not issue', async () => {
    // A day alone dates the last activity without an instant.
    await expect(carrier(serving(fixture('delivered'))).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-10-07T00:00:00' });
    await expect(carrier(serving(fixture('not-found'))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const unused = vi.fn<typeof fetch>();
    await expect(carrier(unused).recognize!('AY12345678')).resolves.toEqual({ known: false });
    expect(unused).not.toHaveBeenCalled();
  });

  it('tries once more after a network failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementationOnce(async () => new Response(fixture('delivered')));
    await expect(new AymakanTracker({ fetcher, now: () => NOW }).fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects other numbers before I/O and bounds cancellation, elapsed time and response size', async () => {
    const unused = vi.fn<typeof fetch>();
    // Other lengths, other letters, two numbers and an oversized paste.
    for (const number of ['AY12345678', 'AY123456789012', '12345', '1234567', 'AB123456789', 'AY', `${DELIVERED},${IN_TRANSIT}`, '', '1'.repeat(65)]) {
      await expect(new AymakanTracker({ fetcher: unused }).fetch(number), number).rejects.toThrow(InvalidInputError);
    }
    await expect(new AymakanTracker({ fetcher: unused }).fetch(IN_TRANSIT, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    expect(unused).not.toHaveBeenCalled();
    expect(normalizeAymakanNumber(' ay 1000-0000.001 ')).toBe(DELIVERED);
    expect(normalizeAymakanNumber('123 456')).toBe('123456');
    const hanging = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await expect(new AymakanTracker({ fetcher: hanging }).fetch(IN_TRANSIT, { budgetMs: 60 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(hanging.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    await expect(new AymakanTracker({ fetcher: serving('x'.repeat(1_100_000)) }).fetch(IN_TRANSIT)).rejects.toThrow('unexpectedly large');
  });

  it('routes a number filed under AyMakan to the adapter', async () => {
    const fetcher = serving(fixture('delivered'));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'aymakan' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'aymakan', source: 'aymakan', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === `${AYMAKAN_TRACKING}${DELIVERED}`)).toBe(true);
  });
});

describe('AyMakan status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string; note: string }[]) {
      const stage = statusMap.stage(null, normalizeStatusWording(entry.wording));
      // The progress rail's steps, which the adapter does not read, need not be in the map.
      if (/progress.rail/.test(entry.note)) expect([undefined, entry.stage], entry.wording).toContain(stage);
      else expect(stage, entry.wording).toBe(entry.stage);
    }
    // A city's warehouse or hub.
    expect(statusMapAnswer({ carrier: 'aymakan', providerCode: null, description: 'Received at Sample Warehouse' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'aymakan', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // The tracker has no codes.
    expect(statusMap.stage('AY-0005', 'delivered')).toBeUndefined();
    expect(aymakanStage('Synthetic note')).toBeNull();
    expect(aymakanStage('Delivered to the sample office')).toMatchObject({ stage: 'delivered' });
  });
});
