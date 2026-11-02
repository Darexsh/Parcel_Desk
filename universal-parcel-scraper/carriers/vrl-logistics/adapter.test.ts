import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, VRL_TRACKER, VrlTracker } from './adapter.js';
import { normalizeVrlNumber, parseVrl } from './parser.js';
import { statusMap, vrlStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '1000000001';
const IN_TRANSIT = '1000000002';
const UNKNOWN = '0000000000';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const edited = (html: string, from: string | RegExp, to: string) => {
  const next = html.replace(from, to);
  if (next === html) throw new Error(`The page has no ${String(from)}`);
  return next;
};
const changed = (name: string, from: string | RegExp, to: string) => edited(fixture(name), from, to);
const page = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const timeline = (html: string, number: string) => parseVrl(html, number).events!
  .map((event) => [event.local_time, event.location ?? null, event.stage ?? null, event.description]);
// The page's error toast above the form, as it renders one.
const toast = (message: string) => edited(fixture('not-found'), 'No data found', message);

describe('VRL Logistics HTTP adapter', () => {
  it('posts the whole LR number to the tracking page once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(page(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new VrlTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1000000002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(VRL_TRACKER);
    expect(String(url)).toBe('https://www.vrlgroup.in/Tracking/TrackShipment');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: `lrno=${IN_TRANSIT}`,
      headers: { Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'vrl-logistics', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the booking and the transit rows as one history of days, newest first', () => {
    const result = parseVrl(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'DELIVERED', last_update: null, last_update_local: '2026-03-05', expected_delivery: null });
    expect(timeline(fixture('delivered'), DELIVERED)).toEqual([
      ['2026-03-05', 'SAMPLE TOWN EAST', 'delivered', 'DELIVERED'],
      ['2026-03-05', 'SAMPLE TOWN EAST', 'in_transit', 'ARRIVED AT DESTINATION'],
      ['2026-03-05', 'SAMPLE TOWN EAST', 'in_transit', 'IN-TRANSIT'],
      // Two rows the same day at the same branch say the same thing once their hours are gone.
      ['2026-03-03', 'SAMPLE HUB', 'in_transit', 'IN-TRANSIT'],
      ['2026-03-02', 'SAMPLE CITY NORTH', 'in_transit', 'IN-TRANSIT'],
      // The booking day at the booking branch the details card names whole.
      ['2026-03-02', 'SAMPLE CITY NORTH', 'accepted', 'Booked'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !('time' in event))).toBe(true);
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('keeps no hour, delivery type, package count, branch code or the hidden sample card', () => {
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', IN_TRANSIT]] as const) {
      const text = JSON.stringify(parseVrl(fixture(name), number));
      expect(text, name).not.toMatch(/T\d{2}:|Office|Door|XS[A-Z]{2}|SAMPLE00|ETA|July|Sample (?:Origin|Destination)|1800/);
    }
  });

  it('reads a consignment on its way, and the current status over its newest row', () => {
    expect(parseVrl(fixture('in-transit'), IN_TRANSIT)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'IN-TRANSIT', last_update_local: '2026-09-30', expected_delivery: null });
    expect(timeline(fixture('in-transit'), IN_TRANSIT)).toEqual([
      ['2026-09-30', 'SAMPLE HUB', 'in_transit', 'IN-TRANSIT'],
      ['2026-09-28', 'SAMPLE CITY SOUTH', 'in_transit', 'IN-TRANSIT'],
      ['2026-09-28', 'SAMPLE CITY SOUTH', 'accepted', 'Booked'],
    ]);
    // A current status the map knows decides; one it does not leaves the newest row with a stage to decide.
    const arrived = changed('in-transit', '<p class="track-value">IN-TRANSIT</p>', '<p class="track-value">ARRIVED AT DESTINATION</p>');
    expect(parseVrl(arrived, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit', last_status_text: 'ARRIVED AT DESTINATION' });
    const delivered = changed('in-transit', '<p class="track-value">IN-TRANSIT</p>', '<p class="track-value">DELIVERED</p>');
    expect(parseVrl(delivered, IN_TRANSIT)).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'DELIVERED' });
    const strange = changed('in-transit', '<p class="track-value">IN-TRANSIT</p>', '<p class="track-value">SAMPLE STATE</p>');
    expect(parseVrl(strange, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'IN-TRANSIT' });
    expect(vrlStage('SAMPLE STATE')).toBeNull();
  });

  it('leaves out a row with neither a time nor a day, and reads a consignment booked but not moved yet', () => {
    const undated = changed('in-transit', /(<label>\s*)IN-TRANSIT(\s*<\/label>\s*<div class="step-date">\s*)20:09, 28-Sep-2026/,
      '$1DELIVERED$2, ');
    expect(parseVrl(undated, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit' });
    expect(timeline(undated, IN_TRANSIT).map((event) => event[3])).toEqual(['IN-TRANSIT', 'Booked']);
    const booked = edited(changed('in-transit', /<div class="track-stepp">\s*<div class="step-left">\s*<div class="step-line"><\/div>\s*<div class="step-dott mobile-completed-dot">\s*&#x2713;\s*<\/div>\s*<\/div>\s*<div class="step-content">\s*<div class="step-labell">\s*<div class="city">\s*SAMPLE CITY SOUTH[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/, ''),
      /<div class="track-stepp">\s*<div class="step-left">\s*<div class="step-line"><\/div>\s*<div class="step-dott mobile-completed-dot">\s*&#x2713;\s*<\/div>\s*<\/div>\s*<div class="step-content">\s*<div class="step-labell">\s*<div class="city">\s*SAMPLE HUB[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/, '');
    const unmoved = edited(booked, '<p class="track-value">IN-TRANSIT</p>', '<p class="track-value"></p>');
    expect(parseVrl(unmoved, IN_TRANSIT)).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'Booked',
      last_update_local: '2026-09-28' });
    // Without a booking day either, there is nothing to show.
    expect(() => parseVrl(edited(unmoved, '<p class="track-value">28-Sep-2026</p>', '<p class="track-value"></p>'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it("reads the tracker's error toast for an unknown LR number as not found", () => {
    expect(() => parseVrl(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The toast for a refused number is also its answer to a request without one: the request changed.
    expect(() => parseVrl(toast('Invalid LR number. Please enter a valid LR number.'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    // The form alone, without a toast or a result, is no answer.
    expect(() => parseVrl(edited(fixture('not-found'), /<div class="toast[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/, ''), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('counts a consignment only when the page names the LR number asked', () => {
    expect(() => parseVrl(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'VRL answered for a different LR number' }));
    expect(() => parseVrl(changed('in-transit', `id="lrnum">#${IN_TRANSIT}`, `id="lrnum">#${IN_TRANSIT}0`), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'VRL answered for a different LR number' }));
  });

  it('rejects a changed page', () => {
    for (const [index, html] of [
      '<html><title>VRL</title></html>',
      changed('in-transit', 'id="lrnum"', 'id="lrno"'),
      changed('in-transit', 'Booking Date', 'Booked On'),
      changed('in-transit', 'Booking From', 'From Branch'),
      changed('in-transit', 'track-container sm-scr-progress', 'track-container'),
      changed('in-transit', '<p class="track-value">28-Sep-2026</p>', '<p class="track-value">2026-09-28</p>'),
      changed('in-transit', '<p class="track-value">28-Sep-2026</p>', '<p class="track-value">31-Sep-2026</p>'),
      changed('in-transit', '06:09, 30-Sep-2026', '6:09 AM, 30-Sep-2026'),
      changed('in-transit', '06:09, 30-Sep-2026', '24:09, 30-Sep-2026'),
      changed('in-transit', '06:09, 30-Sep-2026', '30-Sep-2026'),
      changed('in-transit', /(<div class="city">\s*)SAMPLE HUB(\s*<\/div>\s*<div class="status">)/, '$1$2'),
      changed('in-transit', /(<\/div>\s*<label>\s*)IN-TRANSIT(\s*<\/label>\s*<div class="step-date">\s*06:09)/, '$1$2'),
      // A row without its date that is not one of the rail's ends.
      changed('in-transit', /<div class="step-date">\s*06:09, 30-Sep-2026\s*<\/div>/, ''),
      changed('in-transit', '<section class="track-card track-card--timeline">', '<section class="track-card">'),
      changed('in-transit', '<section class="track-card track-card--details">',
        '<section class="track-card track-card--details"></section><section class="track-card track-card--details">'),
    ].entries()) {
      expect(() => parseVrl(html, IN_TRANSIT), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const rows = fixture('in-transit').match(/<div class="track-stepp">[\s\S]*?06:09, 30-Sep-2026\s*<\/div>\s*<\/div>\s*<\/div>/)![0];
    expect(() => parseVrl(changed('in-transit', rows, rows.repeat(501)), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a moved route, a browser check and a broken page apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(page(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page answers an unknown LR number with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.vrlgroup.in/Home/Error' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><head><title>Access Denied</title></head><body>Request blocked.</body></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>VRL Logistics Ltd</title><body>Under maintenance</body></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('rejects numbers VRL does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['10000000', '10000000003', 'A00000001', '1'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeVrlNumber(' 1000000002 ')).toBe(IN_TRANSIT);
    expect(normalizeVrlNumber('100000003')).toBe('100000003');
  });

  it('recognizes a known LR number and the unknown-number answer, and asks nothing for a number VRL does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) =>
      page(fixture(String(init?.body) === `lrno=${DELIVERED}` ? 'delivered' : 'not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-05T00:00:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('10000000003')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(page('', { status: 429 }))).recognize!(DELIVERED))
      .rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(page(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes an LR number filed under VRL Logistics to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => page(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'vrl-logistics' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'vrl-logistics', source: 'vrl-logistics', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url, init]) => String(url) === VRL_TRACKER && init?.body === `lrno=${DELIVERED}`)).toBe(true);
  });

  it('leaves LR numbers to the caller: no rule claims nine or ten digits for VRL', () => {
    for (const number of [DELIVERED, IN_TRANSIT, '100000003']) expect(detectCarrierMatch(number).carrier, number).not.toBe('vrl-logistics');
  });
});

describe('VRL Logistics status vocabulary', () => {
  it('records every wording the current tracker shows with the stage the map gives it', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string; confirmedBy: string }[]) {
      // The former tracker's wording falls to the shared rules.
      if (entry.confirmedBy !== 'live') continue;
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      if (entry.stage) expect(vrlStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'vrl-logistics', description: 'DELIVERED' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'vrl-logistics', description: 'Sample State' })).toEqual({ kind: 'unknown' });
    expect(statusMap.stage('X1', 'delivered')).toBeUndefined();
  });
});
