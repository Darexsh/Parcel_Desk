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
import { adapter, YDH_API, YDH_CALLBACK, YDH_PAGE, ydhLookupUrl, YdhTracker } from './adapter.js';
import { normalizeYdhNumber, parseYdh } from './parser.js';
import { statusMap, ydhStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'YDH1234500017AZ';
const UNKNOWN = 'YDH1234500028YQ';

type Row = Record<string, unknown>;
type Item = Row & { details: Row[] };
type Reply = Row & { data: Item[] };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name).replace(/^ydhTrack\((.*)\)$/s, '$1')) as Reply;
const changed = (change: (item: Item, reply: Reply) => void) => {
  const reply = fixture('delivered');
  change(reply.data[0]!, reply);
  return reply;
};
const jsonp = (body: unknown) => `${YDH_CALLBACK}(${JSON.stringify(body)})`;
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const scan = (date: string, description: string, code = '', location = '') => ({
  track_occur_date: date, track_location: location, track_description: description, track_description_en: description,
  track_code: code, track_status: '', time_zone: '+08:00',
});

describe('YDH HTTP adapter', () => {
  it('asks the platform’s lookup for the whole number in capitals, with its key, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new YdhTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' ydh 1234500017 az ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(YDH_API);
    // The key is the Base64 of the query's MD5 in hexadecimal, a digest of the synthetic query.
    expect([...asked.searchParams]).toEqual([['callbackparam', YDH_CALLBACK], ['method', 'track'],
      ['key', 'MDQ4NzRjMDY5Yjg2Y2QzNDA3MGY3ZjdhYmM5ODMwZmU='], ['param', `{"sp":"","nums":["${DELIVERED}"]}`]]); // gitleaks:allow
    expect(String(url)).toBe(ydhLookupUrl(DELIVERED));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: `${YDH_PAGE}?track_number=${DELIVERED}`, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ydh', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered parcel’s scans on their wall clocks, whatever offset they state, by their codes, with the partner’s number and none of the merchant’s or recipient’s details', () => {
    const result = parseYdh(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Votre colis est livré.', last_update: null, last_update_local: '2026-03-20T11:01:30', expected_delivery: null,
      destination_country: 'FR', delivery_tracking_number: 'SAMPLE0000000001' });
    expect(result.events!.map((event) => [event.local_time, event.location, event.provider_code, event.stage, event.stage_source])).toEqual([
      ['2026-03-20T11:01:30', 'SAMPLE TOWN AGENCE', 'CC', 'delivered', 'carrier_map'],
      // The code names no one milestone: the partner's wording does.
      ['2026-03-19T14:10:48', 'SAMPLE TOWN AGENCE', 'DD', 'failed_attempt', 'wording:language'],
      ['2026-03-19T08:20:00', 'SAMPLE TOWN AGENCE', 'OD', 'out_for_delivery', 'carrier_map'],
      // The postcode in the place is dropped.
      ['2026-03-18T19:41:35', 'SAMPLE HUB', 'PU', 'in_transit', 'carrier_map'],
      ['2026-03-17T15:03:00', 'CDG', 'CARR', 'in_transit', 'carrier_map'],
      ['2026-03-17T12:27:00', 'CDG', 'RC', 'in_transit', 'carrier_map'],
      ['2026-03-17T07:24:00', 'CDG', 'AA', 'in_transit', 'carrier_map'],
      ['2026-03-16T17:30:00', 'PVG', 'DA', 'in_transit', 'carrier_map'],
      ['2026-03-15T18:10:00', 'PVG', 'TDDY', 'in_transit', 'carrier_map'],
      // A scan without a code is staged by its wording, the Chinese without English.
      ['2026-03-15T10:33:00', 'PVG', undefined, 'in_transit', 'carrier_map'],
      ['2026-03-14T01:41:56', 'SAMPLE CITY', 'DF', 'in_transit', 'carrier_map'],
      // The row listed twice counts once.
      ['2026-03-13T19:22:12', 'SAMPLE CITY', 'AF', 'in_transit', 'carrier_map'],
      // So does the scan relayed again without its code or English wording.
      ['2026-03-12T09:22:27', undefined, 'IR', 'registered', 'carrier_map'],
    ]);
    expect(result.events!.every((event) => !('time' in event))).toBe(true);
    expect(result.events!.find((event) => event.local_time === '2026-03-15T10:33:00')).toMatchObject({ description: '出口报关' });
    expect(result.events!.at(-1)).toMatchObject({ description: 'Shipment information received' });
    const json = JSON.stringify(result);
    for (const excluded of ['SAMPLEORDER0001', 'SAMPLE RECIPIENT', 'SAMPLE PARTNER', 'SAMPLE STAFF', '99999', '法国']) expect(json).not.toContain(excluded);
  });

  it('keeps the parcel where it was when a label comes later, stages new wording through the shared rules, and drops who took a delivery', () => {
    const labelled = parseYdh(changed((item) => {
      item.details = [scan('2026-03-14 02:21:05', 'Shipping Label Created'), scan('2026-03-13 19:22:12', 'Shipment arrived at facility', 'AF')];
    }), DELIVERED);
    expect(labelled).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Shipping Label Created' });
    // A copy without the code is dropped wherever the reply lists it; the same wording at another clock is another scan.
    const relayed = parseYdh(changed((item) => {
      item.details = [scan('2026-03-12 09:22:27', '快件电子信息已经收到'),
        { ...scan('2026-03-12 09:22:27', '快件电子信息已经收到', 'IR'), track_description_en: 'Shipment information received' },
        scan('2026-03-11 09:22:27', '快件电子信息已经收到')];
    }), DELIVERED);
    expect(relayed.events!.map((event) => [event.local_time, event.provider_code])).toEqual([
      ['2026-03-12T09:22:27', 'IR'], ['2026-03-11T09:22:27', undefined]]);
    const worded = parseYdh(changed((item) => {
      item.channel_hawbcode = null;
      item.details = [scan('2026-03-20 11:00:00', 'Delivered, signed by SAMPLE RECIPIENT', 'XX'), scan('2026-03-19 08:00:00', 'Sample Status Note')];
    }), DELIVERED);
    expect(worded.events!.map((event) => [event.description, event.provider_code, event.stage, event.stage_source])).toEqual([
      ['Delivered', 'XX', 'delivered', 'wording:language'], ['Sample Status Note', undefined, undefined, undefined]]);
    expect(worded).not.toHaveProperty('delivery_tracking_number');
    const unstaged = parseYdh(changed((item) => { item.details = [scan('2026-03-19 08:00:00', 'Sample Status Note', '', '--')]; }), DELIVERED);
    expect(unstaged).toMatchObject({ status: 'unknown' });
    expect(unstaged).not.toHaveProperty('current_stage');
    expect(unstaged.events![0]).not.toHaveProperty('location');
  });

  it('reads only the tracker’s unknown-number answer as not found and a parcel without scans as no history, and rejects a changed reply', () => {
    expect(() => parseYdh(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseYdh({ success: 0, cnmessage: '参数错误', enmessage: 'Parameter error' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYdh({ success: 0, cnmessage: null, enmessage: 'Sample failure' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseYdh(changed((item) => { item.details = []; }), DELIVERED)).toThrow(NoHistoryError);
    for (const change of [
      (item: Item) => { item.server_hawbcode = UNKNOWN; },
      (item: Item, whole: Reply) => { whole.data.push({ ...item }); },
      (item: Item) => { (item as Row).details = null; },
      (item: Item) => { item.details = [{ ...scan('2026-03-19 08:00:00', 'Out for Delivery', 'OD'), track_occur_date: '2026-02-30 08:00:00' }]; },
      (item: Item) => { item.details = [scan('2026-03-19 08:00:00', 'Out for Delivery', 'O-D')]; },
      (item: Item) => { item.details = [{ ...scan('2026-03-19 08:00:00', 'Out for Delivery'), track_code: 7 }]; },
    ]) expect(() => parseYdh(changed(change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads the reply in the callback it named or bare, and keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(JSON.stringify(fixture('delivered'))))).track({ number: DELIVERED }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(text('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.ydhex.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><script>document.cookie="acw_sc__v2=00"</script></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(`otherCallback(${JSON.stringify(fixture('not-found'))})`)).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(jsonp({ success: 0, enmessage: 'Parameter error' }))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']] as const)('preserves HTTP %s as %s, without a retry', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('refuses numbers outside YDH’s layout, and pre-aborted or spent lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['YDH123450001AZ', 'YDH12345000171AZ', 'YDH1234500017A1', 'YDX1234500017AZ', 'SAMPLETRACKING', `YDH${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeYdhNumber('ydh-1234500017-az')).toBe(DELIVERED);
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
    expect(slow.ended.map((at) => at - started)).toEqual([60, 120]);
  });

  it('routes a YDH number, which detection settles, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url).startsWith(YDH_API)
      ? reply(text('delivered')) : new Response('', { status: 503 })));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'ydh', source: 'ydh', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.filter(([url]) => String(url).startsWith(YDH_API)).map(([url]) => String(url))).toEqual([ydhLookupUrl(DELIVERED)]);
  });
});

describe('YDH numbers', () => {
  it('claims YDH, ten digits and a suffix it was seen with, and nothing beside it', () => {
    for (const number of [DELIVERED, UNKNOWN]) expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'ydh', confidence: 'high' });
    for (const number of ['YDH123450001AZ', 'YDH12345000171AZ']) expect(detectCarrierMatch(number).carrier, number).not.toBe('ydh');
  });
});

describe('YDH status vocabulary', () => {
  it('maps every code and wording it recorded to the stage recorded for it, and leaves the code without a milestone to the wording', () => {
    for (const entry of statuses.entries as { code?: string; wording?: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.code) {
        expect(statusMap.stage(entry.code, ''), entry.code).toBe(entry.stage);
        expect(statusMapAnswer({ carrier: 'ydh', providerCode: entry.code, description: 'Sample Status Note' }), entry.code)
          .toMatchObject(entry.unmapped ? { kind: 'intentional_gap' } : { kind: 'mapped', stage: entry.stage });
        expect(ydhStage('Sample Status Note', entry.code), entry.code).toEqual(entry.unmapped ? null : { stage: entry.stage, source: 'carrier_map' });
        continue;
      }
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording!)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'ydh', providerCode: null, description: entry.wording! }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(ydhStage(entry.wording!), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'ydh', providerCode: null, description: 'Sample Status Note' })).toEqual({ kind: 'unknown' });
    expect(statusMap.gaps.every((gap) => gap.code && gap.note)).toBe(true);
    for (const wording of ['constructor', 'toString', 'Sample Status Note']) expect(ydhStage(wording), wording).toBeNull();
  });
});
