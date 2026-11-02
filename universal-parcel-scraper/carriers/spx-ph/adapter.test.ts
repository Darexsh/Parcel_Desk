import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { SpxPhTracker } from './adapter.js';
import { normalizeSpxPhNumber, parseSpxPh } from './parser.js';
import { spxPhStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
const NUMBER = 'PH000000000001';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
function legacy() {
  const modern = fixture();
  return { retcode: 0, data: { sls_tracking_number: NUMBER, tracking_list: modern.data.sls_tracking_info.records.map((row: { description: string; actual_time: number }) => ({ message: row.description, timestamp: row.actual_time })) } };
}
describe('SPX Philippines parser', () => {
  it.each([false, true])('preserves identity-bound actual scans from legacy=%s', old => {
    const result = parseSpxPh(old ? legacy() : fixture(), NUMBER, old);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-01-03T16:00:00Z' });
    expect(result.events).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('PRIVATE-SYNTHETIC');
  });
  it('binds verified modern order aliases without accepting a query echo', () => {
    const value = fixture(); value.data.order_info.sls_tn = NUMBER; value.data.order_info.spx_tn = 'SPXPH000000000001';
    expect(parseSpxPh(value, NUMBER).events).toHaveLength(2);
    delete value.data.order_info.sls_tn; value.data.requested = NUMBER;
    expect(() => parseSpxPh(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('accepts marketplace history identified by the returned SLS tracking object', () => {
    const value = fixture(); delete value.data.order_info;
    value.data.sls_tracking_info.sls_tn = NUMBER;
    expect(parseSpxPh(value, NUMBER)).toMatchObject({ status: 'delivered', events: [{ description: 'Delivered' }, { description: 'Out for delivery' }] });
    value.data.sls_tracking_info.sls_tn = 'PH000000000002';
    expect(() => parseSpxPh(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    delete value.data.sls_tracking_info.sls_tn; value.data.requested = NUMBER;
    expect(() => parseSpxPh(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('excludes hidden modern records and keeps all-hidden history inconclusive', () => {
    const value = fixture(); value.data.sls_tracking_info.records[0].display_flag = 0;
    const result = parseSpxPh(value, NUMBER);
    expect(result.events).toHaveLength(1); expect(result.current_stage).toBe('out_for_delivery');
    value.data.sls_tracking_info.records[1].display_flag = 0;
    expect(() => parseSpxPh(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });
  it('ignores progress rails and requires actual history', () => {
    const value = fixture(); value.data.sls_tracking_info.records = [];
    expect(() => parseSpxPh(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });
  it('keeps empty and failed endpoint replies inconclusive', () => {
    for (const value of [{ retcode: 0, data: {} }, { retcode: 2, message: 'Unavailable' }]) {
      expect(() => parseSpxPh(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });
  it('rejects wrong identities, mixed rows and parent freight orders', () => {
    const wrong = fixture(); wrong.data.order_info.spx_tn = 'PH000000000002';
    expect(() => parseSpxPh(wrong, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const mixed = fixture(); mixed.data.sls_tracking_info.records[0].spx_tn = 'PH000000000002';
    expect(() => parseSpxPh(mixed, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const parent = fixture(); parent.data.children = [{ spx_tn: NUMBER }];
    expect(() => parseSpxPh(parent, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });
  it('retains unknown wording and malformed clock uncertainty', () => {
    const value = fixture(); value.data.sls_tracking_info.records = [{ description: 'New operation', actual_time: 1767456000000 }];
    const result = parseSpxPh(value, NUMBER);
    expect(result).toMatchObject({ status: 'unknown', last_update: null, events: [{ provider_time_text: '1767456000000' }] });
    expect(result.current_stage).toBeUndefined();
  });
  it('preserves the entire native sequence when any scan clock is unresolved', () => {
    const value = fixture();
    value.data.sls_tracking_info.records = [1, 4, null, 3, 5].map((offset, index) => ({
      description: `Operation ${index}`, actual_time: offset === null ? 'unresolved' : 1767456000 + offset,
    }));
    const result = parseSpxPh(value, NUMBER);
    expect(result.events?.map(event => event.description)).toEqual(['Operation 0', 'Operation 1', 'Operation 2', 'Operation 3', 'Operation 4']);
    expect(result.events?.[2]).toMatchObject({ provider_time_text: 'unresolved' });
    expect(result.last_status_text).toBe('Operation 0');
  });
});
describe('SPX Philippines status codes', () => {
  it('maps every recorded code to its recorded stage', () => {
    for (const entry of statuses.entries) {
      const legacy = entry.note?.startsWith('Legacy feed status.') ?? false;
      expect(spxPhStage(entry.code, legacy), entry.code).toBe(entry.stage);
    }
  });
  it('files modern scans by tracking code and keeps facility places but never seller pickups', () => {
    const value = fixture();
    value.data.sls_tracking_info.records = [
      { tracking_code: 'F980', description: 'Parcel has been delivered', actual_time: 1767456000, display_flag: 1 },
      { tracking_code: 'F650', description: 'Delivery attempt was unsuccessful', actual_time: 1767452400, display_flag: 1 },
      { tracking_code: 'F599', description: 'Parcel has arrived at the delivery hub : Example Hub', actual_time: 1767448800, display_flag: 1,
        current_location: { location_name: 'Example Hub', lat: '14.55551', lng: '121.04449', full_address: 'SYNTHETIC-ADDRESS' } },
      { tracking_code: 'F339', description: '[China] Parcel has cleared export customs', actual_time: 1767445200, display_flag: 1,
        current_location: { location_name: 'Example Airport', lat: '', lng: '' } },
      { tracking_code: 'F100', description: 'Parcel has been picked up by our logistics partner', actual_time: 1767441600, display_flag: 1,
        current_location: { location_name: 'PRIVATE-SELLER', lat: '14.6', lng: '121.1' } },
      { tracking_code: 'F001', description: 'Pickup attempt was unsuccessful', actual_time: 1767438000, display_flag: 1 },
    ];
    const result = parseSpxPh(value, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map' });
    expect(result.events?.map(event => [event.provider_code, event.stage, event.stage_source])).toEqual([
      ['F980', 'delivered', 'carrier_map'], ['F650', 'failed_attempt', 'carrier_map'], ['F599', 'in_transit', 'carrier_map'],
      ['F339', 'in_transit', 'carrier_map'], ['F100', 'accepted', 'carrier_map'], ['F001', 'registered', 'carrier_map'],
    ]);
    expect(result.events?.[2]).toMatchObject({ location: 'Example Hub', point: { latitude: 14.5555, longitude: 121.0445 } });
    expect(result.events?.[3]).toMatchObject({ location: 'Example Airport' });
    expect(result.events?.[3]).not.toHaveProperty('point');
    expect(result.events?.[4]).not.toHaveProperty('location');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE-SELLER|SYNTHETIC-ADDRESS|"14\.6"/);
  });
  it('files legacy rows by their status name and leaves unknown codes to the wording', () => {
    const value = { retcode: 0, data: { sls_tracking_number: NUMBER, tracking_list: [
      { status: 'OnHold', message: '[Example Hub] Your parcel is on-hold. Reason: [Example Reason]', timestamp: 1767456000 },
      { status: 'Delivering', message: '[Example Hub] Your parcel is being delivered by courier', timestamp: 1767452400 },
      { status: 'New_Status', message: 'Parcel is out for delivery', timestamp: 1767448800 },
    ] } };
    const result = parseSpxPh(value, NUMBER, true);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'exception' });
    expect(result.events?.map(event => [event.provider_code, event.stage, event.stage_source])).toEqual([
      ['OnHold', 'exception', 'carrier_map'], ['Delivering', 'out_for_delivery', 'carrier_map'],
      ['New_Status', 'out_for_delivery', expect.stringMatching(/^wording:/)],
    ]);
  });
  it('accepts the earlier Shopee Express prefix and still refuses other countries', () => {
    expect(normalizeSpxPhNumber('speph00000000000a')).toBe('SPEPH00000000000A');
    expect(() => normalizeSpxPhNumber('SPEMY000000000001')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });
});
describe('SPX Philippines retrieval', () => {
  it('uses the modern endpoint first and bounds legacy recovery to the same lookup', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ retcode: 0, data: {} })))
      .mockResolvedValueOnce(new Response(JSON.stringify(legacy())));
    await new SpxPhTracker({ fetcher }).fetch(NUMBER);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const first = new URL(String(fetcher.mock.calls[0]![0]));
    expect(first.pathname).toBe('/shipment/order/open/order/get_order_info'); expect(first.searchParams.get('spx_tn')).toBe(NUMBER);
    const second = new URL(String(fetcher.mock.calls[1]![0]));
    expect(second.pathname).toBe('/api/v2/fleet_order/tracking/search');
    expect(second.searchParams.get('sls_tracking_number')).toMatch(/^PH000000000001\|\d{10}[a-f0-9]{64}$/);
    expect(fetcher.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true);
  });
  it('does no I/O for foreign SPX numbers or an aborted lookup', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new SpxPhTracker({ fetcher }).fetch('SPXMY000000000001')).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(new SpxPhTracker({ fetcher }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
