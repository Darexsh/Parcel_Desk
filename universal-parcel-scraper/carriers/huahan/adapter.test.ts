import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import type { Stage } from '../../core/status/index.js';
import { HuahanTracker, solveHuahanQuestion } from './adapter.js';
import { parseHuahan } from './parser.js';

const NUMBER = 'HHWAA0000000001YQ';
const fixture = () => ({ ask: 1, data: [{ Code: NUMBER, Error_code: '0000', Status: 'Delivered',
  Shipper_Hawbcode: 'PRIVATE', Local_Carrier: 'CAINIAO', Local_Number: 'DOFR0000000000001HD', Country_code: 'FR', Detail: [
    { Occur_date: '2026-01-03 12:15:00', Status: 'CC', Comment: 'The parcel has been successfully delivered.', track_area: 'Destination facility', recipient: 'PRIVATE' },
    { Occur_date: '2026-01-01 10:00:00', Status: 'DF', Comment: 'Departed from origin facility', track_area: 'SHENZHEN' },
  ] }] });
const response = (value: unknown) => Response.json(value);
const init = () => {
  const reply = response({ ask: 1, token: 'synthetic-token' });
  Object.defineProperty(reply, 'url', { value: 'https://www.hh-exp.cn/WebTrack/init.php' });
  reply.headers.set('Set-Cookie', 'PHPSESSID=synthetic; Path=/');
  return reply;
};
function fetcher() {
  return vi.fn<typeof fetch>().mockResolvedValueOnce(init())
    .mockResolvedValueOnce(response({ ask: 1, type: 'text', question: '26 - 18 = ?' }))
    .mockResolvedValueOnce(new Response('ok')).mockResolvedValueOnce(response(fixture()));
}

describe('HuaHan guest tracking', () => {
  it('solves the issued question in one session and binds the complete waybill', async () => {
    const fetch = fetcher();
    const result = await new HuahanTracker({ fetcher: fetch }).fetch(NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update: null, last_update_local: '2026-01-03T12:15:00' });
    expect(result.events).toHaveLength(2);
    expect(result.events![1]).toMatchObject({ local_time: '2026-01-01T10:00:00', provider_code: 'DF', stage: 'in_transit' });
    expect(result.events!.every(event => !event.time)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    const verify = new URL(String(fetch.mock.calls[2]![0]));
    expect(verify.searchParams.get('token')).toBe('synthetic-token');
    expect(verify.searchParams.get('answer')).toBe('8');
    expect(String(fetch.mock.calls[3]![0])).toBe('https://www.hh-exp.cn/WebTrack/CargoTrackAction.php');
    const request = fetch.mock.calls[3]![1]!;
    expect(request.method).toBe('POST');
    expect(new URLSearchParams(String(request.body)).get('ordernumber')).toBe(NUMBER);
    expect(new Headers(request.headers).get('cookie')).toBe('PHPSESSID=synthetic');
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it('never evaluates code or guesses unsupported challenge types', async () => {
    for (const question of ['1;process.exit() = ?', '1 + 2 + 3 = ?', '1000 + 1 = ?', '1 / 0 = ?', '1 / 2 = ?', null]) {
      expect(() => solveHuahanQuestion(question)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
    expect(solveHuahanQuestion('12 × 3 = ?')).toBe('36');
    expect(solveHuahanQuestion('12 / 3 = ?')).toBe('4');
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(init()).mockResolvedValueOnce(response({ ask: 1, type: 'click', question: '1 + 2 = ?' }));
    await expect(new HuahanTracker({ fetcher: fetch }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('requires accepted verification before looking up a shipment', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(init())
      .mockResolvedValueOnce(response({ ask: 1, type: 'text', question: '1 + 2 = ?' })).mockResolvedValueOnce(new Response('error'));
    await expect(new HuahanTracker({ fetcher: fetch }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('only treats an explicit absence as not-found', () => {
    expect(() => parseHuahan({ ask: 0, msg: '没有找到记录', data: [] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseHuahan({ ask: 0, msg: '请先通过滑块验证', data: [] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseHuahan({ ask: 0, msg: 'too many requests', data: [] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parseHuahan({ ask: 0, data: [] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHuahan({ ask: 1, data: [] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const empty = fixture(); empty.data[0]!.Detail = [];
    expect(() => parseHuahan(empty, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects unrelated identities, contradictory results and malformed clocks', () => {
    const wrong = fixture(); wrong.data[0]!.Code = 'HHWAA0000000002YQ';
    expect(() => parseHuahan(wrong, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const failed = fixture(); failed.data[0]!.Error_code = '9999';
    expect(() => parseHuahan(failed, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const clock = fixture(); clock.data[0]!.Detail[0]!.Occur_date = '2026-02-30 12:00:00';
    expect(() => parseHuahan(clock, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const duplicate = fixture(); duplicate.data.push(duplicate.data[0]!);
    expect(() => parseHuahan(duplicate, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('names the destination carrier, its number and the destination country', () => {
    expect(parseHuahan(fixture(), NUMBER)).toMatchObject({ destination_country: 'FR', delivery_carrier: 'aliexpress',
      delivery_tracking_number: 'DOFR0000000000001HD' });
    const usps = fixture();
    Object.assign(usps.data[0]!, { Local_Carrier: 'USPS', Local_Number: '9214490000000000000010_D104', Country_code: 'US' });
    expect(parseHuahan(usps, NUMBER)).toMatchObject({ destination_country: 'US', delivery_carrier: 'usps',
      delivery_tracking_number: '9214490000000000000010' });
    // A partner the catalog does not know, or whose rules do not fit the number, keeps only the number.
    const unknown = fixture();
    Object.assign(unknown.data[0]!, { Local_Carrier: 'Sample Couriers', Local_Number: 'SMP12345678' });
    const result = parseHuahan(unknown, NUMBER);
    expect(result.delivery_tracking_number).toBe('SMP12345678');
    expect(result.delivery_carrier).toBeUndefined();
    const none = fixture();
    Object.assign(none.data[0]!, { Local_Carrier: '', Local_Number: NUMBER, Country_code: null });
    expect(parseHuahan(none, NUMBER)).not.toHaveProperty('delivery_tracking_number');
    expect(parseHuahan(none, NUMBER)).not.toHaveProperty('destination_country');
  });

  it('places the destination carrier\'s scans after the hand-off in a destination of one zone', () => {
    const relayed = fixture();
    relayed.data[0]!.Detail = [
      { Occur_date: '2026-01-06 11:17:00', Status: 'CC', Comment: 'Delivery Successful, Your shipment has been delivered successfully', track_area: 'SAMPLE TOWN' },
      { Occur_date: '2026-01-05 20:44:00', Status: 'IA', Comment: 'Sorting Center Inbound, Your shipment has arrived at sorting center', track_area: 'Sample Hub' },
      { Occur_date: '2026-01-04 15:28:22', Status: 'JY', Comment: 'Has been given to local carrier', track_area: 'NL' },
      { Occur_date: '2026-01-03 14:59:51', Status: 'LD', Comment: 'Arrived at destination airport', track_area: 'NL' },
      { Occur_date: '2026-01-01 10:00:00', Status: 'DF', Comment: 'Departed from origin facility', track_area: 'SHENZHEN' },
    ];
    const result = parseHuahan(relayed, NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update: '2026-01-06T11:17:00+01:00' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events!.map(event => event.time ?? event.local_time)).toEqual(['2026-01-06T11:17:00+01:00',
      '2026-01-05T20:44:00+01:00', '2026-01-04T15:28:22', '2026-01-03T14:59:51', '2026-01-01T10:00:00']);
    expect(result.events![2]).toMatchObject({ provider_code: 'JY', stage: 'in_transit', stage_source: 'carrier_map' });
    // A destination of several zones keeps every clock local.
    relayed.data[0]!.Country_code = 'US';
    const several = parseHuahan(relayed, NUMBER);
    expect(several).toMatchObject({ last_update: null, last_update_local: '2026-01-06T11:17:00' });
    expect(several.events!.every(event => !event.time)).toBe(true);
  });

  it('reads the flight, clearance and destination milestones by their codes', () => {
    const journey = fixture();
    journey.data[0]!.Detail = [
      { Occur_date: '2026-01-09 12:15:00', Status: 'CC', Comment: 'Delivered, Parcel was delivered successfully', track_area: '' },
      { Occur_date: '2026-01-09 05:44:00', Status: 'CB', Comment: 'Out for Delivery, Parcel is at courier, delivery expected soon.', track_area: '' },
      { Occur_date: '2026-01-07 20:38:00', Status: 'IA', Comment: 'In Transit', track_area: '' },
      { Occur_date: '2026-01-06 14:03:50', Status: 'YG', Comment: 'Import Customs clearance completed', track_area: 'NL' },
      { Occur_date: '2026-01-06 09:34:00', Status: 'LD', Comment: 'Arrived at destination airport', track_area: 'NL' },
      { Occur_date: '2026-01-06 06:34:00', Status: 'QG', Comment: 'Import Customs clearance started', track_area: 'NL' },
      { Occur_date: '2026-01-05 16:35:58', Status: 'QF', Comment: 'Departed from airport of Origin', track_area: 'HK' },
      { Occur_date: '2026-01-03 12:54:49', Status: 'BG', Comment: 'Export customs clearance completed', track_area: 'HK' },
      { Occur_date: '2026-01-03 06:54:41', Status: 'GG', Comment: 'Transfer to Origin airport', track_area: 'CN' },
    ];
    const result = parseHuahan(journey, NUMBER);
    expect(result.current_stage).toBe('delivered');
    expect(result.events!.map(event => event.stage)).toEqual(['delivered', 'out_for_delivery', 'in_transit',
      'in_transit', 'in_transit', 'customs', 'in_transit', 'in_transit', 'in_transit']);
    expect(result.events!.filter(event => event.stage_source === 'carrier_map').map(event => event.provider_code))
      .toEqual(['CC', 'CB', 'IA', 'YG', 'LD', 'QG', 'QF', 'BG', 'GG']);
  });

  it('keeps the destination carrier\'s placed line for a scan also listed in generic words', () => {
    const twice = fixture();
    twice.data[0]!.Detail = [
      { Occur_date: '2026-01-09 12:15:00', Status: 'CC', Comment: 'Delivered, Parcel was delivered successfully', track_area: '' },
      { Occur_date: '2026-01-09 12:15:00', Status: 'CC', Comment: 'The parcel has been successfully delivered.', track_area: 'Sample Town' },
      { Occur_date: '2026-01-09 05:44:00', Status: 'CB', Comment: 'Out for Delivery, Parcel is at courier, delivery expected soon.', track_area: '' },
      { Occur_date: '2026-01-09 05:44:00', Status: '', Comment: 'A courier has the parcel.', track_area: 'Sample Town' },
      { Occur_date: '2026-01-08 20:41:00', Status: 'IA', Comment: 'In Transit', track_area: '' },
      { Occur_date: '2026-01-08 20:38:00', Status: 'IA', Comment: 'In Transit', track_area: '' },
      { Occur_date: '2026-01-08 20:38:00', Status: 'IA', Comment: 'The parcel is in the central warehouse waiting to be processed.', track_area: 'Sample Hub' },
      { Occur_date: '2026-01-08 20:38:00', Status: 'IA', Comment: 'The parcel was sorted.', track_area: 'Sample Hub' },
      { Occur_date: '2026-01-06 14:03:50', Status: 'YG', Comment: 'Import Customs clearance completed', track_area: 'NL' },
    ];
    const result = parseHuahan(twice, NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'The parcel has been successfully delivered.' });
    expect(result.events!.map(event => [event.local_time, event.description, event.provider_code, event.stage])).toEqual([
      ['2026-01-09T12:15:00', 'The parcel has been successfully delivered.', 'CC', 'delivered'],
      ['2026-01-09T05:44:00', 'A courier has the parcel.', 'CB', 'out_for_delivery'],
      ['2026-01-08T20:41:00', 'In Transit', 'IA', 'in_transit'],
      // Two placed lines at the generic line's minute: none of them is its copy.
      ['2026-01-08T20:38:00', 'In Transit', 'IA', 'in_transit'],
      ['2026-01-08T20:38:00', 'The parcel is in the central warehouse waiting to be processed.', 'IA', 'in_transit'],
      ['2026-01-08T20:38:00', 'The parcel was sorted.', 'IA', 'in_transit'],
      ['2026-01-06T14:03:50', 'Import Customs clearance completed', 'YG', 'in_transit'],
    ]);
  });

  it('keeps pickup-point arrival distinct from delivery to the recipient', () => {
    const pickup = fixture();
    pickup.data[0]!.Status = 'Available for collection';
    pickup.data[0]!.Detail[0]!.Status = 'PB';
    pickup.data[0]!.Detail[0]!.Comment = 'The parcel has arrived at the delivery point.';
    const result = parseHuahan(pickup, NUMBER);
    expect(result.current_stage).toBe('ready_for_pickup');
    expect(result.events![0]).toMatchObject({ stage: 'ready_for_pickup', stage_source: 'carrier_map' });
  });

  it('preserves blocked, missing-route and rate-limit failures without session diagnostics', async () => {
    for (const [status, body, kind] of [[200, '<html>Verification</html>', 'challenge'], [401, '{}', 'challenge'],
      [404, 'missing', 'transport'], [429, 'PRIVATE', 'rate_limited']] as const) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body, { status }));
      const failure = await new HuahanTracker({ fetcher: fetch }).fetch(NUMBER).catch(error => error);
      expect(failure.kind).toBe(kind);
      expect(failure.diagnostics).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses unsupported numbers and respects cancellation before requests', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const tracker = new HuahanTracker({ fetcher: fetch });
    await expect(tracker.fetch('HHWAA0000000001YQ,HHWAA0000000002YQ')).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(tracker.fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('HuaHan status map', () => {
  it('reads its milestones a tracking provider relays under the provider\'s own codes by their words', () => {
    const relayed: [string, string, Stage][] = [
      ['InfoReceived', 'Shipment information received', 'registered'],
      ['InTransit_PickedUp', 'Arrived at origin facility', 'accepted'],
      ['InTransit_Other', 'Departed from origin facility', 'in_transit'],
      ['InTransit_Other', 'Transfer to Origin airport', 'in_transit'],
      ['InTransit_Other', 'Export customs clearance completed', 'in_transit'],
      ['InTransit_Departure', 'Departed from airport of Origin', 'in_transit'],
      ['InTransit_CustomsProcessing', 'Import Customs clearance started', 'customs'],
      ['InTransit_CustomsReleased', 'Import Customs clearance completed', 'in_transit'],
      ['InTransit_Other', 'Has been given to local carrier', 'in_transit'],
    ];
    for (const [code, wording, stage] of relayed) {
      expect(statusMapAnswer({ carrier: 'huahan', providerCode: code, description: wording }), wording).toEqual({ kind: 'mapped', stage });
    }
    // HuaHan's own codes give the stage; one the map does not list is not read by its words.
    expect(statusMapAnswer({ carrier: 'huahan', providerCode: 'DF', description: 'Departed from origin facility' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'huahan', providerCode: 'ZZ', description: 'Departed from origin facility' })).toEqual({ kind: 'unknown' });
    // The destination carrier's address change, relayed without a code after the hand-off.
    expect(statusMapAnswer({ carrier: 'huahan', providerCode: null, description: 'Change of delivery address' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
  });
});
