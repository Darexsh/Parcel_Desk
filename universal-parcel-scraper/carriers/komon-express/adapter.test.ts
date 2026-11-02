import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, KOMON_API, KOMON_CALLBACK, KOMON_PAGE, komonLookupUrl, KomonTracker } from './adapter.js';
import { normalizeKomonNumber, parseKomon } from './parser.js';
import { komonStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const PARCEL = 'KOMON1234500017YQ';
const UNKNOWN = 'KOMON1234500028YQ';

type Row = Record<string, unknown>;
type Item = Row & { details: Row[] };
type Reply = Row & { data: Item[] };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name).replace(/^komonTrack\((.*)\)$/s, '$1')) as Reply;
const changed = (change: (item: Item, reply: Reply) => void) => {
  const reply = fixture('delivered');
  change(reply.data[0]!, reply);
  return reply;
};
const jsonp = (body: unknown) => `${KOMON_CALLBACK}(${JSON.stringify(body)})`;
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Komon Express HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number in capitals, with the page’s key, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new KomonTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' komon 1234 5000 17 yq ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(KOMON_API);
    // The key is the Base64 of the query's MD5 in hexadecimal, a digest of the synthetic query.
    expect([...asked.searchParams]).toEqual([['callbackparam', KOMON_CALLBACK], ['method', 'track'],
      ['key', 'NzBhMTM4YmE5ZGJjNzllNGNjNzliZDYzOGEzZTA2ZDE='], ['param', `{"sp":"","nums":["${PARCEL}"]}`]]); // gitleaks:allow
    expect(String(url)).toBe(komonLookupUrl(PARCEL));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: `${KOMON_PAGE}?c=${PARCEL}`, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'komon-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads its scans on their wall clocks with their codes, the delivering network’s wording without its place or sentence, and none of the merchant’s details', () => {
    const result = parseKomon(fixture('delivered'), PARCEL);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered, In/At Mailbox', last_update: null, last_update_local: '2026-06-24T10:50:00', expected_delivery: null,
      destination_country: 'US', delivery_tracking_number: 'SAMPLE0000000000000001' });
    expect(result.events!.map((event) => [event.local_time, event.location, event.description, event.provider_code, event.stage])).toEqual([
      // The postcode in the place is dropped, and the wording no longer repeats either.
      ['2026-06-24T10:50:00', 'SAMPLE CITY, NY', 'Delivered, In/At Mailbox', 'KM12', 'delivered'],
      ['2026-06-24T09:14:00', 'SAMPLE CITY, NY', 'Out for Delivery', 'KM08', 'out_for_delivery'],
      // China's offset is stated for the destination's airport too, so it is not read.
      ['2026-06-10T14:33:25', 'JFK', 'Arrival at Customs in', 'KM07', 'customs'],
      ['2026-06-10T09:31:23', 'JFK', 'Item arrived at destination.', 'KM06', 'in_transit'],
      ['2026-06-07T14:48:40', 'HONGKONG', 'Item was released from customs.', 'KM05', 'in_transit'],
      ['2026-06-07T09:09:01', 'HONGKONG', 'Item is awaiting customs clearance.', 'KM04', 'customs'],
      ['2026-06-06T09:42:34', 'wuhan', 'Item is ready for departure.', 'KM03', 'in_transit'],
      ['2026-06-05T11:13:05', 'wuhan', 'Item outbound in sorting center.', 'KM02', 'in_transit'],
      ['2026-06-05T10:51:43', 'wuhan', 'Item information received.', 'KMDD', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !('time' in event))).toBe(true);
    const json = JSON.stringify(result);
    for (const excluded of ['SAMPLEORDER0001', 'SAMPLE RECIPIENT', '09999', '900001', '800000', '美国', '->']) expect(json).not.toContain(excluded);
  });

  it('stages an unmapped code by its wording, and drops who took a delivery', () => {
    const scan = (date: string, description: string, code: string) => ({ track_occur_date: date, track_location: 'SAMPLE TOWN',
      track_description: description, track_description_en: description, track_code: code, track_status: '', gmt_offset: '' });
    const worded = parseKomon(changed((item) => {
      item.channel_hawbcode = '';
      item.details = [scan('2026-07-08 08:00:00', 'SAMPLE TOWN, Delivered, signed by SAMPLE RECIPIENT', 'KM99'),
        scan('2026-07-07 07:00:00', 'Sample Status Note', 'KM98'), scan('2026-07-06 07:00:00', 'Sample Status Note', '')];
    }), PARCEL);
    expect(worded.events!.map((event) => [event.description, event.provider_code, event.stage, event.stage_source])).toEqual([
      ['Delivered', 'KM99', 'delivered', 'wording:language'], ['Sample Status Note', 'KM98', undefined, undefined],
      ['Sample Status Note', undefined, undefined, undefined]]);
    expect(worded).not.toHaveProperty('delivery_tracking_number');
    const unstaged = parseKomon(changed((item) => { item.details = [scan('2026-07-07 07:00:00', 'Sample Status Note', 'KM98')]; }), PARCEL);
    expect(unstaged).toMatchObject({ status: 'unknown' });
    expect(unstaged).not.toHaveProperty('current_stage');
  });

  it('reads only the tracker’s unknown-number answer as not found, a parcel without scans as no history, and rejects a changed reply', () => {
    expect(() => parseKomon(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseKomon({ success: 0, cnmessage: '参数错误', enmessage: 'Parameter error' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseKomon({ success: 0, cnmessage: null, enmessage: 'Sample failure' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseKomon(changed((item) => { item.details = []; }), PARCEL)).toThrow(NoHistoryError);
    for (const change of [
      (item: Item) => { item.server_hawbcode = UNKNOWN; },
      (item: Item, whole: Reply) => { whole.data.push({ ...item }); },
      (item: Item) => { (item as Row).details = null; },
      (item: Item) => { item.details[0]!.track_occur_date = '2026-02-30 08:00:00'; },
      (item: Item) => { item.details[0]!.track_code = 'KM-12'; },
      (item: Item) => { item.details[0]!.track_description_en = 12; },
    ]) expect(() => parseKomon(changed(change), PARCEL)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads the reply in the callback it named or bare, and keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(JSON.stringify(fixture('delivered'))))).track({ number: PARCEL }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(text('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://www.komonexpress.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><script>document.cookie="acw_sc__v2=00"</script></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(`otherCallback(${JSON.stringify(fixture('not-found'))})`)).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(jsonp({ success: 0, enmessage: 'Parameter error' }))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']] as const)('preserves HTTP %s as %s, without a retry', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
    await expect(carrier(fetcher).track({ number: PARCEL })).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('refuses numbers outside Komon’s layout, and pre-aborted or spent lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['KOMON123450001YQ', 'KOMON12345000170YQ', 'KOMON1234500017YX', 'KOMEN1234500017YQ', `KOMON${'0'.repeat(70)}YQ`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    await expect(carrier(fetcher).track({ number: PARCEL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: PARCEL }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeKomonNumber('komon-1234-5000-17-yq')).toBe(PARCEL);
  });

  it('sends a read that fails to connect or hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('delivered')));
    await expect(carrier(flaky).track({ number: PARCEL })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const started = performance.now();
    const slow = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(slow.fetcher).track({ number: PARCEL }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(slow.ended.map((at) => at - started)).toEqual([60, 120]);
  });
});

describe('Komon Express numbers', () => {
  it('suggests KOMON, ten digits and YQ, and recognition asks the tracker, which files a parcel it knows', async () => {
    expect(detectCarrierMatch(PARCEL)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['komon-express'] });
    for (const countryHint of [undefined, 'US', 'GB']) expect(recognitionAskedCarriers(PARCEL, { countryHint })).toEqual(['komon-express']);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url).startsWith(KOMON_API)
      ? reply(text('delivered')) : new Response('', { status: 503 })));
    await expect(carrier(fetcher).recognize!(PARCEL)).resolves.toMatchObject({ known: true });
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: PARCEL, carrier: 'komon-express' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'komon-express', source: 'komon-express', result: { current_stage: 'delivered' } });
  });
});

describe('Komon Express status vocabulary', () => {
  it('maps every code it recorded to the stage recorded for it, whatever the wording, and the app reads the map', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, 'sample status note'), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'komon-express', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(komonStage('Sample Status Note', entry.code), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMap.stage(null, 'delivered')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'komon-express', providerCode: 'KM98', description: 'Sample Status Note' })).toEqual({ kind: 'unknown' });
    for (const code of ['constructor', 'toString', 'KM98']) expect(komonStage('Sample Status Note', code), code).toBeNull();
  });
});
