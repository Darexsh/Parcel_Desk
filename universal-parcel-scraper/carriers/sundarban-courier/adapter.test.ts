import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SUNDARBAN_API, SUNDARBAN_KEY, SUNDARBAN_PAGE, SundarbanTracker, sundarbanLookupBody } from './adapter.js';
import { normalizeSundarbanNumber, parseSundarban } from './parser.js';
import { statusMap, sundarbanCodeStage, sundarbanStage, sundarbanWordingStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '10000000000001';
const IN_TRANSIT = '10000000000002';
const UNKNOWN = '10000000000003';

type Row = Record<string, unknown>;
type Shipment = Row & { cnStatusList: Row[] };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name)) as Shipment[];
/** A fixture with its shipment, or the whole reply, changed in place by `change`. */
const changed = (name: string, change: (shipment: Shipment, reply: Shipment[]) => void) => {
  const payload = fixture(name);
  change(payload[0]!, payload);
  return payload;
};
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const page = (key: string) => new Response(`<html><title>Tracking - Sundarban Courier</title><script>
  beforeSend: function (xhr) { xhr.setRequestHeader("key", "${key}"); },</script></html>`, { headers: { 'Content-Type': 'text/html' } });

describe('Sundarban Courier HTTP adapter', () => {
  it('posts the whole CN number with the page’s key to its lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SundarbanTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1000 0000 0000 02 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(SUNDARBAN_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/json;charset=utf-8', key: SUNDARBAN_KEY, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ selectedtypes: 'cnno', selectedtimes: '7', inputvalue: IN_TRANSIT });
    expect(sundarbanLookupBody(IN_TRANSIT)).toBe(String(init!.body));
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'sundarban-courier', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('lists the statuses newest first as days and stages them by Sundarban’s wording', () => {
    const result = parseSundarban(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-03-04', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-03-04', 'হাব নমুনা', 'Delivered', 'delivered'],
      ['2026-03-04', 'হাব নমুনা', 'Out for Delivery', 'out_for_delivery'],
      ['2026-03-03', 'হাব নমুনা', 'Received by Dest.', 'in_transit'],
      ['2026-03-03', 'হাব কেন্দ্র', 'Out for Destination', 'in_transit'],
      ['2026-03-03', 'হাব কেন্দ্র', 'Received by Dest.', 'in_transit'],
      ['2026-03-02', 'শাখা উদাহরণ', 'Out for Destination', 'in_transit'],
      ['2026-03-02', 'শাখা উদাহরণ', 'Booking Complete', 'accepted'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.time === undefined && event.provider_code === undefined))
      .toBe(true);
    expect(result).not.toHaveProperty('pickup_point');
  });

  it('keeps no sender, recipient, phone, address, contents, vehicle, manifest, bag, delivery man or remark', () => {
    const json = JSON.stringify(parseSundarban(fixture('delivered'), DELIVERED));
    expect(json).not.toMatch(/Sample (?:Sender|Receiver|Goods|Rider|booking)|Example (?:Road|Lane|Branch)|Sample Town|01000000|SAMPLE-VEHICLE|900001|SMP-DOC|N\/A|10000000000001/);
  });

  it('reads a parcel on its way, and keeps a time the service gives beside the day', () => {
    const result = parseSundarban(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Received by Dest.',
      last_update_local: '2026-03-10' });
    expect(result.events).toHaveLength(3);
    const timed = parseSundarban(changed('in-transit', (shipment) => { shipment.cnStatusList[2]!.statusDate = '2026-03-10T14:05:30.123'; }), IN_TRANSIT);
    expect(timed.events![0]).toMatchObject({ local_time: '2026-03-10T14:05:30', description: 'Received by Dest.' });
  });

  it('names the branch counter a parcel waits at or was collected from', () => {
    const ready = parseSundarban(changed('in-transit', (shipment) => {
      shipment.cnStatusList.push({ ...shipment.cnStatusList[2]!, status: 'Ready For C/D', statusDate: '2026-03-11T00:00:00' });
    }), IN_TRANSIT);
    expect(ready).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', pickup_point: 'হাব কেন্দ্র' });
    const collected = parseSundarban(changed('in-transit', (shipment) => {
      shipment.cnStatusList.push({ ...shipment.cnStatusList[2]!, status: 'Ready for C/D', statusDate: '2026-03-11T00:00:00' },
        { ...shipment.cnStatusList[2]!, status: 'Delivered', statusDate: '2026-03-12T00:00:00' });
    }), IN_TRANSIT);
    expect(collected).toMatchObject({ current_stage: 'delivered', pickup_point: 'হাব কেন্দ্র' });
  });

  it('labels an international status by its code and leaves an unknown status to the shared rules', () => {
    const international = parseSundarban(changed('in-transit', (shipment) => {
      shipment.cnStatusList.push({ ...shipment.cnStatusList[2]!, status: 'customs_clearance_at_dest', statusDate: '2026-03-12T00:00:00', remarks: 'Sample remark' });
    }), IN_TRANSIT);
    expect(international.events![0]).toMatchObject({ description: 'Customs Clearance At Destination', provider_code: 'customs_clearance_at_dest',
      stage: 'customs', stage_source: 'carrier_map' });
    expect(JSON.stringify(international)).not.toContain('Sample remark');
    const returned = parseSundarban(changed('in-transit', (shipment) => {
      shipment.cnStatusList.push({ ...shipment.cnStatusList[2]!, status: 'Parcel returned to sender', statusDate: '2026-03-12T00:00:00' });
    }), IN_TRANSIT);
    expect(returned).toMatchObject({ current_stage: 'returned', current_stage_source: 'wording:language' });
    const unknown = parseSundarban(changed('in-transit', (shipment) => {
      shipment.cnStatusList = [{ ...shipment.cnStatusList[0]!, status: 'Sample note' }];
    }), IN_TRANSIT);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Sample note' });
    expect(unknown).not.toHaveProperty('current_stage');
    // A row without a status is left out.
    const blank = parseSundarban(changed('in-transit', (shipment) => { shipment.cnStatusList[2]!.status = null; }), IN_TRANSIT);
    expect(blank.events).toHaveLength(2);
  });

  it('reads a shipment without a history from its current status', () => {
    const result = parseSundarban(changed('in-transit', (shipment) => { shipment.cnStatusList = []; }), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Received by Dest.',
      last_update_local: '2026-03-10', summary_only: true, events: [] });
    expect(() => parseSundarban(changed('in-transit', (shipment) => { shipment.cnStatusList = []; shipment.status = null; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads a number the tracker holds nothing for as inconclusive, never as not found', () => {
    expect(() => parseSundarban(fixture('not-found'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
  });

  it('keeps only the shipment that names the whole number asked', () => {
    expect(() => parseSundarban(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Sundarban answered for another shipment' }));
    // A longer number holding the one asked is another shipment.
    expect(() => parseSundarban(changed('in-transit', (shipment) => { shipment.cnNumber = `${IN_TRANSIT}001`; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ message: 'Sundarban answered for another shipment' }));
    expect(() => parseSundarban(changed('in-transit', (shipment, payload) => { payload.push(structuredClone(shipment)); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Sundarban returned several shipments under the number' }));
    // Another shipment listed beside it is left aside.
    const beside = changed('in-transit', (_shipment, payload) => { payload.unshift(fixture('delivered')[0]!); });
    expect(parseSundarban(beside, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit' });
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_shipment: Shipment, body: Shipment[]) => { body.length = 0; body.push('shipment' as never); },
      (_shipment: Shipment, body: Shipment[]) => { body.push(...Array.from({ length: 50 }, () => body[0]!)); },
      (shipment: Shipment) => { delete shipment.cnNumber; },
      (shipment: Shipment) => { shipment.cnNumber = 10000000000002; },
      (shipment: Shipment) => { shipment.cnStatusList = 'history' as never; },
      (shipment: Shipment) => { shipment.cnStatusList = Array.from({ length: 301 }, () => shipment.cnStatusList[0]!); },
      (shipment: Shipment) => { shipment.cnStatusList[0] = 'row' as never; },
      (shipment: Shipment) => { shipment.cnStatusList[0]!.status = ['Booking Complete']; },
      (shipment: Shipment) => { shipment.cnStatusList[0]!.statusDate = '2026-03-09'; },
      (shipment: Shipment) => { shipment.cnStatusList[0]!.statusDate = '2026-02-30T00:00:00'; },
      (shipment: Shipment) => { shipment.cnStatusList[0]!.statusDate = '2026-03-09T24:00:00'; },
      (shipment: Shipment) => { delete shipment.cnStatusList[0]!.statusDate; },
    ]) {
      expect(() => parseSundarban(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseSundarban({ status: 'Delivered' }, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSundarban('192.0.2.1', IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a moved route, a browser check, a refusal and a broken reply apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://operation.sundarbancourierltd.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('', { status: 429, headers: { 'Retry-After': '30' } })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(lookup('<html><title>Sundarban</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('"192.0.2.1"')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('re-reads a refused key from the tracking page once, and keeps the new one', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url) === SUNDARBAN_PAGE) return page('SyntheticKey0000');
      const key = (init!.headers as Record<string, string>).key;
      return reply(key === 'SyntheticKey0000' ? text('in-transit') : '"UNAUTHORIZED"');
    });
    const tracker = new SundarbanTracker({ fetcher, recorder: NOOP_RECORDER });
    await expect(tracker.fetch(IN_TRANSIT)).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([SUNDARBAN_API, SUNDARBAN_PAGE, SUNDARBAN_API]);
    await tracker.fetch(IN_TRANSIT);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect((fetcher.mock.calls[3]![1]!.headers as Record<string, string>).key).toBe('SyntheticKey0000');
  });

  it('gives up on a key the page still gives or the service keeps refusing', async () => {
    const refusing = (key: string) => vi.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url) === SUNDARBAN_PAGE ? page(key) : reply('"UNAUTHORIZED"'));
    const same = refusing(SUNDARBAN_KEY);
    await expect(carrier(same).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'schema' });
    expect(same).toHaveBeenCalledTimes(2);
    const other = refusing('SyntheticKey0000');
    await expect(carrier(other).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'schema' });
    expect(other).toHaveBeenCalledTimes(3);
    const keyless = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url) === SUNDARBAN_PAGE ? new Response('<html>Tracking</html>') : reply('"UNAUTHORIZED"'));
    await expect(carrier(keyless).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'schema' });
    const challenged = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url) === SUNDARBAN_PAGE
      ? new Response('<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>') : reply('"UNAUTHORIZED"'));
    await expect(carrier(challenged).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('refuses what is not a CN number, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '1000000000001', '100000000000011', '1000000000000111', 'SAMPLETRACKING00', '1000000000000.', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSundarbanNumber(' 1000-0000-0000-03 ')).toBe(UNKNOWN);
    expect(normalizeSundarbanNumber('10000000000003001')).toBe('10000000000003001');
  });

  it('declares no recognition: the tracker never says a number is unknown', () => {
    expect(carrier(vi.fn<typeof fetch>()).recognize).toBeUndefined();
  });

  it('routes a number filed under Sundarban Courier to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'sundarban-courier' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'sundarban-courier', source: 'sundarban-courier', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === SUNDARBAN_API)).toBe(true);
  });
});

describe('Sundarban Courier status vocabulary', () => {
  it('records every status the map knows with the stage it gives', () => {
    const entries = statuses.entries as { code?: string; wording: string; stage: string }[];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(statusMapAnswer({ carrier: 'sundarban-courier', providerCode: entry.code ?? null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(sundarbanStage(entry.code ?? null, entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('leaves an unknown status to the shared rules', () => {
    expect(statusMap.stage('sample_code', 'shipment delivered')).toBeUndefined();
    expect(statusMap.stage(null, 'sample note')).toBeUndefined();
    expect(sundarbanWordingStage('READY FOR C/D')).toBe('ready_for_pickup');
    expect(sundarbanCodeStage('Delivered')).toBeUndefined();
    expect(sundarbanCodeStage('toString')).toBeUndefined();
    expect(sundarbanStage(null, 'Sample note')).toBeNull();
    expect(statusMapAnswer({ carrier: 'sundarban-courier', providerCode: null, description: 'Sample note' })).toEqual({ kind: 'unknown' });
  });
});
