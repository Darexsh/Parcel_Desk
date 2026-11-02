import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, LINHAN_API, LINHAN_PAGE, LinhanTracker } from './adapter.js';
import { normalizeLinhanNumber, parseLinhan } from './parser.js';
import { linhanScan } from './scan.js';
import { linhanMappedStage, linhanStage, linhanStatusKey, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'LHGJ99000001CD';
const IN_TRANSIT = 'LHGJ99000002CD';
const UNKNOWN = 'LHGJ99000003CD';

type Row = Record<string, unknown>;
type Item = Row & { details: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Item[];
const changed = (name: string, change: (item: Item, reply: Item[]) => void) => {
  const reply = fixture(name);
  change(reply[0]!, reply);
  return reply;
};
// The tracker answers with JSON labelled as an HTML page.
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const scan = (content: string, createTime = '2026-05-20 09:00:00') => (item: Item) => { item.details = [{ create_time: createTime, content }]; };

describe('LinHan International HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number in capitals, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new LinhanTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' lhgj 9900-0001 cd ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(String(url)).toBe(`${LINHAN_API}?nos=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'Accept-Language': 'zh-CN', Referer: `${LINHAN_PAGE}?nos=${DELIVERED}`, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'linhan', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a parcel delivered abroad in the tracker’s order, with the towns as locations and every row on Beijing time', () => {
    const result = parseLinhan(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-05-14T13:42:10+08:00', expected_delivery: null, destination_country: 'DE' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.location, event.description, event.stage])).toEqual([
      // The postcode is dropped. The rows abroad are on Beijing time too.
      ['2026-05-14T13:42:10+08:00', 'Sample Town', 'Delivered', 'delivered'],
      ['2026-05-14T07:58:31+08:00', 'Sample Town', 'package is on the way', 'in_transit'],
      ['2026-05-14T05:12:47+08:00', 'Sample City', 'Leaving the sorting center', 'in_transit'],
      ['2026-05-13T22:05:19+08:00', 'Sample City', 'Arrive at the sorting and distribution center', 'in_transit'],
      // The next center's town stays in the wording.
      ['2026-05-13T16:40:02+08:00', undefined, 'Leave the processing center and transport to Sample City processing center', 'in_transit'],
      ['2026-05-13T09:31:55+08:00', undefined, 'Internationaliy Package received at processing center', 'in_transit'],
      ['2026-05-12T18:20:00+08:00', undefined, 'transfer to local acting company International self-operation team', 'in_transit'],
      ['2026-05-12T11:05:00+08:00', undefined, 'local carrier Agent Import customs clearance', 'customs'],
      ['2026-05-11T06:45:00+08:00', undefined, 'Item arrives at destination airport', 'in_transit'],
      ['2026-05-10T23:30:00+08:00', undefined, 'Departure from the airport of origin domestic', 'in_transit'],
      ['2026-05-10T15:10:00+08:00', undefined, 'Arrival at domestic internationality airport', 'in_transit'],
      // The row listed twice is kept once.
      ['2026-05-09T20:15:42+08:00', undefined, 'Goods leave the operation center', 'in_transit'],
      ['2026-05-09T10:02:18+08:00', undefined, 'Arrive at the cross border receiving point', 'accepted'],
      ['2026-05-08T16:30:05+08:00', undefined, 'Order information received', 'registered'],
    ]);
    expect(result.events!.every((event) => !('local_time' in event) && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/00000|中国|德国|天/);
  });

  it('reads a parcel on its way out of China, its newest step there the last update', async () => {
    const result = await carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')))).track({ number: IN_TRANSIT });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Departure from the airport of origin domestic', last_update: '2026-06-03T01:10:20+08:00', destination_country: 'FR' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events!.map((event) => event.time)).toEqual(['2026-06-03T01:10:20+08:00', '2026-06-01T22:40:05+08:00',
      '2026-05-31T08:15:30+08:00', '2026-05-30T21:05:45+08:00', '2026-05-30T11:30:00+08:00']);
    expect(result.events!.at(-1)).toEqual({ time: '2026-05-30T11:30:00+08:00', description: 'Order information received',
      stage: 'registered', stage_source: 'carrier_map' });
  });

  it('dates a row abroad, a step that names a town and wording it does not know on Beijing time', () => {
    const rows = (details: [string, string][]) => parseLinhan(changed('in-transit', (item) => {
      item.details = details.map(([createTime, content]) => ({ create_time: createTime, content }));
    }), IN_TRANSIT);
    for (const content of ['Item arrives at destination airport', 'Sample Town, Goods leave the operation center', 'Synthetic note',
      'Sample Town, 00000, Delivered', 'Arrive Sample City, at the sorting and distribution center', 'local carrier Agent Import customs clearance']) {
      const result = rows([['2026-06-04 06:20:00', content], ['2026-06-03 01:10:20', 'Departure from the airport of origin domestic']]);
      expect(result, content).toMatchObject({ last_update: '2026-06-04T06:20:00+08:00' });
      expect(result.events!.map((event) => event.time), content).toEqual(['2026-06-04T06:20:00+08:00', '2026-06-03T01:10:20+08:00']);
      expect(result, content).not.toHaveProperty('last_update_local');
      expect(result, content).not.toHaveProperty('delivered_at');
    }
  });

  it('moves a leading town into the location, drops postcodes and leaves other text whole', () => {
    expect(linhanScan('Sample Town, 00000, Delivered')).toEqual({ description: 'Delivered', location: 'Sample Town' });
    expect(linhanScan('Sample Town, 00-000, Delivered')).toEqual({ description: 'Delivered', location: 'Sample Town' });
    expect(linhanScan('00000 Sample Town, Delivered')).toEqual({ description: 'Delivered', location: 'Sample Town' });
    expect(linhanScan('Sample-sur-Mer, package is on the way')).toEqual({ description: 'package is on the way', location: 'Sample-sur-Mer' });
    expect(linhanScan('Arrive Sample City, at the sorting and distribution center'))
      .toEqual({ description: 'Arrive at the sorting and distribution center', location: 'Sample City' });
    // Wording the shared rules read is a scan, not a place.
    expect(linhanScan('Delivery failed, recipient absent')).toEqual({ description: 'Delivery failed, recipient absent', location: '' });
    expect(linhanScan('Order information received')).toEqual({ description: 'Order information received', location: '' });
    // A town and postcode alone have no wording to split off.
    expect(linhanScan('Sample Town, 00000')).toEqual({ description: 'Sample Town', location: '' });
    expect(linhanScan('Sample Town, 00000, Delivered, signed by A SAMPLE PERSON')).toEqual({ description: 'Delivered', location: 'Sample Town' });
    expect(linhanScan('Sample Town, Delivery attempted, call +49 000 0000000')).toEqual({ description: 'Delivery attempted, call', location: 'Sample Town' });
    expect(linhanScan('<b>Sample Town</b>, Leaving the sorting center')).toEqual({ description: 'Leaving the sorting center', location: 'Sample Town' });
    // In the United States the state comes between the town and the postcode, and the wording follows the postcode.
    expect(linhanScan('Sample Town, Sample State, 00000 Arrive at the last mile sorting and distribution center'))
      .toEqual({ description: 'Arrive at the last mile sorting and distribution center', location: 'Sample Town, Sample State' });
    expect(linhanScan('Sample Town, Sample State, 00000-0000 Accepted at logistics carrier Regional Destination Facility'))
      .toEqual({ description: 'Accepted at logistics carrier Regional Destination Facility', location: 'Sample Town, Sample State' });
    expect(linhanScan('Sample Town, Sample State, 00000, Delivered')).toEqual({ description: 'Delivered', location: 'Sample Town, Sample State' });
    // Wording before a postcode is no state.
    expect(linhanScan('Sample Town, Delivered, 00000 Sample Street'))
      .toEqual({ description: 'Delivered, Sample Street', location: 'Sample Town' });
    // The port's town before the import clearance; the destination agent's clearance names none.
    expect(linhanScan('Sample City Import customs clearance')).toEqual({ description: 'Import customs clearance', location: 'Sample City' });
    expect(linhanScan('local carrier Agent Import customs clearance'))
      .toEqual({ description: 'local carrier Agent Import customs clearance', location: '' });
    expect(linhanScan('Local Carrier Agent Import customs clearance'))
      .toEqual({ description: 'Local Carrier Agent Import customs clearance', location: '' });
  });

  it('takes the summary’s status when no scan has a stage, and stages new wording through the shared rules', () => {
    expect(parseLinhan(changed('delivered', scan('Synthetic note')), DELIVERED)).toMatchObject({ status: 'delivered',
      current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Synthetic note', last_update: '2026-05-20T09:00:00+08:00' });
    const unstaged = parseLinhan(changed('in-transit', scan('Synthetic note')), IN_TRANSIT);
    expect(unstaged).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic note' });
    expect(unstaged).not.toHaveProperty('current_stage');
    expect(unstaged.events).toEqual([{ time: '2026-05-20T09:00:00+08:00', description: 'Synthetic note' }]);
    expect(parseLinhan(changed('in-transit', scan('Sample Town, Out for delivery')), IN_TRANSIT)).toMatchObject({
      status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'wording:language',
      events: [{ location: 'Sample Town', description: 'Out for delivery' }] });
  });

  it('keeps a destination it cannot name as the tracker writes it, and none when it gives none', () => {
    expect(parseLinhan(changed('in-transit', (item) => { item.toCountry = '样例国'; }), IN_TRANSIT))
      .toMatchObject({ destination_country_name: '样例国' });
    expect(parseLinhan(changed('in-transit', (item) => { item.toCountry = '中国香港'; }), IN_TRANSIT)).toMatchObject({ destination_country: 'HK' });
    expect(parseLinhan(changed('in-transit', (item) => { item.toCountry = 'Germany'; }), IN_TRANSIT)).toMatchObject({ destination_country: 'DE' });
    const blank = parseLinhan(changed('in-transit', (item) => { item.toCountry = ''; }), IN_TRANSIT);
    expect(blank).not.toHaveProperty('destination_country');
    expect(blank).not.toHaveProperty('destination_country_name');
  });

  it('reads only the tracker’s unknown-number answer as not found, and a record without scans as no history', () => {
    expect(() => parseLinhan(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseLinhan(changed('not-found', (item) => { item.status = 'Not Found'; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseLinhan(changed('in-transit', (item) => { item.details = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    // The answer to a lookup without a number.
    expect(() => parseLinhan({ success: false, msg: '查询单号不能为空' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLinhan(changed('not-found', (item) => { item.details = fixture('in-transit')[0]!.details; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads only the item that names the whole number asked', () => {
    const other = 'LinHan International did not answer for the waybill asked';
    expect(() => parseLinhan(fixture('in-transit'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema', message: other }));
    expect(() => parseLinhan(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema', message: other }));
    expect(() => parseLinhan(changed('in-transit', (item) => { item.no = 'LHGJ99000002C'; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    // The tracker echoes the number as it was asked, in capitals.
    expect(() => parseLinhan(changed('in-transit', (item) => { item.no = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLinhan([], IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // Another number's item beside it is not read.
    expect(parseLinhan([...fixture('not-found'), ...fixture('in-transit')], IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit' });
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (item: Item, body: Item[]) => { body.push({ ...item }); },
      (_item: Item, body: Item[]) => { body[0] = 'parcel' as never; },
      (item: Item) => { delete item.no; },
      (item: Item) => { item.no = 7; },
      (item: Item) => { item.status = ['运输途中'] as never; },
      (item: Item) => { item.details = 'details' as never; },
      (item: Item) => { delete (item as Row).details; },
      (item: Item) => { item.details = Array.from({ length: 501 }, () => item.details[0]!); },
      (item: Item) => { item.details[0] = 'scan' as never; },
      (item: Item) => { item.details[0]!.create_time = '2026/06/03 01:10:20'; },
      (item: Item) => { item.details[0]!.create_time = '2026-06-03 01:10'; },
      (item: Item) => { item.details[0]!.create_time = '2026-02-30 01:10:20'; },
      (item: Item) => { item.details[0]!.create_time = '2026-06-03 24:00:00'; },
      (item: Item) => { delete item.details[0]!.create_time; },
      (item: Item) => { item.details[0]!.content = ['Departure']; },
      (item: Item) => { item.details[0]!.content = ' '; },
      (item: Item) => { item.toCountry = { name: '法国' }; },
    ]) {
      expect(() => parseLinhan(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseLinhan({ items: fixture('in-transit') }, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps the newest hundred rows of a long history and says it cut the rest', () => {
    const result = parseLinhan(changed('in-transit', (item) => {
      item.details = Array.from({ length: 120 }, (_, index) => ({
        create_time: `2026-06-01 ${String(Math.floor((119 - index) / 60)).padStart(2, '0')}:${String((119 - index) % 60).padStart(2, '0')}:00`,
        content: 'Goods leave the operation center',
      }));
    }), IN_TRANSIT);
    expect(result.events).toHaveLength(100);
    expect(result).toMatchObject({ history_truncated: true, last_update: '2026-06-01T01:59:00+08:00' });
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The lookup answers every number with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.linhan56.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    // A cloud firewall checks a browser with a script that sets a cookie, with HTTP 200.
    await expect(lookup('<html><script>var arg1=\'00\';document.cookie="acw_sc__v2=00"</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    // The tracking page itself, or an error page, in place of the lookup's JSON.
    await expect(lookup('<html><head><title>快件跟踪 - Powered By 林瀚国际物流</title></head></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('<html><title>系统发生错误</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup([])).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    });

  it('refuses numbers LinHan does not issue, and pre-aborted or spent lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['LHGJ9900001CD', 'LHGJ990000001CD', 'LHGJ99000001CN', 'JHGJ99000001CD', 'LHGJ9900000ACD', 'JH9900000001CN',
      'SAMPLETRACKING', `LHGJ${'0'.repeat(70)}CD`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeLinhanNumber('lhgj 9900 0002 cd')).toBe(IN_TRANSIT);
    // A high-confidence rule settles the carrier, so no recognition is declared.
    expect(carrier(fetcher).recognize).toBeUndefined();
  });

  it('sends a read that fails to connect or hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(flaky).track({ number: IN_TRANSIT })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const started = performance.now();
    const slow = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(slow.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(slow.fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(slow.ended.map((at) => at - started)).toEqual([60, 120]);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(256 * 1024 + 1)));
    await expect(carrier(large).track({ number: IN_TRANSIT })).rejects.toThrow('unexpectedly large');
  });

  it('routes a LinHan waybill, which detection settles, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'linhan', source: 'linhan', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === `${LINHAN_API}?nos=${DELIVERED}`)).toBe(true);
  });
});

describe('LinHan International numbers', () => {
  it('claims LHGJ, eight digits and CD, and nothing beside it', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'linhan', confidence: 'high' });
    }
    for (const number of ['LHGJ9900001CD', 'LHGJ990000001CD', 'LHGJ99000001CN']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('linhan');
    }
  });
});

describe('LinHan International status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it, and leaves the not-found status out', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string; unmapped?: boolean }[]) {
      const wording = normalizeStatusWording(entry.wording);
      if (entry.unmapped) {
        expect(statusMap.stage(null, wording), entry.wording).toBeUndefined();
        expect(statusMapAnswer({ carrier: 'linhan', providerCode: null, description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        expect(linhanStage(entry.wording), entry.wording).toBeNull();
        continue;
      }
      expect(linhanMappedStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'linhan', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(linhanStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    // A processing center's town is keyed out of its wording.
    expect(linhanStatusKey('Leave the processing center and transport to Sample City processing center'))
      .toBe('leave the processing center and transport to … processing center');
    expect(linhanStatusKey('Leave the Sample City processing center')).toBe('leave the … processing center');
    expect(linhanStatusKey('Leave the processing center')).toBe('leave the processing center');
    expect(statusMapAnswer({ carrier: 'linhan', providerCode: null, description: 'Leave the processing center and transport to Sample City processing center' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'linhan', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(statusMap.gaps.every((gap) => gap.wording && gap.note)).toBe(true);
    for (const wording of ['constructor', 'toString', 'Sample delivered note']) expect(linhanMappedStage(wording), wording).toBeUndefined();
    expect(statusMap.stage('7', 'delivered')).toBeUndefined();
    expect(linhanStage('Synthetic note')).toBeNull();
  });
});
