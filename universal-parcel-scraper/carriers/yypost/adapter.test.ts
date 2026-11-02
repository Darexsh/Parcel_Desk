import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { dateLocalClocks } from '../../places/index.js';
import { adapter, YYPOST_API, YYPOST_CALLBACK, YYPOST_PAGE, yypostLookupUrl, YypostTracker } from './adapter.js';
import { normalizeYypostNumber, parseYypost } from './parser.js';
import { statusMap, yypostStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const PARCEL = 'YY990000001CN';
const UNKNOWN = 'YY990000002CN';
// A number with S10's check digit, which detection names YYpost for.
const POSTAL = 'YY990000006CN';
const ONWARD = `CNPRT${'0'.repeat(19)}1`;

type Row = Record<string, unknown>;
type Item = Row & { details: Row[] };
type Reply = Row & { data: Item[] };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name).replace(/^yypostTrack\((.*)\)$/s, '$1')) as Reply;
const changed = (change: (item: Item, reply: Reply) => void) => {
  const reply = fixture('in-transit');
  change(reply.data[0]!, reply);
  return reply;
};
const jsonp = (body: unknown) => `${YYPOST_CALLBACK}(${JSON.stringify(body)})`;
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A row of YYpost's own, with a synthetic code of its; the onward network's rows carry none.
const scan = (date: string, description: string, location = '', code = 'ZZ') => ({
  track_occur_date: date, track_location: location, track_description: description, track_description_en: description,
  track_code: code, track_status: '', time_zone: null, utc_offset: null,
});

describe('YYpost HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number in capitals, with the page’s key, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new YypostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' yy 990 000 001 cn ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(YYPOST_API);
    // The key is the Base64 of the query's MD5 in hexadecimal, a digest of the synthetic query.
    expect([...asked.searchParams]).toEqual([['callbackparam', YYPOST_CALLBACK], ['method', 'track'],
      ['key', 'Y2ZhOWEyZGRhYTEyNjI3MzI4NzdmZDI1M2MyYmYyY2Y='], ['param', `{"sp":"","nums":["${PARCEL}"]}`]]); // gitleaks:allow
    expect(String(url)).toBe(yypostLookupUrl(PARCEL));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: `${YYPOST_PAGE}?c=${PARCEL}`, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'yypost', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads its scans on their wall clocks, with the places, the onward number and none of the merchant’s details', () => {
    const result = parseYypost(fixture('in-transit'), PARCEL);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Import customs clearance completed', last_update: null, last_update_local: '2026-05-12T07:48:00',
      expected_delivery: null, destination_country: 'PT', delivery_tracking_number: ONWARD });
    expect(result.events!.map((event) => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-05-12T07:48:00', 'AMS', 'Import customs clearance completed', 'in_transit'],
      ['2026-05-12T06:48:00', 'AMS', 'Import clearance start', 'customs'],
      ['2026-05-10T12:45:00', 'AMS', 'Flight arrival', 'in_transit'],
      ['2026-05-09T22:48:00', 'HKG', 'Flight departure', 'in_transit'],
      // The row listed twice counts once.
      ['2026-05-09T11:43:00', 'HKG', 'Handover to airline', 'in_transit'],
      ['2026-05-08T17:00:00', 'HKG', 'Export customs clearance completed', 'in_transit'],
      // Ecoscooting's own row, on Spain's clock.
      [undefined, undefined, 'create, Shipment order created', 'registered'],
      ['2026-05-06T23:50:00', 'SHENZHEN', 'Has left the warehouse', 'in_transit'],
      ['2026-05-06T15:55:00', 'SHENZHEN', 'Has been put into storage', 'accepted'],
    ]);
    expect(result.events![6]).toMatchObject({ time: '2026-05-07T17:24:00+02:00' });
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !('provider_code' in event)
      && ('time' in event) !== ('local_time' in event))).toBe(true);
    const json = JSON.stringify(result);
    for (const excluded of ['SAMPLEORDER0001', '900000', '800000', 'QGWC', '目的国清关完成']) expect(json).not.toContain(excluded);
  });

  it('keeps the parcel where it was when the shipment order comes after it left the warehouse', () => {
    const result = parseYypost(changed((item) => {
      item.details = [scan('2026-05-07 17:24:00', 'create, Shipment order created', '', ''), scan('2026-05-06 23:50:00', 'Has left the warehouse', 'SHENZHEN'),
        scan('2026-05-06 15:55:00', 'Has been put into storage', 'SHENZHEN')];
    }), PARCEL);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'create, Shipment order created',
      last_update: '2026-05-07T17:24:00+02:00' });
    expect(result).not.toHaveProperty('last_update_local');
    const ordered = parseYypost(changed((item) => { item.details = [scan('2026-05-07 17:24:00', 'create, Shipment order created')]; }), PARCEL);
    expect(ordered).toMatchObject({ status: 'pending', current_stage: 'registered' });
  });

  it('dates the rows Ecoscooting writes, without a code of YYpost’s or a place, on Spain’s clock when it carries the parcel on', () => {
    const relayed = (channel: string, ...details: Row[]) => parseYypost(changed((item) => {
      item.channel_hawbcode = channel;
      item.details = details;
    }), PARCEL);
    const winter = relayed(ONWARD, scan('2026-01-07 17:24:00', 'Sample Partner Note', '', ''), scan('2026-01-06 23:50:00', 'Has left the warehouse', 'SHENZHEN'));
    expect(winter.events![0]).toEqual({ time: '2026-01-07T17:24:00+01:00', description: 'Sample Partner Note' });
    expect(winter).toMatchObject({ last_update: '2026-01-07T17:24:00+01:00' });
    // Dating by place leaves the instant alone and still dates YYpost's own rows.
    const dated = dateLocalClocks('yypost', winter);
    expect(dated.events![0]).toEqual(winter.events![0]);
    expect(dated.events![1]).toMatchObject({ time: '2026-01-06T23:50:00+08:00', time_zone: 'Asia/Shanghai' });
    // A coded or placed row is YYpost's, and another onward network's row keeps its wall clock.
    const own = [scan('2026-05-07 17:24:00', 'Sample Status Note'), scan('2026-05-07 16:24:00', 'Sample Status Note', 'SAMPLE TOWN', '')];
    expect(relayed(ONWARD, ...own).events!.map((event) => [event.local_time, event.time]))
      .toEqual([['2026-05-07T17:24:00', undefined], ['2026-05-07T16:24:00', undefined]]);
    for (const channel of ['SAMPLEREF0001', '']) {
      const other = relayed(channel, scan('2026-05-07 17:24:00', 'Sample Partner Note', '', ''));
      expect(other.events).toEqual([{ local_time: '2026-05-07T17:24:00', description: 'Sample Partner Note' }]);
      expect(other).toMatchObject({ last_update: null, last_update_local: '2026-05-07T17:24:00' });
    }
  });

  it('checks every clock, stages new wording through the shared rules, and drops who took a delivery', () => {
    for (const date of ['2026-05-10 24:00:00', '2026-02-30 08:00:00', '2026-05-10T08:00:00', '2026-05-10 08:00', '', null]) {
      expect(() => parseYypost(changed((item) => { item.details = [{ ...scan('', 'Flight arrival'), track_occur_date: date }]; }), PARCEL), String(date))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const worded = parseYypost(changed((item) => {
      item.details = [scan('2026-05-16 08:00:00', 'Delivered, signed by SAMPLE RECIPIENT', 'SAMPLE TOWN'), scan('2026-05-16 07:00:00', 'Out for delivery'),
        scan('2026-05-15 07:00:00', 'Sample Status Note')];
    }), PARCEL);
    expect(worded.events!.map((event) => [event.description, event.stage, event.stage_source])).toEqual([
      ['Delivered', 'delivered', 'wording:language'], ['Out for delivery', 'out_for_delivery', 'wording:language'],
      ['Sample Status Note', undefined, undefined]]);
    expect(worded).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language' });
    expect(worded).not.toHaveProperty('delivered_at');
    const unstaged = parseYypost(changed((item) => { item.details = [scan('2026-05-15 07:00:00', 'Sample Status Note')]; }), PARCEL);
    expect(unstaged).toMatchObject({ status: 'unknown' });
    expect(unstaged).not.toHaveProperty('current_stage');
  });

  it('reads the Chinese wording when there is no English, and drops rows without either, postcodes and an unusable onward number', () => {
    const result = parseYypost(changed((item) => {
      item.channel_hawbcode = 'SAMPLE-REF/1';
      item.destination_country = '';
      item.details = [{ ...scan('2026-05-16 08:00:00', ''), track_description: '已签收', track_location: 'SAMPLE TOWN 0000' },
        scan('2026-05-16 07:00:00', '')];
    }), PARCEL);
    expect(result.events).toEqual([{ local_time: '2026-05-16T08:00:00', location: 'SAMPLE TOWN', description: '已签收' }]);
    expect(result).not.toHaveProperty('destination_country');
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(parseYypost(changed((item) => { item.channel_hawbcode = PARCEL; }), PARCEL)).not.toHaveProperty('delivery_tracking_number');
  });

  it('reads only the tracker’s unknown-number answer as not found, and a parcel without scans as no history', () => {
    expect(() => parseYypost(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseYypost({ success: 0, cnmessage: '参数错误', enmessage: 'Parameter error' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYypost({ success: 0, cnmessage: null, enmessage: 'Sample failure' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseYypost(changed((item) => { item.details = []; }), PARCEL)).toThrow(NoHistoryError);
    expect(() => parseYypost(changed((item) => { item.details = [scan('2026-05-16 07:00:00', '')]; }), PARCEL)).toThrow(NoHistoryError);
  });

  it('reads only the entry that names the whole number asked, and rejects a changed reply', () => {
    for (const change of [
      (item: Item) => { item.server_hawbcode = UNKNOWN; },
      (item: Item) => { item.server_hawbcode = `${PARCEL}1`; },
      (item: Item, whole: Reply) => { whole.data.push({ ...item }); },
      (_item: Item, whole: Reply) => { whole.data = []; },
      (_item: Item, whole: Reply) => { whole.success = 1.5; },
      (_item: Item, whole: Reply) => { delete (whole as Row).data; },
      (item: Item) => { (item as Row).details = null; },
      (item: Item) => { (item as Row).details = ['scan']; },
      (item: Item) => { item.details = [{ ...scan('2026-05-16 07:00:00', 'Flight arrival'), track_description_en: 7 }]; },
      (item: Item) => { item.details = Array.from({ length: 501 }, () => scan('2026-05-16 07:00:00', 'Flight arrival')); },
    ]) expect(() => parseYypost(changed(change), PARCEL)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const payload of [null, [], 'reply']) expect(() => parseYypost(payload, PARCEL)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps the newest hundred scans of a long history and says it cut the rest', () => {
    const result = parseYypost(changed((item) => {
      item.details = Array.from({ length: 120 }, (_, index) => scan(`2026-05-10 ${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00`,
        'Flight arrival')).reverse();
    }), PARCEL);
    expect(result.events).toHaveLength(100);
    expect(result).toMatchObject({ history_truncated: true, last_update_local: '2026-05-10T01:59:00' });
  });

  it('reads the reply in the callback it named or bare, and keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(JSON.stringify(fixture('in-transit'))))).track({ number: PARCEL }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(`${text('not-found')};`)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(JSON.stringify(fixture('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    // The lookup answers every number with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(text('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://www.yypostal.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><script>document.cookie="acw_sc__v2=00"</script></html>')).rejects.toMatchObject({ kind: 'challenge' });
    // Another callback's reply, the tracking page, or an empty body in place of the lookup's JSONP.
    await expect(lookup(`otherCallback(${JSON.stringify(fixture('not-found'))})`)).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('<!doctype html><html><head><title>轨迹查询</title></head></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(jsonp({ success: 0, enmessage: 'Parameter error' }))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: PARCEL })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    });

  it('refuses numbers outside YYpost’s layout, and pre-aborted or spent lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['YY99000001CN', 'YY9900000001CN', 'YX990000001CN', 'YY990000001HK', 'SAMPLETRACKING', `YY${'0'.repeat(70)}CN`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: PARCEL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: PARCEL }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeYypostNumber('yy 990-000-001 cn')).toBe(PARCEL);
    expect(carrier(fetcher).recognize).toBeUndefined();
  });

  it('sends a read that fails to connect or hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('in-transit')));
    await expect(carrier(flaky).track({ number: PARCEL })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const started = performance.now();
    const slow = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(slow.fetcher).track({ number: PARCEL }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(slow.fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(slow.ended.map((at) => at - started)).toEqual([60, 120]);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(512 * 1024 + 1)));
    await expect(carrier(large).track({ number: PARCEL })).rejects.toThrow('unexpectedly large');
  });

  it('is named for YY and CN numbers with S10’s check digit, which China Post keeps otherwise', () => {
    expect(detectCarrierMatch(POSTAL)).toMatchObject({ carrier: 'yypost', confidence: 'high', candidates: ['yypost'] });
    expect(detectCarrierMatch('YX990000006CN')).toMatchObject({ carrier: 'china-post', confidence: 'high' });
    expect(detectCarrierMatch('YY990000007CN').candidates).not.toContain('yypost');
    expect(detectCarrierMatch('YY990000006HK').candidates).not.toContain('yypost');
  });

  it('answers a number detection names YYpost for, and proposes Ecoscooting for the onward number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url).startsWith(YYPOST_API)
      ? reply(jsonp(changed((item) => { item.server_hawbcode = POSTAL; }))) : new Response('', { status: 503 })));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    const answer = await tracker.track({ number: POSTAL }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'yypost', source: 'yypost', result: { current_stage: 'in_transit' },
      handoff: { carrier: 'ecoscooting', number: ONWARD, confirmed: false } });
    expect(fetcher.mock.calls.filter(([url]) => String(url).startsWith(YYPOST_API)).map(([url]) => String(url)))
      .toEqual([yypostLookupUrl(POSTAL)]);
  });
});

describe('YYpost status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'yypost', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(yypostStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'yypost', providerCode: null, description: 'Sample Status Note' })).toEqual({ kind: 'unknown' });
    expect(statusMap.stage('QGWC', 'flight arrival')).toBeUndefined();
    for (const wording of ['constructor', 'toString', 'Sample Status Note']) expect(yypostStage(wording), wording).toBeNull();
  });
});
