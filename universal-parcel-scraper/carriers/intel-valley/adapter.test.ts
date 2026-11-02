import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, INTEL_VALLEY_API, INTEL_VALLEY_CALLBACK, INTEL_VALLEY_PAGE, intelValleyLookupUrl, IntelValleyTracker } from './adapter.js';
import { normalizeIntelValleyNumber, parseIntelValley } from './parser.js';
import { flightBooked, intelValleyStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const PARCEL = 'IV123400000017';
const UNKNOWN = 'IV123400000028';

type Row = Record<string, unknown>;
type Item = Row & { details: Row[] };
type Reply = Row & { data: Item[] };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name).replace(/^intelValleyTrack\((.*)\)$/s, '$1')) as Reply;
const changed = (change: (item: Item, reply: Reply) => void) => {
  const reply = fixture('in-transit');
  change(reply.data[0]!, reply);
  return reply;
};
const jsonp = (body: unknown) => `${INTEL_VALLEY_CALLBACK}(${JSON.stringify(body)})`;
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const scan = (date: string, description: string, location = '') => ({
  track_occur_date: date, track_location: location, track_description: description, track_description_en: description,
  track_code: '', track_status: '', gmt_offset: '+08:00',
});

describe('Intel-Valley HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number in capitals, with the page’s key, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new IntelValleyTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' iv 1234 0000 0017 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(INTEL_VALLEY_API);
    // The key is the Base64 of the query's MD5 in hexadecimal, a digest of the synthetic query.
    expect([...asked.searchParams]).toEqual([['callbackparam', INTEL_VALLEY_CALLBACK], ['method', 'track'],
      ['key', 'MzE2N2M5YTY0OTEwNDE1Zjg1N2E2ZDVlMGEyOTAwYmM='], ['param', `{"sp":"","nums":["${PARCEL}"]}`]]); // gitleaks:allow
    expect(String(url)).toBe(intelValleyLookupUrl(PARCEL));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: `${INTEL_VALLEY_PAGE}?c=${PARCEL}`, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'intel-valley', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads its scans on their wall clocks, whatever offset they state, with the places and none of the merchant’s details', () => {
    const result = parseIntelValley(fixture('in-transit'), PARCEL);
    const arrived = 'The flight has arrived, and cargo pickup and customs clearance are expected today.';
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map',
      last_status_text: arrived, last_update: null, last_update_local: '2026-07-04T06:58:50', expected_delivery: null,
      destination_country: 'GB' });
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result.events!.map((event) => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-07-04T06:58:50', 'LHR', arrived, 'customs'],
      ['2026-07-03T20:05:00', 'HKG', 'The flight has departed', 'in_transit'],
      // The booked flight is left out, and the row listed twice counts once.
      ['2026-07-01T10:50:31', 'SHENZHEN', 'During transportation', 'in_transit'],
      // The postcode in the place is dropped.
      ['2026-06-28T15:43:21', 'SHENZHEN', 'Shipment departed from facility', 'in_transit'],
      ['2026-06-28T13:32:17', 'SHENZHEN', 'Shipment arrived at facility', 'in_transit'],
      ['2026-06-25T21:09:53', undefined, 'Shipment information received', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !('time' in event))).toBe(true);
    const json = JSON.stringify(result);
    for (const excluded of ['SAMPLEORDER0001', '900000', '800000', '518000', '英国']) expect(json).not.toContain(excluded);
  });

  it('stages new wording through the shared rules, drops who took a delivery, and keeps the onward number', () => {
    const worded = parseIntelValley(changed((item) => {
      item.channel_hawbcode = 'SAMPLE0000000001';
      item.details = [scan('2026-07-08 08:00:00', 'Delivered, signed by SAMPLE RECIPIENT', 'SAMPLE TOWN'), scan('2026-07-08 07:00:00', 'Out for delivery'),
        scan('2026-07-07 07:00:00', 'Sample Status Note')];
    }), PARCEL);
    expect(worded.events!.map((event) => [event.description, event.stage, event.stage_source])).toEqual([
      ['Delivered', 'delivered', 'wording:language'], ['Out for delivery', 'out_for_delivery', 'wording:language'],
      ['Sample Status Note', undefined, undefined]]);
    expect(worded).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivery_tracking_number: 'SAMPLE0000000001' });
    // A shipment order recorded after the parcel left keeps it where it was.
    const ordered = parseIntelValley(changed((item) => {
      item.details = [scan('2026-07-02 08:00:00', 'Shipment information received'), scan('2026-07-01 10:50:31', 'During transportation')];
    }), PARCEL);
    expect(ordered).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Shipment information received' });
    // A placeholder in the place names none.
    const placeholder = parseIntelValley(changed((item) => { item.details = [scan('2026-07-01 10:50:31', 'During transportation', '--')]; }), PARCEL);
    expect(placeholder.events![0]).not.toHaveProperty('location');
    const unstaged = parseIntelValley(changed((item) => { item.details = [scan('2026-07-07 07:00:00', 'Sample Status Note')]; }), PARCEL);
    expect(unstaged).toMatchObject({ status: 'unknown' });
    expect(unstaged).not.toHaveProperty('current_stage');
  });

  it('reads only the tracker’s unknown-number answer as not found, a parcel without scans or with only a booked flight as no history, and rejects a changed reply', () => {
    expect(() => parseIntelValley(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseIntelValley({ success: 0, cnmessage: '参数错误', enmessage: 'Parameter error' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseIntelValley({ success: 0, cnmessage: null, enmessage: 'Sample failure' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseIntelValley(changed((item) => { item.details = []; }), PARCEL)).toThrow(NoHistoryError);
    expect(() => parseIntelValley(changed((item) => { item.details = [scan('2026-07-07 07:00:00', 'Estimated 07.08 flights')]; }), PARCEL)).toThrow(NoHistoryError);
    for (const change of [
      (item: Item) => { item.server_hawbcode = UNKNOWN; },
      (item: Item, whole: Reply) => { whole.data.push({ ...item }); },
      (item: Item) => { (item as Row).details = null; },
      (item: Item) => { item.details = [{ ...scan('2026-07-08 07:00:00', 'During transportation'), track_occur_date: '2026-02-30 08:00:00' }]; },
    ]) expect(() => parseIntelValley(changed(change), PARCEL)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads the reply in the callback it named or bare, and keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(JSON.stringify(fixture('in-transit'))))).track({ number: PARCEL }))
      .resolves.toMatchObject({ current_stage: 'customs' });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(text('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://www.qhzhigu.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><script>document.cookie="acw_sc__v2=00"</script></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(`otherCallback(${JSON.stringify(fixture('not-found'))})`)).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(jsonp({ success: 0, enmessage: 'Parameter error' }))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']] as const)('preserves HTTP %s as %s, without a retry', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
    await expect(carrier(fetcher).track({ number: PARCEL })).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('refuses numbers outside Intel-Valley’s layout, and pre-aborted or spent lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['IV12340000001', 'IV1234000000171', 'IX123400000017', 'SAMPLETRACKING', `IV${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    await expect(carrier(fetcher).track({ number: PARCEL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: PARCEL }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeIntelValleyNumber('iv-1234-0000-0017')).toBe(PARCEL);
  });

  it('sends a read that fails to connect or hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('in-transit')));
    await expect(carrier(flaky).track({ number: PARCEL })).resolves.toMatchObject({ current_stage: 'customs' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const started = performance.now();
    const slow = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(slow.fetcher).track({ number: PARCEL }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(slow.ended.map((at) => at - started)).toEqual([60, 120]);
  });
});

describe('Intel-Valley numbers', () => {
  it('suggests IV and twelve digits, and recognition asks the tracker, which files a parcel it knows', async () => {
    expect(detectCarrierMatch(PARCEL)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['intel-valley'] });
    for (const countryHint of [undefined, 'GB', 'IT']) expect(recognitionAskedCarriers(PARCEL, { countryHint })).toEqual(['intel-valley']);
    for (const other of ['IV12340000001', 'IV1234000000171', 'IVA23400000017']) {
      expect(detectCarrierMatch(other).candidates ?? [], other).not.toContain('intel-valley');
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url).startsWith(INTEL_VALLEY_API)
      ? reply(text('in-transit')) : new Response('', { status: 503 })));
    await expect(carrier(fetcher).recognize!(PARCEL)).resolves.toMatchObject({ known: true });
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: PARCEL, carrier: 'intel-valley' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'intel-valley', source: 'intel-valley', result: { current_stage: 'customs' } });
  });
});

describe('Intel-Valley status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it, and tells a booked flight apart', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'intel-valley', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(intelValleyStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    for (const wording of ['Estimated 12.01 flights', 'estimated 1.5 flight']) expect(flightBooked(wording), wording).toBe(true);
    for (const wording of ['Estimated flights', 'The flight has departed']) expect(flightBooked(wording), wording).toBe(false);
    expect(statusMapAnswer({ carrier: 'intel-valley', providerCode: null, description: 'Sample Status Note' })).toEqual({ kind: 'unknown' });
    for (const wording of ['constructor', 'toString', 'Sample Status Note', 'Estimated flights']) expect(intelValleyStage(wording), wording).toBeNull();
  });
});
