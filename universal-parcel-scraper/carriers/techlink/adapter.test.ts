import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TECHLINK_API, TechlinkTracker } from './adapter.js';
import { normalizeTechlinkNumber, parseTechlink } from './parser.js';
import { statusMap, techlinkStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const IN_TRANSIT = 'ZHPHD260101000002ML';
const UNKNOWN = 'ZHPHD260101000003ML';
const LAST_MILE = 'RR000000005PL';

type Scan = Record<string, unknown>;
type Entry = { order_num: string; track_list: Scan[]; new_track: Scan | null; msg: string };
type Reply = { data: Entry[]; msg: string; code: number };

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/in-transit.json', import.meta.url), 'utf8')) as Reply;
const changed = (change: (scans: Scan[], reply: Reply) => void) => {
  const reply = fixture();
  change(reply.data[0]!.track_list, reply);
  return reply;
};
// The tracker's entry for a number with no scans: an order it does not have, or one before its first scan.
const empty = (number: string, msg: string): Reply => ({ data: [{ order_num: number, track_list: [], new_track: null, msg }], msg: 'success', code: 200 });
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Techlink HTTP adapter', () => {
  it('posts the whole number to the tracking page’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TechlinkTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zhphd 2601 0100 0002 ml ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('http://api.techlinksz.com/api/trackinfo/');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: `{"order_nums":"${IN_TRANSIT}"}`,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'techlink', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('dates Techlink’s own scans on Beijing’s clock, newest first, with the last-mile number and destination', () => {
    const result = normalizeCarrierResult(parseTechlink(fixture(), IN_TRANSIT));
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Parcel has been packed and is ready for outbound shipping', last_update: '2026-01-03T13:14:20+08:00',
      expected_delivery: null, destination_country: 'PL', delivery_tracking_number: LAST_MILE });
    expect(result.delivery_carrier).toBeUndefined();
    expect(result.events!.map((event) => [event.time, event.local_time, event.location, event.provider_code, event.stage])).toEqual([
      ['2026-01-03T13:14:20+08:00', undefined, 'China', 'Warehousing_Packed', 'in_transit'],
      ['2026-01-02T17:04:08+08:00', undefined, 'China', 'Warehousing_Received', 'accepted'],
      // The order's electronic information has no place.
      ['2026-01-01T22:14:00+08:00', undefined, undefined, 'InfoReceived', 'registered'],
    ]);
    // The destination's post confirms the last-mile number.
    expect(deliveryHandoff('techlink', IN_TRANSIT, result)).toEqual({ carrier: 'poczta-polska', number: LAST_MILE, basis: 'destination' });
  });

  it('keeps the wall clock of a scan away from Techlink, and turns an oldest-first list round', () => {
    const abroad = changed((scans) => {
      scans.unshift({ ...scans[0], track_code: 'Delivered', track_sub_code: 'Delivered', track_name: '已签收',
        actual_time: '2026-01-09 10:30:00', create_date: '2026-01-09 10:30:00', location: 'PL', description: 'Delivered' });
      scans.reverse();
    });
    const result = normalizeCarrierResult(parseTechlink(abroad, IN_TRANSIT));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null, last_update_local: '2026-01-09T10:30:00' });
    expect(result.events![0]).toMatchObject({ local_time: '2026-01-09T10:30:00', location: 'Poland', description: 'Delivered' });
    expect(result.events![0]!.time).toBeUndefined();
    expect(result.events!.map((event) => event.provider_code)).toEqual(['Delivered', 'Warehousing_Packed', 'Warehousing_Received', 'InfoReceived']);
  });

  it('falls back to the Chinese wording and leaves out a last-mile number that is missing or not one', () => {
    const result = parseTechlink(changed((scans) => {
      for (const scan of scans) Object.assign(scan, { description: '', lm_track_num: '' });
      scans[0]!.lm_track_num = IN_TRANSIT;
    }), IN_TRANSIT);
    expect(result.last_status_text).toBe('包裹装箱');
    expect(result.delivery_tracking_number).toBeUndefined();
    // Two last-mile numbers name none.
    const two = parseTechlink(changed((scans) => { scans[1]!.lm_track_num = 'RR000000019PL'; }), IN_TRANSIT);
    expect(two.delivery_tracking_number).toBeUndefined();
  });

  it('reads an order the tracker does not have as not found, and one before its first scan as no history', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(empty(UNKNOWN, '无订单信息')))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(empty(UNKNOWN, 'success')))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'indeterminate', name: 'NoHistoryError' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(empty(UNKNOWN, 'error')))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('keeps another shipment, a refused or moved lookup, a browser check and a changed reply apart', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: IN_TRANSIT });
    // An entry or a scan for another number is not this parcel's answer.
    await expect(lookup(reply(empty(UNKNOWN, '无订单信息')))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(reply(changed((scans) => { scans[1]!.order_num = UNKNOWN; })))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(reply(changed((_scans, body) => { body.data.push(body.data[0]!); })))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(reply(changed((_scans, body) => { body.code = 500; })))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(new Response(null, { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response(null, { status: 302, headers: { Location: 'http://www.techlinksz.cn/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response('Forbidden', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    // A browser check, even with HTTP 200, is never a missing parcel.
    await expect(lookup(new Response(CHECK, { status: 200, headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(new Response('<html><title>Techlink</title></html>', { status: 200 }))).rejects.toMatchObject({ kind: 'schema' });
    for (const change of [
      (_scans: Scan[], body: Reply) => { (body as unknown as Record<string, unknown>).data = {}; },
      (scans: Scan[]) => { scans[0]!.actual_time = '2026-02-30 10:00:00'; scans[0]!.create_date = ''; },
      (scans: Scan[]) => { scans[0]!.actual_time = '2026-01-03T13:14:20'; },
      (scans: Scan[]) => { scans[0]!.description = 7; },
      (scans: Scan[]) => { scans[0]!.description = ''; scans[0]!.track_name = ''; },
      (scans: Scan[]) => { scans[0]!.track_sub_code = 'not a code'; },
    ]) await expect(lookup(reply(changed(change)))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
    // An HTTP status is never sent again.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('tries once more after a lookup that does not reach the service', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new TechlinkTracker({ fetcher, recorder }).fetch(IN_TRANSIT, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
  });

  it('refuses numbers Techlink does not issue, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZHPHD261301000002ML', 'ZHPHD26010100002ML', 'ZHPHD260101000002M', 'XHPHD260101000002ML', `Z${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTechlinkNumber(' zhphd-260101-000002-ml ')).toBe(IN_TRANSIT);
  });

  it('routes a number Techlink issues to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => String(input) === TECHLINK_API
      ? reply(fixture()) : new Response('', { status: 503 }));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: IN_TRANSIT, carrier: 'techlink' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'techlink', source: 'techlink', result: { current_stage: 'in_transit' } });
  });
});

describe('Techlink status vocabulary', () => {
  it('records every scan code the map knows with the stage it gives', () => {
    const coded = (statuses.entries as { code: string; wording: string; stage: string }[]);
    expect(coded.length).toBeGreaterThan(0);
    for (const entry of coded) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(techlinkStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'techlink', providerCode: 'Warehousing_Packed', description: 'Parcel has been packed and is ready for outbound shipping' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'techlink', providerCode: 'Synthetic_Code', description: 'synthetic wording' })).toEqual({ kind: 'unknown' });
    expect(techlinkStage('Synthetic_Code', 'synthetic wording')).toBeNull();
  });
});
