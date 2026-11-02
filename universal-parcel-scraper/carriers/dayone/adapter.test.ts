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
import { adapter, DAYONE_API, DAYONE_CALLBACK, DAYONE_PAGE, dayoneLookupUrl, DayoneTracker } from './adapter.js';
import { normalizeDayoneNumber, parseDayone } from './parser.js';
import { dayoneCodeStage, dayoneStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'DOT0990000000000001';
const UNKNOWN = 'DOT0990000000000003';
const ERP = 'DOT1990000000000001';

type Row = Record<string, unknown>;
type Item = Row & { details: Row[] };
type Reply = Row & { data: Item[] };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name).replace(/^dayoneTrack\((.*)\)$/s, '$1')) as Reply;
const changed = (change: (item: Item, reply: Reply) => void) => {
  const reply = fixture('delivered');
  change(reply.data[0]!, reply);
  return reply;
};
const jsonp = (body: unknown) => `${DAYONE_CALLBACK}(${JSON.stringify(body)})`;
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const scan = (date: string, description: string, offset = '+08:00') => ({
  track_occur_date: date, track_location: '', track_description: description, track_description_en: description,
  track_code: '', track_status: '', gmt_offset: offset,
});

describe('DayOne HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number in capitals, with the page’s key, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new DayoneTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' dot 0990 0000 0000 0001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(DAYONE_API);
    // The page's jQuery puts the callback first; the key is the Base64 of the query's MD5 in hexadecimal, a digest of the synthetic query.
    expect([...asked.searchParams]).toEqual([['callbackparam', DAYONE_CALLBACK], ['method', 'track'],
      ['key', 'ZTMyNDM1ZjkyMjczMThjZmFlZTc3ZjRhNjhmMTA2MWQ='], ['param', `{"sp":"","nums":["${DELIVERED}"]}`]]); // gitleaks:allow
    expect(String(url)).toBe(dayoneLookupUrl(DELIVERED));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: `${DAYONE_PAGE}?trackNo=${DELIVERED}`, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dayone', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered parcel by its scans’ instants, with the places, the network’s number and none of the merchant’s or recipient’s details', () => {
    const result = parseDayone(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'DELIVERED WITH SAFE DROP', last_update: '2026-04-16T08:58:12+10:00', delivered_at: '2026-04-16T08:58:12+10:00',
      expected_delivery: null, destination_country: 'AU', delivery_tracking_number: 'UL123456785YP' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result.events!.map((event) => [event.time, event.location, event.description, event.stage])).toEqual([
      ['2026-04-16T08:58:12+10:00', 'SAMPLE TOWN NSW', 'DELIVERED WITH SAFE DROP', 'delivered'],
      ['2026-04-16T07:27:27+10:00', 'EXAMPLE CITY NSW', 'WITH AUSTRALIA POST FOR DELIVERY TODAY', 'out_for_delivery'],
      // The row listed twice counts once.
      ['2026-04-15T22:38:09+10:00', 'EXAMPLE CITY NSW', 'PROCESSED THROUGH AUSTRALIA POST FACILITY', 'in_transit'],
      ['2026-04-14T09:22:00+10:00', undefined, 'RECEIVED BY AUSTRALIA POST FOR TRANSPORTATION TO PROCESSING FACILITY', 'in_transit'],
      ['2026-04-13T09:16:00+10:00', undefined, 'CLEARED BY CUSTOMS', 'in_transit'],
      // The same wall clock an hour later in Sydney than at the other offset.
      ['2026-04-12T09:48:00+10:00', 'SAMPLE PORT', 'ARRIVED AT DESTINATION AIRPORT', 'in_transit'],
      ['2026-04-12T09:48:00+11:00', undefined, 'Port of destination - Arrival', 'in_transit'],
      ['2026-04-11T23:39:00+08:00', undefined, 'Port of departure - Departure', 'in_transit'],
      // The tracker lists Australia Post's manifest first by its wall clock; China's scan is later.
      ['2026-04-10T07:28:17+08:00', undefined, 'Arrived at domestic terminal station', 'in_transit'],
      ['2026-04-10T08:21:45+10:00', 'EXAMPLE HUB NSW', 'SHIPPING INFORMATION APPROVED BY AUSTRALIA POST', 'registered'],
      ['2026-04-09T22:18:22+08:00', undefined, 'Yanwen Pickup Scan', 'accepted'],
      ['2026-04-06T11:18:01+08:00', undefined, 'Order processed by shipper', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !('provider_code' in event))).toBe(true);
    const json = JSON.stringify(result);
    for (const excluded of ['SAMPLEORDER0001', 'SAMPLE RECIPIENT', 'example.com', '900000', 'D009', 'Case Close']) expect(json).not.toContain(excluded);
  });

  it('keeps the parcel where it was when the destination post’s manifest comes later', () => {
    const result = parseDayone(changed((item) => {
      item.track_status = 'ND';
      item.details = [scan('2026-04-10 10:00:00', 'SHIPPING INFORMATION RECEIVED BY AUSTRALIA POST', '+10:00'),
        scan('2026-04-10 07:28:17', 'Arrived at domestic terminal station'), scan('2026-04-09 22:18:22', 'Yanwen Pickup Scan')];
    }), DELIVERED);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'SHIPPING INFORMATION RECEIVED BY AUSTRALIA POST', last_update: '2026-04-10T10:00:00+10:00' });
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('keeps a wall clock without a valid offset, in the tracker’s order, and checks every clock', () => {
    const result = parseDayone(changed((item) => {
      item.details = [scan('2026-04-10 09:00:00', 'Sample Status Note', ''), scan('2026-04-10 08:00:00', 'Yanwen facility - Outbound', '+8'),
        scan('2026-04-09 22:18:22', 'Yanwen Pickup Scan')];
    }), DELIVERED);
    expect(result.events!.map((event) => [event.time, event.local_time, event.description])).toEqual([
      [undefined, '2026-04-10T09:00:00', 'Sample Status Note'],
      [undefined, '2026-04-10T08:00:00', 'Yanwen facility - Outbound'],
      ['2026-04-09T22:18:22+08:00', undefined, 'Yanwen Pickup Scan'],
    ]);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-04-10T09:00:00', current_stage: 'in_transit' });
    expect(result.events![0]).not.toHaveProperty('stage');
    for (const date of ['2026-04-10 24:00:00', '2026-02-30 08:00:00', '2026-04-10T08:00:00', '2026-04-10 08:00', '', null]) {
      expect(() => parseDayone(changed((item) => { item.details = [{ ...scan('', 'Yanwen Pickup Scan'), track_occur_date: date }]; }), DELIVERED), String(date))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('takes the summary’s status when no scan has a stage, stages new wording through the shared rules, and drops who took a delivery', () => {
    const summary = parseDayone(changed((item) => { item.track_status = 'DD'; item.details = [scan('2026-04-16 07:00:00', 'Sample Status Note', '+10:00')]; }), DELIVERED);
    expect(summary).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map' });
    expect(summary.events![0]).not.toHaveProperty('stage');
    for (const code of ['NO', 'ED', 'XX', '']) {
      const unstaged = parseDayone(changed((item) => { item.track_status = code; item.details = [scan('2026-04-16 07:00:00', 'Sample Status Note')]; }), DELIVERED);
      expect(unstaged, code).toMatchObject({ status: 'unknown' });
      expect(unstaged, code).not.toHaveProperty('current_stage');
    }
    const worded = parseDayone(changed((item) => {
      item.details = [scan('2026-04-16 08:00:00', 'Delivered, signed by SAMPLE RECIPIENT', '+10:00'), scan('2026-04-16 07:00:00', 'Out for delivery', '+10:00')];
    }), DELIVERED);
    expect(worded.events!.map((event) => [event.description, event.stage, event.stage_source])).toEqual([
      ['Delivered', 'delivered', 'wording:language'], ['Out for delivery', 'out_for_delivery', 'wording:language']]);
    expect(worded).toMatchObject({ current_stage: 'delivered', current_stage_source: 'wording:language', delivered_at: '2026-04-16T08:00:00+10:00' });
  });

  it('reads the Chinese wording when there is no English, and drops rows without either, postcodes and an unusable network number', () => {
    const result = parseDayone(changed((item) => {
      item.channel_hawbcode = 'SAMPLE-REF/1';
      item.destination_country = '';
      item.details = [{ ...scan('2026-04-16 08:00:00', '', '+10:00'), track_description: '已签收', track_location: 'SAMPLE TOWN NSW 2000' },
        { ...scan('2026-04-16 07:00:00', '', '+10:00') }];
    }), DELIVERED);
    expect(result.events).toEqual([{ time: '2026-04-16T08:00:00+10:00', location: 'SAMPLE TOWN NSW', description: '已签收' }]);
    expect(result).toMatchObject({ destination_country: 'AU' });
    expect(result).not.toHaveProperty('delivery_tracking_number');
    const unnamed = parseDayone(changed((item) => { item.destination_country = ''; item.destination_country_enname = 'Sample Land'; }), DELIVERED);
    expect(unnamed).toMatchObject({ destination_country_name: 'Sample Land' });
    expect(unnamed).not.toHaveProperty('destination_country');
  });

  it('reads only the tracker’s unknown-number answer as not found, and a parcel without scans as no history', () => {
    expect(() => parseDayone(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDayone({ success: 0, cnmessage: '参数错误', enmessage: 'Parameter error' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDayone({ success: 0, cnmessage: null, enmessage: 'Sample failure' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseDayone(changed((item) => { item.details = []; }), DELIVERED)).toThrow(NoHistoryError);
    expect(() => parseDayone(changed((item) => { item.details = [scan('2026-04-16 07:00:00', '')]; }), DELIVERED)).toThrow(NoHistoryError);
  });

  it('reads only the entry that names the whole number asked, and rejects a changed reply', () => {
    for (const change of [
      (item: Item) => { item.server_hawbcode = 'DOT0990000000000002'; },
      (item: Item) => { item.server_hawbcode = `${DELIVERED}1`; },
      (item: Item, whole: Reply) => { whole.data.push({ ...item }); },
      (_item: Item, whole: Reply) => { whole.data = []; },
      (_item: Item, whole: Reply) => { whole.success = 1.5; },
      (_item: Item, whole: Reply) => { delete (whole as Row).data; },
      (item: Item) => { (item as Row).details = null; },
      (item: Item) => { (item as Row).details = ['scan']; },
      (item: Item) => { item.details = [{ ...scan('2026-04-16 07:00:00', 'Yanwen Pickup Scan'), track_description_en: 7 }]; },
      (item: Item) => { item.details = Array.from({ length: 501 }, () => scan('2026-04-16 07:00:00', 'Yanwen Pickup Scan')); },
    ]) expect(() => parseDayone(changed(change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const payload of [null, [], 'reply']) expect(() => parseDayone(payload, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps the newest hundred scans of a long history and says it cut the rest', () => {
    const result = parseDayone(changed((item) => {
      item.details = Array.from({ length: 120 }, (_, index) => scan(`2026-04-10 ${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00`,
        'TRANSFERRED')).reverse();
    }), DELIVERED);
    expect(result.events).toHaveLength(100);
    expect(result).toMatchObject({ history_truncated: true, last_update: '2026-04-10T01:59:00+08:00' });
  });

  it('reads the reply in the callback it named or bare, and keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(JSON.stringify(fixture('delivered'))))).track({ number: DELIVERED }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(`${text('not-found')};`)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(JSON.stringify(fixture('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    // The lookup answers every number with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(text('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.dayonetrack.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><script>document.cookie="acw_sc__v2=00"</script></html>')).rejects.toMatchObject({ kind: 'challenge' });
    // Another callback's reply, the tracking page, or an empty body in place of the lookup's JSONP.
    await expect(lookup(`otherCallback(${JSON.stringify(fixture('not-found'))})`)).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('<!doctype html><html><head><title>DayOne Track</title></head></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(jsonp({ success: 0, enmessage: 'Parameter error' }))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    });

  it('refuses numbers DayOne does not issue, leaves the other lookups to providers, and refuses pre-aborted or spent lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['DOT099000000000001', 'DOT09900000000000001', 'DOX0990000000000001', 'DOT099000000000000A', 'SAMPLETRACKING', `DOT${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    // DayOne issues them; its tracker sends DOT1 to a lookup that answers an empty body, and the rest nowhere.
    for (const number of [ERP, 'DOT2990000000000001', 'DOT9990000000000001']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeDayoneNumber('dot 0990-0000-0000-0001')).toBe(DELIVERED);
    // A high-confidence rule settles the carrier, so no recognition is declared.
    expect(carrier(fetcher).recognize).toBeUndefined();
  });

  it('sends a read that fails to connect or hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const started = performance.now();
    const slow = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(slow.fetcher).track({ number: DELIVERED }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(slow.fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(slow.ended.map((at) => at - started)).toEqual([60, 120]);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(512 * 1024 + 1)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('routes a DayOne number, which detection settles, to the adapter and proposes the destination’s post for the network’s S10 number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url).startsWith(DAYONE_API)
      ? reply(text('delivered')) : new Response('', { status: 503 })));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    const answer = await tracker.track({ number: DELIVERED }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'dayone', source: 'dayone', result: { current_stage: 'delivered' },
      handoff: { carrier: 'australia-post', number: 'UL123456785YP', confirmed: false } });
    expect(fetcher.mock.calls.filter(([url]) => String(url).startsWith(DAYONE_API)).map(([url]) => String(url)))
      .toEqual([dayoneLookupUrl(DELIVERED)]);
  });
});

describe('DayOne numbers', () => {
  it('claims DOT and sixteen digits, and nothing beside it', () => {
    for (const number of [DELIVERED, UNKNOWN, ERP]) expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'dayone', confidence: 'high' });
    for (const number of ['DOT099000000000001', 'DOT09900000000000001']) expect(detectCarrierMatch(number).carrier, number).not.toBe('dayone');
  });
});

describe('DayOne status vocabulary', () => {
  it('maps every wording and summary status it recorded to the stage recorded for it, and leaves the ones without a milestone out', () => {
    for (const entry of statuses.entries as { code?: string; wording?: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.code) {
        expect(dayoneCodeStage(entry.code), entry.code).toBe(entry.stage);
        expect(statusMap.stage(entry.code, ''), entry.code).toBe(entry.stage);
        expect(statusMapAnswer({ carrier: 'dayone', providerCode: entry.code, description: 'Sample Status Note' }), entry.code)
          .toMatchObject(entry.unmapped ? { kind: 'intentional_gap' } : { kind: 'mapped', stage: entry.stage });
        continue;
      }
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording!)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'dayone', providerCode: null, description: entry.wording! }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(dayoneStage(entry.wording!), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'dayone', providerCode: null, description: 'Sample Status Note' })).toEqual({ kind: 'unknown' });
    expect(statusMap.gaps.every((gap) => gap.code && gap.note)).toBe(true);
    for (const wording of ['constructor', 'toString', 'Sample Status Note']) expect(dayoneStage(wording), wording).toBeNull();
    // The parser never sends a scan's code to the map: a scan's own status names another milestone than the summary's.
    expect(parseDayone(fixture('delivered'), DELIVERED).events!.at(-1)).toMatchObject({ description: 'Order processed by shipper', stage: 'registered' });
  });
});
