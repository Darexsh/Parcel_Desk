import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, FAR_PAGE, FAR_RESULT, farResultUrl, FarTracker } from './adapter.js';
import { normalizeFarNumber, parseFar } from './parser.js';
import { farStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const PARCEL = 'FARAA9900000001YQ';
const BILINGUAL = 'FARBB9900000002YQ';
const UNKNOWN = 'FARCC9900000003YQ';

const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const row = (clock: string, place: string, zone: string, wording: string) =>
  `<dd class=""><span><b></b>${clock}</span><span>${place}</span><span>${zone}</span><span>${wording}</span></dd>`;
/** The delivered page with its scans replaced. */
const rows = (...scans: string[]) => page('delivered').replace(/<dl>[\s\S]*<\/dl>/, `<dl>${scans.join('')}</dl>`);

describe('FAR International HTTP adapter', () => {
  it('opens the results page for the whole number in capitals, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new FarTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' faraa 9900-0000-01 yq ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(FAR_RESULT);
    expect([...asked.searchParams]).toEqual([['key', PARCEL]]);
    expect(String(url)).toBe(farResultUrl(PARCEL));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: FAR_PAGE, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'far-international', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the scans at the offsets the tracker states, ordered by instant, and not the page’s summary', () => {
    const result = parseFar(page('delivered'), PARCEL);
    // The summary reads 在途 (in transit) under a delivery.
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Package delivered', last_update: '2026-03-12T12:11:15-05:00', expected_delivery: null,
      delivered_at: '2026-03-12T12:11:15-05:00', delivery_tracking_number: '799900000001' });
    expect(result.events!.map((event) => [event.time, event.location, event.description, event.stage])).toEqual([
      ['2026-03-12T12:11:15-05:00', 'Springfield, IL, US', 'Package delivered', 'delivered'],
      ['2026-03-12T07:05:00-05:00', 'SPRINGFIELD, IL, US', 'On FedEx vehicle for delivery', 'out_for_delivery'],
      // The row listed twice counts once.
      ['2026-03-12T06:45:00-05:00', 'SPRINGFIELD, IL, US', 'At local FedEx facility', 'in_transit'],
      ['2026-03-11T00:58:00-05:00', 'PEORIA, IL, US', '包裹开始派送', 'in_transit'],
      // The row without wording is left out.
      ['2026-03-09T10:00:00-05:00', 'ORD', 'Received by local delivery company', 'in_transit'],
      ['2026-03-08T19:00:00-05:00', 'ORD', '进口清关完成', 'in_transit'],
      // Listed after the flight's departure, which came first.
      ['2026-03-06T16:27:40-05:00', 'ORD', '开始清关', 'customs'],
      ['2026-03-07T03:13:00+08:00', 'HKG', 'Flight has departed', 'in_transit'],
      ['2026-02-28T01:54:51-05:00', 'US', 'Last Mile Label Create', 'registered'],
      ['2026-02-28T13:49:10+08:00', 'CN', 'Arrived at departure transport hub', 'in_transit'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !('local_time' in event))).toBe(true);
    const json = JSON.stringify(result);
    for (const excluded of ['TESTER', '1Z0000000000000000', '在途', '【']) expect(json).not.toContain(excluded);
  });

  it('keeps the wall clock of a scan without a zone, in the page’s order, and the English half of bilingual wording', () => {
    const result = parseFar(page('bilingual'), BILINGUAL);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Out For Delivery',
      last_update: null, last_update_local: '2025-12-04T08:48:27' });
    // The last-mile number is FAR's own.
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result.events!.map((event) => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2025-12-04T08:48:27', 'Testville', 'Out For Delivery', 'out_for_delivery'],
      ['2025-12-01T03:07:00', 'Testville', 'Arrived at Facility', 'in_transit'],
      ['2025-11-29T12:15:00', 'Exampleton', 'Departed from Facility', 'in_transit'],
      ['2025-11-29T11:33:19', 'Exampleton', 'Import Scan', 'in_transit'],
      ['2025-11-28T14:25:00', 'Chek Lap Kok', 'Departed from Facility', 'in_transit'],
      ['2025-11-25T00:20:34', 'Chek Lap Kok', 'Export Scan', 'in_transit'],
      ['2025-11-23T18:47:35', 'Yiwu', 'Export Custom Clearance Processing and Flight Booking', 'customs'],
      ['2025-11-22T21:07:47', 'Yiwu', 'Pickup Scan', 'in_transit'],
      ['2025-11-19T10:16:41', 'Yiwu', 'Arrived at Warehouse', 'accepted'],
    ]);
    expect(result.events!.some((event) => 'time' in event)).toBe(false);
    // A delivery without an instant has no delivered_at.
    const delivered = parseFar(rows(row('2025-12-05 10:00:00', '【Testville】', '', '快件已签收 DELIVERED')), PARCEL);
    expect(delivered).toMatchObject({ status: 'delivered', last_update_local: '2025-12-05T10:00:00' });
    expect(delivered).not.toHaveProperty('delivered_at');
  });

  it('keeps a wall clock beside instants in the page’s order', () => {
    const mixed = parseFar(rows(row('2026-03-07 03:13:00', '【HKG】', 'GMT+08:00', 'Flight has departed'),
      row('2026-03-06 16:27:40', '【ORD】', '', '开始清关')), PARCEL);
    expect(mixed.events!.map((event) => [event.time, event.local_time])).toEqual([
      ['2026-03-07T03:13:00+08:00', undefined], [undefined, '2026-03-06T16:27:40']]);
    expect(mixed).toMatchObject({ current_stage: 'in_transit', last_update: '2026-03-07T03:13:00+08:00' });
    expect(mixed).not.toHaveProperty('last_update_local');
  });

  it('maps the recorded wording, and stages new wording through the shared rules', () => {
    expect(farStage('Last Mile Label Create')).toEqual({ stage: 'registered', source: 'carrier_map' });
    expect(farStage('包裹开始派送')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(farStage('Picked up by Customs clearance company')).toEqual({ stage: 'customs', source: 'carrier_map' });
    // The last-mile label, listed after the parcel reached the hub, is no step back.
    const labelled = parseFar(rows(row('2026-02-28 01:54:51', '【,,US】', 'GMT-05:00', 'Last Mile Label Create'),
      row('2026-02-28 13:49:10', '【CN】', 'GMT+08:00', 'Arrived at departure transport hub')), PARCEL);
    expect(labelled).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Last Mile Label Create' });
    const worded = parseFar(rows(row('2026-03-12 12:00:00', '【Springfield,IL,US】', 'GMT-05:00', 'Shipment delivered, signed by SAMPLE RECIPIENT'),
      row('2026-03-12 11:00:00', '', 'GMT-05:00', 'Sample Status Note')), PARCEL);
    expect(worded.events!.map((event) => [event.description, event.location, event.stage, event.stage_source])).toEqual([
      ['Shipment delivered', 'Springfield, IL, US', 'delivered', 'wording:language'], ['Sample Status Note', undefined, undefined, undefined]]);
    expect(JSON.stringify(worded)).not.toContain('SAMPLE RECIPIENT');
    const unstaged = parseFar(rows(row('2026-03-12 11:00:00', '【ORD】', 'GMT-05:00', 'Sample Status Note')), PARCEL);
    expect(unstaged).toMatchObject({ status: 'unknown', last_status_text: 'Sample Status Note' });
    expect(unstaged).not.toHaveProperty('current_stage');
  });

  it('checks every clock and zone', () => {
    for (const [clock, zone] of [['2026-03-12', ''], ['2026-02-30 10:00:00', ''], ['2026/03/12 10:00:00', ''], ['', ''],
      ['2026-03-12 10:00:00', 'America/Chicago'], ['2026-03-12 10:00:00', 'GMT+15:00'], ['2026-03-12 10:00:00', 'GMT-05:60'],
      ['2026-03-12 10:00:00', '-05:00']] as const) {
      expect(() => parseFar(rows(row(clock, '【ORD】', zone, 'Arrived at Facility')), PARCEL), `${clock} ${zone}`)
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const east = parseFar(rows(row('2026-03-12 10:00', '【DEL】', 'GMT+05:30', 'Arrived at Facility'),
      row('2026-03-12 09:00:00', '【DEL】', 'UTC+0530', 'Departed from Facility')), PARCEL);
    expect(east.events!.map((event) => event.time)).toEqual(['2026-03-12T10:00:00+05:30', '2026-03-12T09:00:00+05:30']);
  });

  it('reads an empty result as no history, and a page of rows without wording as none either', () => {
    expect(() => parseFar(page('no-history'), UNKNOWN)).toThrow(NoHistoryError);
    expect(() => parseFar(rows(row('2026-03-12 10:00:00', '【ORD】', 'GMT-05:00', ' ')), PARCEL)).toThrow(NoHistoryError);
  });

  it('reads only the entry that names the whole number asked, and rejects a changed page', () => {
    const delivered = page('delivered');
    for (const changed of [
      delivered.replace(`<span>${PARCEL}</span><span>在途`, `<span>${UNKNOWN}</span><span>在途`),
      delivered.replace(`<span>${PARCEL}</span><span>在途`, `<span>${PARCEL}1</span><span>在途`),
      delivered.replace(/<ul>([\s\S]*)<\/ul>/, '<ul>$1$1</ul>'),
      delivered.replace(/<ul>[\s\S]*<\/ul>/, '<ul></ul>'),
      delivered.replace('<span>轨迹时区</span>', ''),
      delivered.replace('<span>轨迹描述</span>', '<span>描述</span>'),
      delivered.replace(/<span><b><\/b>2026-03-12 12:11:15<\/span>/, ''),
      rows(...Array.from({ length: 501 }, () => row('2026-03-12 10:00:00', '【ORD】', 'GMT-05:00', 'Arrived at Facility'))),
      '<!DOCTYPE html><html><head><title>泛远国际</title></head><body></body></html>',
      '',
    ]) expect(() => parseFar(changed, PARCEL)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // Another number's entry beside the one asked is left alone.
    const both = delivered.replace('<ul>', `<ul><li><h4><span>${UNKNOWN}</span><span>已签收</span></h4></li>`);
    expect(parseFar(both, PARCEL)).toMatchObject({ current_stage: 'delivered' });
  });

  it('keeps the newest hundred scans of a long history and says it cut the rest', () => {
    const result = parseFar(rows(...Array.from({ length: 120 }, (_, index) =>
      row(`2026-03-10 ${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00`, '【ORD】', 'GMT-05:00', 'Arrived at Facility'))), PARCEL);
    expect(result.events).toHaveLength(100);
    expect(result).toMatchObject({ history_truncated: true, last_update: '2026-03-10T01:59:00-05:00' });
  });

  it('keeps a moved route, a browser check and a changed page apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(html(body, init))).track({ number: UNKNOWN });
    await expect(lookup(page('no-history'))).rejects.toMatchObject({ kind: 'indeterminate' });
    // The page answers every number with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(page('no-history'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.far800.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><script>var arg1="0000";document.cookie="acw_sc__v2="+arg1</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><head><title>滑动验证页面</title></head></html>')).rejects.toMatchObject({ kind: 'challenge' });
    // A browser check is read before the scans, even beside the results' markup.
    await expect(lookup(`${page('delivered')}<script>var aliyun_waf=1</script>`)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<!doctype html><html><head><title>泛远国际</title></head></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[400, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: PARCEL })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    });

  it('refuses numbers outside FAR’s layout, and pre-aborted or spent lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['FARAA990000001YQ', 'FARAA99000000001YQ', 'FARA19900000001YQ', 'FAXAA9900000001YQ', 'FARAA9900000001YX',
      'SAMPLETRACKING', `FARAA${'0'.repeat(70)}YQ`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: PARCEL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: PARCEL }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeFarNumber('faraa 9900-0000-01 yq')).toBe(PARCEL);
    expect(carrier(fetcher).recognize).toBeUndefined();
  });

  it('sends a read that fails to connect or hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(html(page('delivered')));
    await expect(carrier(flaky).track({ number: PARCEL })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const started = performance.now();
    const slow = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(slow.fetcher).track({ number: PARCEL }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(slow.fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(slow.ended.map((at) => at - started)).toEqual([60, 120]);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(1024 * 1024 + 1)));
    await expect(carrier(large).track({ number: PARCEL })).rejects.toThrow('unexpectedly large');
  });

  it('answers a number detection or a link to its results page names FAR International for', async () => {
    expect(detectCarrierMatch(PARCEL)).toMatchObject({ carrier: 'far-international', confidence: 'high', candidates: ['far-international'] });
    for (const link of [`https://www.far800.com/logistics/result?key=${PARCEL}`, `https://www.far800.com/en/logistics/result?key=${PARCEL}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: PARCEL, carrier: 'far-international', source: 'link' });
    }
    // The page takes any number; the link names FAR only for one it issues.
    expect(parseTrackingInput('https://www.far800.com/logistics/result?key=AB0000000000').carrier).not.toBe('far-international');
    expect(parseTrackingInput('https://www.far800.com/en/logistics/result?key=AB0000000000').carrier).not.toBe('far-international');
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url).startsWith(FAR_RESULT)
      ? html(page('delivered')) : new Response('', { status: 503 })));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: PARCEL }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'far-international', source: 'far-international', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.filter(([url]) => String(url).startsWith(FAR_RESULT)).map(([url]) => String(url))).toEqual([farResultUrl(PARCEL)]);
  });
});

describe('FAR International status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'far-international', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(farStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'far-international', providerCode: null, description: 'Sample Status Note' })).toEqual({ kind: 'unknown' });
    for (const wording of ['constructor', 'toString', 'Sample Status Note']) expect(farStage(wording), wording).toBeNull();
  });
});
