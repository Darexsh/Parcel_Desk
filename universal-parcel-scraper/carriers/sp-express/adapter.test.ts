import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SpExpressTracker, spExpressTrackingUrl } from './adapter.js';
import { normalizeSpExpressNumber, parseSpExpress, parseSpExpressSearchPage } from './parser.js';
import { spExpressStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

// Synthetic SP Express numbers.
const DELIVERED = '483260302000001';
const TRANSIT = '483260410000002';
const ARCHIVED = '483230115000003';
const CAINIAO = 'CZ000000000004';
const UNKNOWN = '483991231000000';

const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
// The tracker's answer to a number it has no parcel for: back to the search page, in a new session.
const sentBack = (location = 'https://en.sp.express/tt', cookie = 'bes=synthetic0session1; path=/') => new Response(null,
  { status: 302, headers: { Location: location, ...(cookie ? { 'Set-Cookie': cookie } : {}) } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const summary = (result: ReturnType<typeof parseSpExpress>) => result.events!.map((event) =>
  [event.local_time, event.description, event.location ?? null, event.stage ?? null]);
const BLOCK = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('SP Express HTTP adapter', () => {
  it('asks the tracker\'s page for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html(page('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SpExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 483 260 410 000 002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://en.sp.express/tt/${TRANSIT}`);
    expect(spExpressTrackingUrl(TRANSIT)).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'sp-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery relayed from the partner, with its places, weight, size and destination country', () => {
    const result = parseSpExpress(page('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Parcel Delivered', last_update: null, last_update_local: '2026-03-09T15:42:00', expected_delivery: null,
      weight_kg: 1.25, dimensions_text: '30 × 20 × 10 cm', destination_country: 'AT' });
    expect(summary(result)).toEqual([
      // The place column names who signed, which is not kept.
      ['2026-03-09T15:42:00', 'Parcel Delivered', null, 'delivered'],
      // The repeated scan is kept once.
      ['2026-03-09T07:05:00', 'Parcel In Delivery', null, 'out_for_delivery'],
      ['2026-03-09T06:58:00', 'Parcel At Dpd Destination Depot', 'Sampleburg', 'in_transit'],
      ['2026-03-08T21:10:00', 'Dpd Internal Forwarding', null, 'in_transit'],
      ['2026-03-06T14:24:00', 'Delivery Taken Over By Dpd', null, 'in_transit'],
      ['2026-03-06T08:15:00', 'Outgoing Manifest Generated', null, 'in_transit'],
      ['2026-03-06T08:14:00', 'In Transit', 'Nysa', 'in_transit'],
      ['2026-03-04T11:02:00', 'In Transit', 'Nysa', 'in_transit'],
      ['2026-03-02T09:34:00', 'System Has Accepted The Order', null, 'registered'],
      ['2026-03-02T09:34:00', 'System Is Processing The Order', null, 'registered'],
      ['2026-03-02T09:34:00', 'Request For Shipping Label', null, 'registered'],
    ]);
    // Scan clocks name no zone and stay local.
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
    // Who signed, the postcodes, the sending date and the partner's site are not kept.
    expect(JSON.stringify(result)).not.toMatch(/Sample\b|A SAMPLE|00-001|0001\b|2026-03-02"|dpd\.com|Poland/i);
    // The page names no partner number, so there is nothing to hand off.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(deliveryHandoff('sp-express', DELIVERED, result)).toBeNull();
  });

  it('reads the places the older layout puts in brackets, and a hub scan dated without a time', () => {
    const result = parseSpExpress(page('in-transit'), TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Przesyłka została zeskanowana w centrum doręczeniowym', last_update_local: '2026-04-14T06:51:00',
      weight_kg: 5, dimensions_text: '10 × 10 × 10 cm', destination_country: 'DE' });
    expect(summary(result)).toEqual([
      ['2026-04-14T06:51:00', 'Przesyłka została zeskanowana w centrum doręczeniowym', 'Sampletown (DE)', 'in_transit'],
      ['2026-04-14T03:03:00', 'W przewozie', 'Sampletown (DE)', 'in_transit'],
      // A wording neither the map nor the shared rules know has no stage.
      ['2026-04-13T19:34:00', 'Przesyłka została procesowa', 'Otherville', null],
      ['2026-04-13T18:08:00', 'W przewozie', 'Otherville, Germany', 'in_transit'],
      ['2026-04-13T09:09:08', 'Przesyłka jest transportowana do kolejnego oddziału podwykonawcy Świata Przesyłek- prosimy oczekiwać kolejnego statusu',
        null, 'in_transit'],
      ['2026-04-13T09:09:08', 'Outgoing manifest generated', null, 'in_transit'],
      // Midnight is a day without a time.
      ['2026-04-13', 'In Transit', 'Nysa', 'in_transit'],
      ['2026-04-10T09:42:14', 'System has accepted the order', null, 'registered'],
      ['2026-04-10T09:42:12', 'System is processing the order', null, 'registered'],
      // A dash is no place.
      ['2026-04-10T09:42:12', 'Request for shipping label', null, 'registered'],
    ]);
  });

  it('reads an older parcel whose history is archived as its current status alone', () => {
    const result = parseSpExpress(page('archived'), ARCHIVED);
    expect(result).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'The shipment has been successfully delivered', last_update: null, expected_delivery: null,
      weight_kg: 15, dimensions_text: '60 × 30 × 35 cm', destination_country: 'FR', summary_only: true, events: [] });
    // A status the map does not know takes the furthest step of the progress rail.
    const rail = parseSpExpress(page('archived').replace('The shipment has been successfully delivered (/France)', 'Zzz'), ARCHIVED);
    expect(rail).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Zzz', summary_only: true });
  });

  it('reads a Cainiao parcel on its own page, without the references in brackets', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html(page('cainiao')));
    const result = await carrier(fetcher).track({ number: CAINIAO.toLowerCase() });
    expect(String(fetcher.mock.calls[0]![0])).toBe(`https://en.sp.express/tt-cainiao/${CAINIAO}`);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'PRZESYŁKA DOTARŁA DO ODDZIAŁU',
      weight_kg: 0.065, destination_country: 'CZ' });
    expect(summary(result)).toEqual([
      ['2026-05-08T10:34:47', 'PRZESYŁKA DOTARŁA DO ODDZIAŁU', null, 'in_transit'],
      ['2026-05-08', 'Inbound scan', 'Nysa', 'accepted'],
      ...['2026-05-05T05:22:27', '2026-05-01T13:30:25'].map((clock) => [clock, 'Posiadamy Dane elektroniczne, ale przesyłka jeszcze nie została nadana. '
        + 'Będzie ona transportowana trybem ekonomicznym do UE, i trafi do agencji celnej. Doręczenia można spodziewać się do 60 dni.', null, 'registered']),
      ['2026-05-01T12:13:56', 'Zlecenie zaakceptowane', null, 'registered'],
      ['2026-05-01T12:13:56', 'Nowe zlecenie', null, 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SINT|00004\b/);
  });

  it('follows the redirect for an unknown number to the search page\'s notice, in the session it opened', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(sentBack()).mockResolvedValueOnce(html(page('not-found')));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[1]!;
    expect(String(url)).toBe('https://en.sp.express/tt');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { Cookie: 'bes=synthetic0session1' } });
    const cainiao = vi.fn<typeof fetch>().mockResolvedValueOnce(sentBack('/tt-cainiao'))
      .mockResolvedValueOnce(html(page('not-found')));
    await expect(carrier(cainiao).track({ number: 'PL000000000000' })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(cainiao.mock.calls[1]![0])).toBe('https://en.sp.express/tt-cainiao');
    expect(() => parseSpExpress(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('reads no answer from a redirect elsewhere, without a session, or to a search page without the notice', async () => {
    const lookup = (...replies: Response[]) => {
      const fetcher = vi.fn<typeof fetch>();
      for (const reply of replies) fetcher.mockResolvedValueOnce(reply);
      return carrier(fetcher).track({ number: UNKNOWN });
    };
    await expect(lookup(sentBack('https://en.sp.express/'))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(sentBack('https://en.sp.express/tt-cainiao'))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(sentBack(undefined, ''))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(sentBack(), html(page('not-found').replace(/\$\.notify\([^;]*;/, ''))))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(sentBack(), sentBack())).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(sentBack(), html(BLOCK))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(sentBack(), html('', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(() => parseSpExpressSearchPage(page('not-found').replace('Shipping not find', 'Shipping found')))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('binds the page to the whole number asked through its Reference link', () => {
    expect(() => parseSpExpress(page('in-transit'), '483260410000009'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'SP Express answered for another number' }));
    // The link must open the number on the page it was asked on.
    expect(() => parseSpExpress(page('in-transit').replace(`/tt/${TRANSIT}">trace`, `/tt-cainiao/${TRANSIT}">trace`), TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSpExpress(page('in-transit').replace('<h2>Reference</h2>', '<h2>Links</h2>'), TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseSpExpress(page('cainiao').replace(`/tt-cainiao/${CAINIAO}">`, `/tt-cainiao/${CAINIAO.toLowerCase()}">`), CAINIAO).events)
      .toHaveLength(6);
  });

  it('reads a shipment without scans or a status as no history', () => {
    const empty = page('in-transit').replace(/(<tr class="header">[^\n]*\n)[\s\S]*?(\s*<\/table>)/, '$1$2')
      .replace(/(class="tt-status-bar"[^>]*>)[^<]*/, '$1  ');
    expect(() => parseSpExpress(empty, TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects a changed page', () => {
    for (const change of [
      (body: string) => body.replace('2026-04-14 06:51:00', '2026-04-14 06:51:0'),
      (body: string) => body.replace('2026-04-14 06:51:00', '2026-02-30 06:51:00'),
      (body: string) => body.replace('2026-04-14 06:51:00', '14.04.2026 06:51'),
      (body: string) => body.replace('<td>W przewozie (Sampletown (DE))</td>', '<td> </td>'),
      (body: string) => body.replace('<td>Status</td></tr>', '<td>Status</td><td>Uwagi</td></tr>'),
      (body: string) => body.replace('<td>Data</td>', '<td>Date</td>'),
      (body: string) => body.replace('<td>W przewozie (Otherville/Germany)</td>', '<td>W przewozie</td><td>Otherville</td>'),
      (body: string) => body.replace(/<table class="list hTop"[\s\S]*?<\/table>/, ''),
      (body: string) => body.replace('</table>', '</table><table class="list hTop"></table>'),
      (body: string) => body.replace('<div class="tt-status-bar"', '<div class="tt-status-bar"></div><div class="tt-status-bar"'),
      (body: string) => body.replace(/<tr class="header">[^\n]*\n/,
        `$&${'<tr><td>2026-04-01 10:00:00</td><td>W przewozie</td></tr>'.repeat(301)}`),
      (body: string) => body.replace(/<form id="tt-form"[\s\S]*?<\/form>/, ''),
      (body: string) => body.replace(/<div class="tt-status-bar"[\s\S]*?<\/div>/, ''),
    ]) {
      expect(() => parseSpExpress(change(page('in-transit')), TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps a moved route, a block page, a rate limit and a broken page apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(html(body, init))).track({ number: TRANSIT });
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(BLOCK)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(BLOCK, { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(BLOCK, { status: 429, headers: { 'Retry-After': '10' } }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 10_000 });
    await expect(lookup('<html><title>SP Express</title><body>Home</body></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and an unknown one, and asks nothing for a number SP Express does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(html(page('delivered')))
      .mockResolvedValueOnce(html(page('archived'))).mockResolvedValueOnce(sentBack()).mockResolvedValueOnce(html(page('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-09T15:42:00' });
    await expect(carrier(fetcher).recognize!(ARCHIVED)).resolves.toEqual({ known: true, lastActivityAt: null });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    // BRT's and Yunda's fifteen digits without SP Express's prefix and date.
    await expect(carrier(fetcher).recognize!('123456789012345')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('tries once more after a failure to reach the tracker, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(html(page('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SpExpressTracker({ fetcher, recorder }).fetch(TRANSIT, { budgetMs: 2000 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'sp-express', step: 'retry', outcome: 'ok' }));
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: TRANSIT }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects numbers SP Express does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['000000000000000', '483261302000001', '483260232000001', '48326030200000', '4832603020000011',
      '493260302000001', 'CZ00000000004', 'CZ0000000000044', 'C1000000000004', '06000000000000', `483${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSpExpressNumber(' cz-0000-0000-0004 ')).toBe(CAINIAO);
  });

  it('routes a number filed under SP Express, or in a tracker link, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url) === spExpressTrackingUrl(DELIVERED)
      ? html(page('delivered')) : new Response('', { status: 404 })));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'sp-express' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'sp-express', source: 'sp-express', result: { current_stage: 'delivered' } });
    for (const link of [`https://en.sp.express/tt/${DELIVERED}`, `https://sp.express/tt/${DELIVERED}`,
      `https://en.sp.express/tt-cainiao/${CAINIAO}`, `https://swiatprzesylek.pl/tt-cainiao/${CAINIAO}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ carrier: 'sp-express', confidence: 'high' });
    }
  });
});

describe('SP Express numbers', () => {
  it('offers its order numbers beside BRT and Yunda, and leaves Cainiao numbers to links and the caller', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ confidence: 'low', candidates: expect.arrayContaining(['sp-express', 'brt', 'yunda']) });
    expect(detectCarrierMatch(CAINIAO).candidates).not.toContain('sp-express');
  });
});

describe('SP Express status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMap.stage(null, entry.wording), entry.wording).toBe(entry.stage);
      expect(spExpressStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'sp-express', description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    // The tracker writes a wording in any letter case.
    expect(spExpressStage('OUTGOING MANIFEST GENERATED')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(statusMapAnswer({ carrier: 'sp-express', description: 'Przesyłka została procesowa' })).toEqual({ kind: 'unknown' });
  });
});
