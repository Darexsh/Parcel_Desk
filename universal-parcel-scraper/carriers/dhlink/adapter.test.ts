import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, DHLINK_API, DhlinkTracker } from './adapter.js';
import { DHLINK_LAST_LEGS, normalizeDhlinkNumber, parseDhlink } from './parser.js';
import { dhlinkEnglish, dhlinkStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const WAREHOUSE = 'XYT9900000001US';
const WAREHOUSE_OWN = 'FC9912310000001';
const POSTAL = 'LV990000006CN';
const LINE = 'FC9912310000003';
const UNKNOWN = 'XYT9900000099US';
const LATER = Date.parse('2026-04-01T00:00:00Z');

type Row = Record<string, unknown>;
type Parcel = Row & { trackinfoList: Row[] };
type Envelope = { code: unknown; msg: unknown; data: { trackList: Parcel[] } };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Envelope;
const changed = (name: string, change: (parcel: Parcel, envelope: Envelope) => void) => {
  const envelope = fixture(name);
  change(envelope.data.trackList[0]!, envelope);
  return envelope;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': typeof body === 'string' ? 'text/html' : 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const timeline = (events: readonly Row[] | undefined) => events!.map((event) => [event.time ?? event.local_time, event.provider_code ?? null, event.stage ?? null, event.location ?? null]);
// The firewall's page, with its message written by a script and its ids invented.
const BLOCK_PAGE = '<!doctype html><html><head><meta charset=utf-8><title>403 Forbidden</title></head><body><div class=et id=et></div>'
  + '<span class=emu>https://www.dhlink.com/stage-api/trbiz/track/queryTrack</span><p>00000000_ZZ-000-000000_00000-00000</p>'
  + '<script>e("et").innerText=0==n?"抱歉，您的请求被阻断了":"Sorry, you have been blocked"</script></body></html>';

describe('DHLink HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('swiftx-at-warehouse')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new DhlinkTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' xyt-9900 0000-01us ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(DHLINK_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json;charset=UTF-8', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ trackNos: [WAREHOUSE], state: '', language: 'EN' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dhlink', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the warehouse’s nodes and hands the last leg to SwiftX', () => {
    const result = parseDhlink(fixture('swiftx-at-warehouse'), WAREHOUSE, LATER);
    expect(result).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      // Recorded minutes after their clocks, which would still be ahead on the US's: DHLink's Beijing time.
      last_status_text: 'Package departed from the warehouse', last_update: '2026-03-02T15:51:13+08:00',
      expected_delivery: null, delivery_carrier: 'swiftx', delivery_tracking_number: 'SWX990000000000000001', destination_country: 'US',
      events: [
        { time: '2026-03-02T15:51:13+08:00', description: 'Package departed from the warehouse', provider_code: 'WH011', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-03-02T13:51:49+08:00', description: 'Package received & scanned at warehouse', provider_code: 'WH001', stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
    // The DHLink number, the order id and the feeds' and rows' ids are never read.
    expect(JSON.stringify(result)).not.toMatch(/FC9912310000001|99000000001|9900000000001|ZZ0000|P9901/);
    // The parcel's own DHLink number finds it too.
    expect(parseDhlink(fixture('swiftx-at-warehouse'), WAREHOUSE_OWN, LATER).delivery_carrier).toBe('swiftx');
    // The tracker then asks SwiftX's adapter for its own number.
    expect(deliveryHandoff('dhlink', WAREHOUSE, result)).toEqual({ carrier: 'swiftx', number: 'SWX990000000000000001', basis: 'partner' });
  });

  it('reads a line’s order or a partner’s label after DHLink took the parcel as no step back', async () => {
    const row = (trackTime: string, info: string) => ({ trackTime, createDate: null, place: null, info, nodeCode: null, nodeName: null });
    const envelope = changed('swiftx-at-warehouse', (parcel) => {
      parcel.trackinfoList.push(row('2026-03-01 09:00:00', '货物电子信息已经收到'), row('2026-03-02 14:10:00', 'Shipping Label Created'),
        row('2026-03-02 16:40:00', '货物电子信息已经收到'), row('2026-03-02 18:00:00', '国内清关完成'));
    });
    // The parser keeps the carrier's reading; the shared one reads the rows after the warehouse's scan.
    expect(parseDhlink(envelope, WAREHOUSE, LATER).events!.filter((event) => event.stage === 'registered')).toHaveLength(3);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(envelope));
    const { result } = await createTracker({ fetcher, providers: [], env: {} }).track({ number: WAREHOUSE, carrier: 'dhlink' }, { budgetMs: 3000 });
    expect(result.events.map((event) => [event.description, event.stage, event.stage_source])).toEqual([
      ['Customs export clearance completed', 'in_transit', 'carrier_map'],
      ['货物电子信息已经收到', 'in_transit', 'carrier_map'],
      ['Package departed from the warehouse', 'in_transit', 'carrier_map'],
      ['Shipping Label Created', 'in_transit', 'carrier_map'],
      ['Package received & scanned at warehouse', 'accepted', 'carrier_map'],
      ['货物电子信息已经收到', 'registered', 'carrier_map'],
    ]);
  });

  it('reads a receipt after DHLink moved the parcel on as no step back', () => {
    const row = (trackTime: string, info: string) => ({ trackTime, createDate: null, place: null, info, nodeCode: null, nodeName: null });
    const result = parseDhlink(changed('swiftx-at-warehouse', (parcel) => {
      parcel.trackinfoList.push(row('2026-03-02 14:30:00', '中国邮政 已收取邮件'), row('2026-03-02 18:58:00', '中国邮政 已收取邮件'));
    }), WAREHOUSE, LATER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    expect(timeline(result.events).map((entry) => entry[2])).toEqual(['in_transit', 'in_transit', 'accepted', 'accepted']);
  });

  it('shows DHLink’s own nodes in Chinese in English, and a wording in both languages in its English half', () => {
    expect(dhlinkEnglish('国内清关完成')).toBe('Customs export clearance completed');
    expect(dhlinkEnglish('Arriving at the airport - arranging flights/到达机场-安排航班中')).toBe('Arriving at the airport - arranging flights');
    expect(dhlinkEnglish('到达机场-安排航班中')).toBe('Arriving at the airport - arranging flights');
    for (const wording of ['Sample wording/国内清关完成', '已入库', 'Customs export clearance completed']) expect(dhlinkEnglish(wording), wording).toBeUndefined();
    // The map stages the English as it does the Chinese.
    for (const wording of ['国内清关完成', 'Arriving at the airport - arranging flights/到达机场-安排航班中']) {
      expect(statusMap.stage(null, normalizeStatusWording(dhlinkEnglish(wording)!)), wording).toBe(statusMap.stage(null, normalizeStatusWording(wording)));
    }
  });

  it('keeps one row per scan, preferring DHLink’s node and English, and drops the destination code from Chinese places', () => {
    const result = parseDhlink(fixture('postal-delivered'), POSTAL, LATER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Shipment has delivered', last_update: null, last_update_local: '2026-02-20T15:10:00' });
    expect(result.destination_country).toBeUndefined();
    expect(result.delivery_carrier).toBeUndefined();
    // Scans with a place in China, on either row, are on Beijing time. The destination's are not
    // placed: the reply names no destination here.
    expect(timeline(result.events)).toEqual([
      ['2026-02-20T15:10:00', 'J014', 'delivered', null],
      ['2026-02-20T07:15:00', 'J013', 'out_for_delivery', null],
      ['2026-02-19T08:00:00', null, 'in_transit', null],
      ['2026-02-12T21:03:00', 'EUBJ010', 'in_transit', null],
      ['2026-02-10T12:15:28+08:00', null, 'in_transit', 'Sampleport'],
      ['2026-02-09T02:47:17+08:00', null, 'in_transit', 'Sampleport'],
      ['2026-02-09T01:06:58+08:00', null, 'customs', 'Sampleport'],
      // China Post's receipt, after the warehouse sent the parcel off: no step back.
      ['2026-02-08T13:00:03+08:00', null, 'in_transit', 'Sampletown'],
      ['2026-02-07T14:43:38+08:00', null, 'in_transit', '示例省'],
      ['2026-02-07T14:37:38+08:00', null, 'accepted', '示例市'],
      ['2026-02-06T23:11:47+08:00', 'EUBJ007', 'accepted', '示例市'],
    ]);
    expect(result.events!.map((event) => event.description)).toEqual(expect.arrayContaining(['Handed over to Airlines', 'Item Presented to Customs', '已出库']));
    expect(result.events!.some((event) => /已妥投|安排投递|飞机到达进港|送交出口海关/.test(String(event.description)))).toBe(false);
  });

  it('keeps one row of a scan relayed twice in two formats, without the ZIP codes', () => {
    const result = parseDhlink(fixture('usps-relayed'), LINE, LATER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', destination_country: 'US',
      last_update: '2026-01-24T16:07:00-05:00', delivered_at: '2026-01-24T16:07:00-05:00' });
    expect(result.last_update_local).toBeUndefined();
    // USPS's offices keep their state's time. DHLink's rows recorded before a US clock could have
    // struck keep its Beijing time; the others could be on either and stay wall clocks.
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.description, event.stage, event.location ?? null])).toEqual([
      ['2026-01-24T16:07:00-05:00', 'Delivered', 'delivered', 'SAMPLEVILLE, NY'],
      ['2026-01-24T16:02:00-05:00', 'SAMPLEVILLE, NY, No Access to Delivery Location', 'failed_attempt', 'SAMPLEVILLE, NY'],
      ['2026-01-24T06:18:00-05:00', 'SAMPLEVILLE, NY, US, Out for Delivery, Expected Delivery by 7:40pm', 'out_for_delivery', 'SAMPLEVILLE, NY, US'],
      // The office's place comes from the scan's other row.
      ['2026-01-20T11:42:00-05:00', 'EXAMPLETON, NJ, Arrived Shipping Partner Facility, USPS Awaiting Item', 'in_transit', 'EXAMPLETON, NJ'],
      ['2026-01-19T00:01:04', '货物已交UPS/USPS/Fedex,The goods have been delivered to UPS/USPS/Fedex', 'in_transit', null],
      ['2026-01-16T20:20:00+08:00', 'Flight arrival', 'in_transit', null],
      ['2026-01-16T00:48:29', 'Customs clearance completed', 'in_transit', null],
      ['2026-01-13T18:40:00+08:00', 'Flight departure', 'in_transit', null],
      // A place of placeholders and a country code alone names no place.
      ['2026-01-09T01:30:42+08:00', 'The package has sent from the warehouse', 'in_transit', null],
      ['2026-01-06T20:47:56+08:00', 'The collection warehouse has completed sorting', 'accepted', null],
      ['2026-01-03T17:58:49+08:00', 'Arrive at the collection warehouse', 'accepted', null],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/9990[12]/);
  });

  it('drops contact details, signatures and British or Canadian postcodes from a relayed row', () => {
    const result = parseDhlink(changed('postal-delivered', (parcel) => {
      Object.assign(parcel.trackinfoList[0]!, { info: '【GB】已妥投，签收人：示例', place: 'SAMPLEBURY ZZ9 9ZZ' });
      Object.assign(parcel.trackinfoList[1]!, { info: 'Delivered, signed for by SAMPLE NAME' });
      Object.assign(parcel.trackinfoList[2]!, { info: 'Scheduled for Delivery SAMPLETOWN Z9Z 9Z9, tel: 99 9999 9999' });
      Object.assign(parcel.trackinfoList[8]!, { info: 'Handed over to Airlines at the airport hotel: gate 9' });
    }), POSTAL, LATER);
    expect(result.events!.slice(0, 2).map((event) => [event.description, event.stage, event.location ?? null])).toEqual([
      ['Delivered', 'delivered', null],
      ['Scheduled for Delivery SAMPLETOWN', 'out_for_delivery', null],
    ]);
    expect(result.events![4]!.description).toBe('Handed over to Airlines at the airport hotel: gate 9');
    expect(JSON.stringify(result)).not.toMatch(/签收人|SAMPLE NAME|ZZ9|Z9Z|9999/);
    // The Chinese row, now without a better English twin, keeps its wording up to the signature.
    const chinese = parseDhlink(changed('postal-delivered', (parcel) => {
      parcel.trackinfoList.splice(1, 1);
      Object.assign(parcel.trackinfoList[0]!, { info: '【GB】已妥投，签收人：示例', place: 'SAMPLEBURY ZZ9 9ZZ' });
    }), POSTAL, LATER);
    expect(chinese.events![0]).toMatchObject({ description: '【GB】已妥投', stage: 'delivered', location: 'SAMPLEBURY' });
  });

  it('places a scan’s clock by when DHLink recorded it, and leaves it a wall clock when either zone fits', () => {
    const row = (trackTime: string, createDate: string | null, place: string, info: string) => ({ trackTime, createDate, place, info, nodeCode: null, nodeName: null });
    const relayed = (rows: Row[], destination = 'US', lastTurnNo: string | null = null) => parseDhlink(changed('swiftx-at-warehouse', (parcel) => {
      parcel.destCountryCode = destination;
      parcel.lastTurnNo = lastTurnNo;
      parcel.trackinfoList = rows;
    }), WAREHOUSE, LATER);
    // A line provider's relayed scans, recorded within minutes: a US clock would still be ahead of the record.
    const line = relayed([
      row('2026-03-10 09:12:00', '2026-03-10 09:40:05', 'LA_SBA Warehouse, US', 'Out for delivery'),
      row('2026-03-09 21:30:00', '2026-03-10 14:00:00', 'LAX HUB, US', 'Arrived at destination hub'),
    ]);
    expect(line).toMatchObject({ last_update: '2026-03-10T09:12:00+08:00', status: 'out_for_delivery' });
    expect(line.last_update_local).toBeUndefined();
    // Recorded 16½ hours after its clock: Beijing or New York could both be its time.
    expect(line.events![1]).toMatchObject({ local_time: '2026-03-09T21:30:00', location: 'LAX HUB, US' });
    // GOFO's and SwiftX's relayed scans are on Beijing time however late DHLink records them, a state's office too.
    const late = [row('2026-03-09 21:30:00', '2026-03-11 14:00:00', 'SAMPLEVILLE, GA 99901', 'Arrived at GOFO Regional Hub'),
      row('2026-03-09 08:00:00', '2026-03-11 14:00:00', 'none', 'Shipping Label Created')];
    for (const lastTurnNo of ['GFUS99000000000001', 'SWX990000000000000001']) {
      expect(timeline(relayed(late, 'US', lastTurnNo).events), lastTurnNo).toEqual([
        ['2026-03-09T21:30:00+08:00', null, 'in_transit', 'SAMPLEVILLE, GA'], ['2026-03-09T08:00:00+08:00', null, 'registered', null]]);
    }
    // SwiftX's copy of a scan DHLink records on Beijing time, on its Chicago clock, is the same scan.
    const hub = [row('2026-03-10 16:10:56', '2026-03-10 16:11:30', 'SAMPLE HUB, US', 'Arrived at Origin Hub'),
      row('2026-03-10 03:10:56', '2026-03-10 16:12:00', 'SAMPLEVILLE, US', 'Arrived at Origin Hub'),
      row('2026-03-10 05:10:56', '2026-03-10 16:12:00', 'SAMPLEVILLE, US', 'Arrived at Origin Hub')];
    expect(timeline(relayed(hub, 'US', 'SWX990000000000000001').events)).toEqual([
      ['2026-03-10T16:10:56+08:00', null, 'in_transit', 'SAMPLE HUB, US'], ['2026-03-10T05:10:56+08:00', null, 'in_transit', 'SAMPLEVILLE, US']]);
    // Elsewhere it is not.
    expect(relayed(hub, 'GB', 'SWX990000000000000001').events).toHaveLength(3);
    // Without a known partner, a partner's US-clock copy of DHLink's pickup row, recorded on Beijing time, is the same scan.
    const relayedPickup = [{ ...row('2026-03-11 02:57:21', '2026-03-11 02:58:00', 'none', 'Package picked up by last-mile carrier'),
      nodeCode: 'TQ001', nodeName: 'Last mile pickup' }, row('2026-03-10 13:57:21', '2026-03-11 10:00:00', 'none', 'Package picked up by last-mile carrier')];
    expect(timeline(relayed(relayedPickup).events)).toEqual([['2026-03-11T02:57:21+08:00', 'TQ001', 'in_transit', null]]);
    // A row whose clock is not known to be Beijing's has no copy.
    expect(relayed([relayedPickup[1]!, row('2026-03-10 14:57:21', '2026-03-11 10:00:00', 'none', 'Package picked up by last-mile carrier')])
      .events).toHaveLength(2);
    // DHLink's pickup node on a GOFO line gives GOFO's hub scan on the hub's clock; the line's own rows stay on Beijing time.
    const pickup = (place: string, createDate = '2026-03-11 07:19:00') => ({ ...row('2026-03-10 11:38:05', createDate, place,
      'Package picked up by last-mile carrier'), nodeCode: 'TQ001', nodeName: 'Last mile pickup' });
    const cleared = row('2026-03-10 13:55:22', '2026-03-11 10:02:00', 'none', 'Customs import clearance completed, awaiting pickup by local carrier');
    expect(timeline(relayed([cleared, pickup('SAMPLEVILLE, IL, US')], 'US', 'GFUS99000000000001').events)).toEqual([
      ['2026-03-10T13:55:22+08:00', null, 'in_transit', null], ['2026-03-10T11:38:05-05:00', 'TQ001', 'in_transit', 'SAMPLEVILLE, IL, US']]);
    expect(relayed([pickup('SAMPLEVILLE, IL 99901, US')], 'US', 'GFUS99000000000001').last_update).toBe('2026-03-10T11:38:05-05:00');
    // A state split between zones leaves the wall clock, and a pickup recorded before its hub's clock struck is on Beijing time.
    expect(relayed([pickup('SAMPLEVILLE, IN, US')], 'US', 'GFUS99000000000001'))
      .toMatchObject({ last_update: null, last_update_local: '2026-03-10T11:38:05' });
    expect(relayed([pickup('SAMPLEVILLE, IL, US', '2026-03-10 11:40:00')], 'US', 'GFUS99000000000001').last_update).toBe('2026-03-10T11:38:05+08:00');
    // A pickup naming no hub, and SwiftX's, are on Beijing time.
    expect(relayed([pickup('none')], 'US', 'GFUS99000000000001').last_update).toBe('2026-03-10T11:38:05+08:00');
    expect(relayed([pickup('SAMPLEVILLE, IL, US')], 'US', 'SWX990000000000000001').last_update).toBe('2026-03-10T11:38:05+08:00');
    // A scan recorded before even Beijing's reading of its clock is no Beijing clock.
    expect(relayed([row('2026-03-10 18:00:00', '2026-03-10 15:00:00', 'none', 'Delivered')], 'US', 'GFUS99000000000001').last_update).toBeNull();
    // Without such a partner, the office's state gives the clock.
    expect(relayed(late, 'US', '06190000000001').events![0]!.time).toBe('2026-03-09T21:30:00-04:00');
    // A post office's state, recorded before its clock could strike there: not the state's time.
    expect(relayed([row('2026-03-10 09:12:00', '2026-03-10 09:40:05', 'SAMPLEVILLE, CA 99901', 'Arrived at Post Office')]).last_update)
      .toBe('2026-03-10T09:12:00+08:00');
    // USPS's office named only in the wording.
    expect(relayed([row('2026-03-10 06:10:00', '2026-03-11 02:00:00', 'SAMPLETOWN', 'Out for Delivery SAMPLETOWN GA 99901')]).last_update)
      .toBe('2026-03-10T06:10:00-04:00');
    // A state split between zones does not tell the clock.
    expect(relayed([row('2026-03-10 06:10:00', '2026-03-11 02:00:00', 'SAMPLETOWN', 'Out for Delivery SAMPLETOWN TN 99901')]).last_update).toBeNull();
    // A single-zone destination's clock, and a row recorded too soon for it.
    expect(relayed([row('2026-03-10 18:00:00', '2026-03-11 03:30:00', 'none', 'Delivered')], 'GB')).toMatchObject({ last_update: null, last_update_local: '2026-03-10T18:00:00' });
    expect(relayed([row('2026-03-10 18:00:00', '2026-03-10 18:20:00', 'none', 'Delivered')], 'GB').last_update).toBe('2026-03-10T18:00:00+08:00');
    // DHLink's UK is Britain.
    expect(relayed([row('2026-03-10 18:00:00', '2026-03-10 18:20:00', 'none', 'Delivered')], 'UK'))
      .toMatchObject({ last_update: '2026-03-10T18:00:00+08:00', destination_country: 'GB' });
    // A destination keeping several zones: a row recorded before even its easternmost reading, Newfoundland's,
    // is on Beijing time, though its place names only the country, which is the parcel's and left out.
    const exported = (createDate: string) => relayed([{ ...row('2026-03-10 21:04:00', createDate, 'Canada', 'Package handed over to airline'),
      nodeCode: 'JH001', nodeName: 'Handed over to airline' }], 'CA');
    expect(exported('2026-03-10 21:04:30').events![0]).toMatchObject({ time: '2026-03-10T21:04:00+08:00' });
    expect(exported('2026-03-10 21:04:30').events![0]).not.toHaveProperty('location');
    expect(exported('2026-03-11 08:00:00')).toMatchObject({ last_update: null, last_update_local: '2026-03-10T21:04:00' });
    // Without the record, only a place settles a clock, and only up to the read.
    expect(relayed([row('2026-03-10 18:00:00', null, 'none', 'Delivered')], 'GB').last_update).toBeNull();
    expect(relayed([row('2026-03-10 18:00:00', null, '示例市', '已出库')]).last_update).toBe('2026-03-10T18:00:00+08:00');
    // A place in China whose clock is after its record is no Beijing clock.
    expect(relayed([row('2026-03-10 18:00:00', '2026-03-10 15:00:00', '示例市', '已出库')]).last_update).toBeNull();
    // A Chinese city in Latin letters with the destination's code appended is in China.
    const warehouse = relayed([row('2026-03-10 18:00:00', '2026-03-10 18:05:00', 'SHENZHEN, US', 'Package departed from the warehouse'),
      row('2026-03-10 09:00:00', '2026-03-10 18:05:00', 'shen zhen', 'Package received & scanned at warehouse'),
      row('2026-03-10 08:00:00', '2026-03-10 18:05:00', 'SAMPLEVILLE, US', 'Package received & scanned at warehouse')]);
    expect(timeline(warehouse.events)).toEqual([['2026-03-10T18:00:00+08:00', null, 'in_transit', 'SHENZHEN'],
      ['2026-03-10T09:00:00+08:00', null, 'accepted', 'shen zhen'], ['2026-03-10T08:00:00+08:00', null, 'accepted', 'SAMPLEVILLE, US']]);
  });

  it('drops the row’s own clock from the end of a node’s wording, and keeps any other', () => {
    const worded = (info: string) => parseDhlink(changed('postal-delivered', (parcel) => {
      parcel.trackinfoList[1]!.info = info;
    }), POSTAL, LATER).last_status_text;
    expect(worded('Shipment has delivered at 2026-02-20 15:10:00')).toBe('Shipment has delivered');
    expect(worded('Shipment has delivered at 2026-02-19 15:10:00')).toBe('Shipment has delivered at 2026-02-19 15:10:00');
  });

  it('holds back rows written ahead of the read, whatever their zone', () => {
    // Read before the flight's arrival at its earliest, UTC+14.
    const result = parseDhlink(fixture('usps-relayed'), LINE, Date.parse('2026-01-16T06:30:00Z'));
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Flight arrival', last_update_local: '2026-01-16T20:20:00' });
    // DHLink's delivered count is not read over rows still to come.
    expect(result.status).toBe('in_transit');
    expect(result.events).toHaveLength(6);
    expect(() => parseDhlink(fixture('usps-relayed'), LINE, Date.parse('2026-01-03T00:00:00Z'))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('drops the flight DHLink books the parcel on, which it writes before the flight', () => {
    const whole = parseDhlink(fixture('usps-relayed'), LINE, LATER);
    for (const wording of ['预计配载航班1月13日,Expected flight on January 13th', '预计配载航班时间：01-13；Estimated loading flight time:01-13']) {
      const booked = parseDhlink(changed('usps-relayed', (parcel) => {
        for (const row of parcel.trackinfoList.slice(18, 20)) row.info = wording;
      }), LINE, LATER);
      expect(booked.events).toHaveLength(whole.events!.length - 1);
      expect(booked.events!.some((event) => /预计配载航班|flight (?:on|time)/i.test(event.description ?? ''))).toBe(false);
    }
  });

  it('reads DHLink’s delivered count when the last feed’s wording says less', () => {
    const result = parseDhlink(changed('usps-relayed', (parcel) => { parcel.trackinfoList.splice(0, 2); }), LINE, LATER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'SAMPLEVILLE, NY, No Access to Delivery Location' });
    const moving = parseDhlink(changed('usps-relayed', (parcel) => { parcel.state = 2; parcel.trackinfoList.splice(0, 2); }), LINE, LATER);
    expect(moving).toMatchObject({ status: 'exception', current_stage: 'failed_attempt' });
  });

  it('hands over only through the table, with the whole number in the partner’s layout', () => {
    expect(DHLINK_LAST_LEGS.map((leg) => [leg.carrier, leg.number.source])).toEqual([['swiftx', '^SWX\\d{18}$'], ['gofo', '^GFUS\\d{14}$'], ['dpd', '^06[01]\\d{11}$']]);
    const handoff = (number: unknown) => {
      const result = parseDhlink(changed('swiftx-at-warehouse', (parcel) => { parcel.lastTurnNo = number; }), WAREHOUSE, LATER);
      return [result.delivery_carrier ?? null, result.delivery_tracking_number ?? null];
    };
    expect(handoff('swx 9900 0000 0000 0000 01')).toEqual(['swiftx', 'SWX990000000000000001']);
    expect(handoff('gfus 9900 0000 0000 01')).toEqual(['gofo', 'GFUS99000000000001']);
    expect(handoff('0619 0000 0000 01')).toEqual(['dpd', '06190000000001']);
    for (const number of ['06200000000001', '0600000000001', '060000000000001', 'SWX99000000000000001', 'SWX9900000000000000011', 'XSWX990000000000000001', '9400100000000000000001',
      'GFUS9900000000001', 'GFUS990000000000011', 'GF9900000000001', 'GFFR99000000000001', WAREHOUSE, '', null]) {
      expect(handoff(number), String(number)).toEqual([null, null]);
    }
  });

  it('counts a parcel only when the number asked is its tracking number or DHLink number', () => {
    // The search also finds a parcel by its other numbers.
    expect(() => parseDhlink(fixture('swiftx-at-warehouse'), POSTAL, LATER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseDhlink(changed('swiftx-at-warehouse', (parcel) => { parcel.trackno = null; parcel.logisticsNo = null; parcel.state = 2; }), WAREHOUSE, LATER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (parcel: Parcel) => { parcel.trackinfoList[0]!.trackTime = '2026-03-02 15:51'; },
      (parcel: Parcel) => { parcel.trackinfoList[0]!.trackTime = '2026-02-30 15:51:13'; },
      (parcel: Parcel) => { parcel.trackinfoList[0]!.trackTime = '2026-03-02 24:00:00'; },
      (parcel: Parcel) => { parcel.trackinfoList[0]!.trackTime = null; },
      (parcel: Parcel) => { parcel.trackinfoList[0]!.info = { en: 'Outbound' }; },
      (parcel: Parcel) => { parcel.trackinfoList[0] = 'Outbound' as never; },
      (parcel: Parcel) => { parcel.trackinfoList = {} as never; },
      (parcel: Parcel) => { parcel.trackinfoList = Array.from({ length: 501 }, () => parcel.trackinfoList[0]!); },
      (parcel: Parcel) => { parcel.trackno = [WAREHOUSE]; },
      (_parcel: Parcel, envelope: Envelope) => { envelope.data.trackList.push(envelope.data.trackList[0]!); },
      (_parcel: Parcel, envelope: Envelope) => { envelope.data = null as never; },
      (_parcel: Parcel, envelope: Envelope) => { envelope.code = '200'; },
    ]) {
      expect(() => parseDhlink(changed('swiftx-at-warehouse', change), WAREHOUSE, LATER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a refused lookup, a parcel without scans and a firewall block apart', async () => {
    const lookup = (body: unknown, number = UNKNOWN, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup({ ...fixture('not-found'), code: 500, msg: '系统繁忙' })).rejects.toMatchObject({ kind: 'indeterminate', reason: undefined });
    await expect(lookup(changed('swiftx-at-warehouse', (parcel) => { parcel.trackinfoList = null as never; }), WAREHOUSE)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(changed('swiftx-at-warehouse', (parcel) => { parcel.trackinfoList = []; }), WAREHOUSE)).rejects.toMatchObject({ kind: 'indeterminate' });
    // The firewall refuses a headless browser's User-Agent with its page and HTTP 403.
    await expect(lookup(BLOCK_PAGE, UNKNOWN, { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(BLOCK_PAGE)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>DHLink</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', UNKNOWN, { status: 302, headers: { Location: 'https://www.dhlink.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    // The route answers every number: without it, the service moved.
    await expect(lookup('', UNKNOWN, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
  });

  it('settles nothing on an empty answer for a DHLink number or a last leg’s number, in retrieval and recognition', async () => {
    // The search answers a parcel's DHLink number this way when the parcel has another
    // tracking number, and the last leg's number always.
    for (const number of ['FC9900000000009', 'SWX990000000000000009', 'GFUS99000000000009']) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('not-found')));
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
      await expect(carrier(fetcher).recognize!(number), number).rejects.toMatchObject({ kind: 'indeterminate' });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
    // Other layouts are looked up by the tracking number they are: the empty answer is not found.
    for (const number of [UNKNOWN, 'LV990000010CN', 'FC99000000000099', 'SWX99000000000000009', 'GFUS9900000000009', 'YLUS0000000009']) {
      expect(() => parseDhlink(fixture('not-found'), number, LATER), number).toThrow(expect.objectContaining({ kind: 'not_found' }));
    }
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: WAREHOUSE })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(WAREHOUSE)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known parcel and the unknown-number answer, and asks nothing for a number it cannot take', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('usps-relayed'))).mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(LINE)).resolves.toMatchObject({ known: true });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('NODIGITS')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers it cannot take and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['NODIGITS', 'FC99123', 'FC9912310000001/1', `FC${'9'.repeat(39)}`, 'FC'.repeat(40)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: WAREHOUSE }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeDhlinkNumber('fc 9912.3100-00003')).toBe(LINE);
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('usps-relayed')));
    await expect(carrier(fetcher).track({ number: LINE }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: WAREHOUSE }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a parcel filed under DHLink to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('usps-relayed')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: LINE, carrier: 'dhlink' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'dhlink', source: 'dhlink', result: { current_stage: 'delivered', destination_country: 'US' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === DHLINK_API)).toBe(true);
  });
});

describe('DHLink status vocabulary', () => {
  it('records every node and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      const code = entry.code ?? '';
      const wording = entry.wording ?? '';
      expect(statusMap.stage(code || null, wording.toLowerCase()), `${code} ${wording}`).toBe(entry.stage);
      expect(dhlinkStage(code, '', wording)?.stage, `${code} ${wording}`).toBe(entry.stage);
    }
    // A line whose codes the map does not know is read by its node's name.
    expect(dhlinkStage('ZZ001', 'Pending delivery', 'Synthetic note')).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
    // The partners' relayed English goes through the shared rules.
    expect(dhlinkStage('', '', 'Out for Delivery SAMPLETOWN NY')).toEqual({ stage: 'out_for_delivery', source: 'wording:language' });
    expect(dhlinkStage('', '', 'Synthetic note')).toBeNull();
    // The hand-over to the US partner is no delivery.
    expect(statusMapAnswer({ carrier: 'dhlink', providerCode: null, description: '货物已交UPS/USPS/Fedex,The goods have been delivered to UPS/USPS/Fedex' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    // Nor is the collection at the destination port.
    expect(dhlinkStage('', '', '目的港已提货 Delivery has been made at the destination port')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(statusMapAnswer({ carrier: 'dhlink', providerCode: 'SYNTHETIC', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    for (const description of ['预计配载航班时间：10-23；Estimated loading flight time:10-23', '预计配载航班1月2日,Expected flight on January 2nd']) {
      expect(statusMapAnswer({ carrier: 'dhlink', providerCode: null, description }), description)
        .toEqual({ kind: 'intentional_gap', note: expect.stringMatching(/keeps the stage it had/) });
    }
    expect(statusMapAnswer({ carrier: 'dhlink', providerCode: 'J014', description: 'Shipment has delivered' })).toEqual({ kind: 'mapped', stage: 'delivered' });
  });
});
