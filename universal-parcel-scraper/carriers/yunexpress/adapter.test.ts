import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient, type TrawlScrapeResponse } from '../../core/transport/index.js';
import { adapter, parse, parseCaptured, YunExpressTracker } from './adapter.js';
import { InvalidInputError } from '../../core/errors/index.js';
import statuses from './statuses.json' with { type: 'json' };
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { statusMap, withoutRepeatedParts, yunExpressCodeStatus, yunExpressStatus } from './status.js';

const NUMBER = 'YT0000000000000001';
const API = 'https://services.yuntrack.com/Track/Query';
const fixture = (name = 'in-transit') => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const captured = (body = fixture()): TrawlScrapeResponse => ({ url: 'https://www.yuntrack.com/parcelTracking', html: '<div>Tracking results</div>', tier: 2,
  statusCode: 200, userAgent: null, cookies: [], raw: {}, capturedResponses: [{ url: API, status: 200, headers: {}, body: JSON.stringify(body), base64Encoded: false, truncated: false, error: null }] });

describe('YunExpress captured response projection', () => {
  it('binds both result identities and preserves per-event clock evidence', () => {
    const result = normalizeCarrierResult(parse(fixture(), NUMBER));
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', last_update: '2026-03-20T13:39:00-04:00',
      destination_country: 'US', delivery_tracking_number: '9000000000000000000001' });
    expect(result.events).toHaveLength(14);
    expect(result.events?.[0]).toMatchObject({ time: '2026-03-20T13:39:00-04:00', location: 'Example facility' });
    expect(result.events?.[1]).toMatchObject({ local_time: '2026-03-19T13:39:00' });
    expect(result.events?.[1]!.time).toBeUndefined();
    expect(result.events?.at(-1)?.stage).toBe('registered');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it.each(['description', 'location', 'clock', 'missing summary'])('rejects a latest %s mismatch instead of returning older progress', mode => {
    const payload = fixture();
    const item = payload.ResultList[0];
    if (mode === 'description') item.TrackInfo.LastTrackEvent.ProcessContent = 'Different description';
    if (mode === 'location') item.TrackInfo.LastTrackEvent.ProcessLocation = 'Different facility';
    if (mode === 'clock') item.TrackInfo.LastTrackEvent.ProcessDate = '2026-03-20T13:40:00';
    if (mode === 'missing summary') delete item.TrackInfo.LastTrackEvent;
    expect(() => parse(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('maps an explicit delivered latest-event code without promoting earlier partner scans', () => {
    const payload = fixture();
    const item = payload.ResultList[0];
    item.Status = item.TrackInfo.TrackingStatus = item.TrackInfo.LastTrackEvent.TrackingStatus = 50;
    item.TrackInfo.LastTrackEvent.ProcessContent = 'Delivered by Mailbox, synthetic delivery note';
    item.TrackData.ProcessGroupList[0].ProcessDetailList[0].ProcessContent = 'Delivered by Mailbox, synthetic delivery note----Example facility';
    const result = parse(payload, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-03-20T13:39:00-04:00' });
    expect(result.events?.[1]!.stage).toBe('in_transit');
    item.TrackInfo.LastTrackEvent.ProcessContent = 'Different description';
    expect(() => parse(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads a place part given twice in a row once, but keeps a country after a town of its name', () => {
    const payload = fixture();
    const item = payload.ResultList[0];
    item.TrackInfo.LastTrackEvent.ProcessLocation = 'EXAMPLE, EXAMPLE, ES';
    item.TrackData.ProcessGroupList[0].ProcessDetailList[0].ProcessContent = 'Customs inspection - Import----EXAMPLE, EXAMPLE, ES';
    expect(parse(payload, NUMBER).events?.[0]).toMatchObject({ location: 'EXAMPLE, ES' });
    expect(withoutRepeatedParts('Mexico, Mexico')).toBe('Mexico, Mexico');
    expect(withoutRepeatedParts('Example, Example')).toBe('Example');
    expect(withoutRepeatedParts('Example facility')).toBe('Example facility');
  });

  it('stages the destination leg, and a hand-over to the local carrier is no delivery', () => {
    expect(yunExpressStatus('Delivered to local carrier')).toEqual({ status: 'in_transit', stage: 'in_transit' });
    expect(yunExpressStatus('Package accepted at courier partner')).toEqual({ status: 'in_transit', stage: 'in_transit' });
    expect(yunExpressStatus('Arrived at GOFO Regional Destination Facility')?.stage).toBe('in_transit');
    expect(yunExpressStatus('The driver is out for delivery')?.stage).toBe('out_for_delivery');
    expect(['Arrived at GOFO Regional Hub', 'Loaded on Vehicle', 'Arrived at GOFO Delivery Station', 'Out for Delivery']
      .map((wording) => yunExpressStatus(wording)?.stage)).toEqual(['in_transit', 'in_transit', 'in_transit', 'out_for_delivery']);
    // Yuntrack's capitals and spacing vary; the wording does not.
    expect(yunExpressStatus('arrived at  SORT facility ')?.stage).toBe('in_transit');
    expect(yunExpressStatus('Delivered')).toBeUndefined();
  });

  it("reads partners' missed deliveries by their fixed words, whatever place or reason follows", () => {
    expect(yunExpressStatus('Shipment is in transit to carrier')).toEqual({ status: 'in_transit', stage: 'in_transit' });
    const missed = { status: 'exception', stage: 'failed_attempt' };
    expect(yunExpressStatus('Delivery failed, type: Recipient absent or delivery location inaccessible. We will attempt redelivery soon.')).toEqual(missed);
    expect(yunExpressStatus('The parcel is being stored in the GLS parcel center. It could not be delivered as the parcel box was occupied.')).toEqual(missed);
    expect(yunExpressStatus('1 item has been transferred to Example (synthville) CARD LEFT')).toEqual(missed);
    expect(yunExpressStatus('2 items have been transferred to Example depot CARD LEFT')).toEqual(missed);
    // Another type of failure, or a transfer without a card, is not read as one.
    expect(yunExpressStatus('Delivery failed, type: Synthetic reason')).toBeUndefined();
    expect(yunExpressStatus('1 item has been transferred to Example (synthville)')).toBeUndefined();
  });

  it('requires a unique returned number and matching waybill identity', () => {
    const payload = fixture();
    payload.ResultList[0].TrackInfo.WaybillNumber = 'YT0000000000000002';
    expect(() => parse(payload, NUMBER)).toThrow('identity');
    payload.ResultList[0].TrackInfo.WaybillNumber = NUMBER;
    payload.ResultList.push(payload.ResultList[0]);
    expect(() => parse(payload, NUMBER)).toThrow('ambiguous');
  });

  it('recognizes only explicit missing-item records and separates interactive verification', () => {
    expect(() => parse(fixture('not-found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const payload = fixture();
    payload.ResultList[0].TrackData.ProcessGroupList = [];
    expect(() => parse(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse({ Code: 1003 }, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parse({ ResultList: [] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each(['count absent', 'count positive', 'summary populated', 'child parcel', 'last status absent'])('keeps an incomplete negative %s indeterminate', mode => {
    const payload = fixture('not-found');
    const item = payload.ResultList[0];
    if (mode === 'count absent') delete item.TrackInfo.TrackEventCount;
    if (mode === 'count positive') item.TrackInfo.TrackEventCount = 1;
    if (mode === 'summary populated') item.TrackInfo.LastTrackEvent.ProcessContent = 'Shipment information received';
    if (mode === 'child parcel') item.TrackData.ChildCount = 1;
    if (mode === 'last status absent') delete item.TrackInfo.LastTrackEvent.TrackingStatus;
    expect(() => parse(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects mismatched history even when every scan already carries an explicit offset', () => {
    const payload = fixture();
    const item = payload.ResultList[0];
    for (const group of item.TrackData.ProcessGroupList) for (const scan of group.ProcessDetailList) scan.ProcessDate += '-04:00';
    item.TrackInfo.LastTrackEvent.ProcessDate += '-04:00';
    item.TrackInfo.LastTrackEvent.ProcessLocation = 'Different facility';
    expect(() => parseCaptured(captured(payload), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('compares full latest text before applying output length limits', () => {
    const payload = fixture();
    const item = payload.ResultList[0];
    const prefix = 'A'.repeat(520);
    item.TrackData.ProcessGroupList[0].ProcessDetailList[0].ProcessContent = `${prefix}first----Example facility`;
    item.TrackInfo.LastTrackEvent.ProcessContent = `${prefix}other`;
    expect(() => parse(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('skips an older row that has a place but no wording', () => {
    const payload = fixture();
    const rows = payload.ResultList[0].TrackData.ProcessGroupList.flatMap((group: { ProcessDetailList: unknown[] }) => group.ProcessDetailList);
    rows[3].ProcessContent = '----Example airport';
    const result = parse(payload, NUMBER);
    expect(result.events).toHaveLength(13);
    expect(result.events?.some((event) => !event.description)).toBe(false);
  });

  it("stages China Post's relayed scans, moves the office of an arrival or departure into its place and shows them in English", () => {
    const payload = fixture();
    const item = payload.ResultList[0];
    const rows = item.TrackData.ProcessGroupList.flatMap((group: { ProcessDetailList: { ProcessContent: string }[] }) => group.ProcessDetailList);
    const relayed = [
      '邮件到达【示例市国际互换局】----示例省示例市',
      '已交承运商运输----示例市',
      '送交出口海关----',
      '【示例市国际互换局】已出口直封----示例省示例市',
      '邮件到达【示例市】，准备发往【示例航空中心】----示例市',
      '邮件离开【示例揽投部】，正在发往下一站----示例市',
      '邮件已在【示例揽投部】完成分拣，准备发出----示例市',
      '中国邮政已收取邮件----示例市',
    ];
    relayed.forEach((content, at) => { rows[at + 4].ProcessContent = content; });
    rows[0].ProcessContent = '邮件离开【示例市国际互换局】，正在发往【示例航空中心】----示例省示例市';
    Object.assign(item.TrackInfo.LastTrackEvent, { ProcessContent: '邮件离开【示例市国际互换局】，正在发往【示例航空中心】', ProcessLocation: '示例省示例市', GmtProcessTimezone: 'GMT+08:00' });
    const result = parse(payload, NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Departed for the next office' });
    expect(result.events?.[0]).toMatchObject({ description: 'Departed for the next office', location: '示例市国际互换局', time: '2026-03-20T13:39:00+08:00' });
    expect(result.events?.slice(4, 12).map(({ description, location, stage }) => ({ description, location, stage }))).toEqual([
      { description: 'Arrival', location: '示例市国际互换局', stage: 'in_transit' },
      { description: 'Handed to the carrier for transport', location: '示例市', stage: 'in_transit' },
      { description: 'Presented to export customs', location: '', stage: 'customs' },
      { description: 'Closed into an export dispatch', location: '示例省示例市', stage: 'in_transit' },
      { description: 'Arrived, to leave for the next office', location: '示例市', stage: 'in_transit' },
      { description: 'Departed for the next stop', location: '示例揽投部', stage: 'in_transit' },
      { description: 'Sorted and ready to leave', location: '示例市', stage: 'in_transit' },
      { description: 'China Post has received the mail', location: '示例市', stage: 'in_transit' },
    ]);
    // The map stages the English as it does the Chinese.
    for (const event of result.events!.slice(4, 12)) expect(statusMap.stage('', event.description!), event.description).toBe(event.stage);
    // An office the feed left empty is no place.
    rows[4].ProcessContent = '邮件到达【】----示例市';
    expect(parse(payload, NUMBER).events?.[4]).toMatchObject({ description: 'Arrival', location: '示例市', stage: 'in_transit' });
    // A partner's line in Japanese keeps its wording.
    rows[4].ProcessContent = '到着しました----Sample Town';
    expect(parse(payload, NUMBER).events?.[4]).toMatchObject({ description: '到着しました' });
  });

  it("stages China Post's relayed scans in the destination country, its import customs holding the item until the release", () => {
    const payload = fixture();
    const rows = payload.ResultList[0].TrackData.ProcessGroupList.flatMap((group: { ProcessDetailList: { ProcessContent: string }[] }) => group.ProcessDetailList);
    ['离开【示例国】处理中心----', '寄达地海关允许进口----', '境外进口海关留存待验(等待提交给边境机构/安全部门)----', '送交境外进口海关----', '到达寄达地处理中心----']
      .forEach((content, at) => { rows[at + 4].ProcessContent = content; });
    const events = parse(payload, NUMBER).events!.slice(4, 9);
    expect(events.map(({ description, stage }) => ({ description, stage }))).toEqual([
      { description: 'Departure from processing center', stage: 'in_transit' },
      { description: 'Import allowed by destination customs', stage: 'in_transit' },
      { description: 'Held by import customs abroad for inspection', stage: 'customs' },
      { description: 'Presented to import customs abroad', stage: 'customs' },
      { description: 'Arrival at processing center in the destination country', stage: 'in_transit' },
    ]);
    for (const event of events) expect(statusMap.stage('', event.description!), event.description).toBe(event.stage);
  });

  it("gives no place to China Post's relayed landing that names the airline as one", () => {
    const payload = fixture();
    const rows = payload.ResultList[0].TrackData.ProcessGroupList.flatMap((group: { ProcessDetailList: { ProcessContent: string }[] }) => group.ProcessDetailList);
    rows[4].ProcessContent = '飞机进港----邮政航空';
    rows[5].ProcessContent = '飞机进港----示例航空中心';
    expect(parse(payload, NUMBER).events!.slice(4, 6).map(({ description, location }) => ({ description, location }))).toEqual([
      { description: 'Plane has landed', location: '' },
      { description: 'Plane has landed', location: '示例航空中心' },
    ]);
  });

  // Rows newest first: 4 the flight's arrival, 5 its departure, 6 the export clearance,
  // 7 to 12 the origin leg's facilities, 13 the order data.
  const placing = (places: Record<number, string>) => {
    const payload = fixture();
    const rows = payload.ResultList[0].TrackData.ProcessGroupList.flatMap((group: { ProcessDetailList: { ProcessContent: string }[] }) => group.ProcessDetailList);
    for (const [at, place] of Object.entries(places)) {
      const row = rows[Number(at)]!;
      row.ProcessContent = `${row.ProcessContent.split('----')[0]}${place ? `----${place}` : ''}`;
    }
    return payload;
  };

  it("dates the rows without a place on China's leg on China's clock, up to the flight out", () => {
    const china = Object.fromEntries([7, 8, 9, 10, 11, 12].map((at) => [at, 'Mainland China, CN']));
    const result = parse(placing({ ...china, 4: 'ES', 5: '', 6: '', 13: '' }), NUMBER);
    for (const [at, time] of [[5, '2026-03-15T13:39:00+08:00'], [6, '2026-03-14T13:39:00+08:00'], [13, '2026-03-07T13:39:00+08:00']] as const) {
      expect(result.events?.[at]).toMatchObject({ time, local_time: time.slice(0, 19), time_zone: 'Asia/Shanghai', time_zone_basis: 'neighbour' });
    }
    for (const at of [1, 2, 3, 4, 7, 12]) expect(result.events?.[at]!.time).toBeUndefined();
  });

  it("leaves a row without a place to the facade when its nearest placed row is abroad or it follows the flight out", () => {
    const china = Object.fromEntries([7, 10, 11, 12].map((at) => [at, 'Mainland China, CN']));
    // A sender's row abroad inside China's leg lends China's clock to nothing.
    const abroad = parse(placing({ ...china, 9: 'Sample Town', 8: '', 5: '', 6: '' }), NUMBER);
    expect(abroad.events?.[8]!.time).toBeUndefined();
    expect(abroad.events?.[6]!.time).toBe('2026-03-14T13:39:00+08:00');
    // With no arrival row, the rows after the departure are the destination's.
    const payload = placing({ ...china, 1: '', 2: '', 3: '', 4: '', 5: '', 6: '' });
    payload.ResultList[0].TrackData.ProcessGroupList[4].ProcessDetailList[0].ProcessContent = 'Arrived at sort facility';
    const landed = parse(payload, NUMBER);
    for (const at of [1, 2, 3, 4]) expect(landed.events?.[at]!.time).toBeUndefined();
    expect(landed.events?.[5]!.time).toBe('2026-03-15T13:39:00+08:00');
    // A history without China's leg keeps every wall clock.
    expect(parse(placing({ 5: '', 6: '', 13: '' }), NUMBER).events?.filter((event) => event.time)).toHaveLength(1);
  });

  it("dates the destination leg on the latest scan's stated offset when none of its rows names a place", () => {
    const payload = placing({ 0: '', 1: '', 2: '', 3: '' });
    const info = payload.ResultList[0].TrackInfo;
    Object.assign(info.LastTrackEvent, { ProcessLocation: '', GmtProcessTimezone: 'GMT+10:00' });
    const result = parse(payload, NUMBER);
    expect(result.events?.[0]).toMatchObject({ time: '2026-03-20T13:39:00+10:00' });
    for (const [at, time] of [[1, '2026-03-19T13:39:00+10:00'], [3, '2026-03-17T13:39:00+10:00']] as const) {
      expect(result.events?.[at]).toMatchObject({ time, local_time: time.slice(0, 19), time_zone: 'UTC+10', time_zone_basis: 'neighbour' });
    }
    // The flight's arrival and what precedes it are not the leg.
    for (const at of [4, 5, 13]) expect(result.events?.[at]!.time).toBeUndefined();
    // A row of the leg with a place leaves the leg to the facade.
    payload.ResultList[0].TrackData.ProcessGroupList[2].ProcessDetailList[0].ProcessContent = 'Collected at Cargo Terminal----Sample Town';
    expect(parse(payload, NUMBER).events?.slice(1).filter((event) => event.time)).toHaveLength(0);
  });

  it("dates what follows the hand-over to the last-mile carrier on the stated offset when no flight in is listed", () => {
    // GOFO's scans relayed as "In Transit" have GOFO's wall clocks and no place;
    // on China's clock they came half a day early.
    const payload = placing({ 0: '', 1: '', 2: '', 3: '', 4: '' });
    const rows = payload.ResultList[0].TrackData.ProcessGroupList.flatMap((group: { ProcessDetailList: { ProcessContent: string }[] }) => group.ProcessDetailList);
    Object.assign(payload.ResultList[0].TrackInfo.LastTrackEvent, { ProcessLocation: '', GmtProcessTimezone: 'GMT-05:00' });
    rows[3].ProcessContent = 'Shipment is in transit to carrier';
    rows[4].ProcessContent = 'Arrived at sort facility';
    expect(parse(payload, NUMBER).events?.slice(0, 5).map((event) => event.time)).toEqual(['2026-03-20T13:39:00-05:00',
      '2026-03-19T13:39:00-05:00', '2026-03-18T13:39:00-05:00', undefined, undefined]);
    // From abroad, without the hand-over, no leg is named.
    rows[3].ProcessContent = 'Start Customs Clearence';
    expect(parse(payload, NUMBER).events?.filter((event) => event.time)).toHaveLength(1);
    // Unless GOFO names its facility: the leg starts at the first one.
    rows[2].ProcessContent = 'Arrived at GOFO Regional Hub';
    rows[4].ProcessContent = 'Shipping Label Created';
    expect(parse(payload, NUMBER).events?.slice(0, 5).map((event) => event.time)).toEqual(['2026-03-20T13:39:00-05:00',
      '2026-03-19T13:39:00-05:00', '2026-03-18T13:39:00-05:00', undefined, undefined]);
  });

  it("reads La Poste's platform scans in France on UTC, and its delivery office's on the office's clock", () => {
    // Against La Poste's own instants: its arrival in France at 18:08:37+02:00 came as 16:08:37.
    const relay = () => fixture('la-poste-relay');
    const delivered = parse(relay(), NUMBER);
    expect(delivered).toMatchObject({ status: 'delivered', delivered_at: '2026-07-08T10:27:08+02:00' });
    expect(delivered.events?.slice(0, 8).map((event) => event.time ?? `local ${event.local_time}`)).toEqual([
      '2026-07-08T10:27:08+02:00', 'local 2026-07-08T08:56:20', 'local 2026-07-08T08:37:13', '2026-07-07T03:52:00Z',
      '2026-07-06T21:07:00Z', '2026-07-06T19:58:00Z', '2026-07-06T19:09:03Z', '2026-07-06T16:08:37Z']);
    expect(delivered.events?.[8]!.time).toBeUndefined();
    // Newest, the platform's scan disregards the offset its record states.
    const payload = relay();
    const item = payload.ResultList[0];
    item.TrackData.ProcessGroupList.shift();
    item.TrackInfo.TrackEventDetails.splice(0, 3);
    Object.assign(item.TrackInfo.LastTrackEvent, { ProcessDate: '2026-07-07T03:52:00', ProcessContent: 'Transport to delivery centre', TrackingStatus: 20 });
    expect(parse(payload, NUMBER)).toMatchObject({ status: 'in_transit', last_update: '2026-07-07T03:52:00Z' });
    // Another partner's reference, or another destination, keeps the wall clocks.
    for (const change of [{ TrackingNumber: '9000000000000000000001' }, { DestinationCountryCode: 'BE' }]) {
      const other = relay();
      Object.assign(other.ResultList[0].TrackInfo, change);
      expect(parse(other, NUMBER).events?.slice(1, 8).every((event) => !event.time)).toBe(true);
    }
  });

  it("dates China Post's relayed scans on China's clock, abroad too", () => {
    const payload = fixture();
    const rows = payload.ResultList[0].TrackData.ProcessGroupList.flatMap((group: { ProcessDetailList: { ProcessContent: string }[] }) => group.ProcessDetailList);
    rows[1].ProcessContent = '到达寄达地----日本';
    rows[2].ProcessContent = '飞机进港----邮政航空';
    rows[3].ProcessContent = '航空公司启运';
    const result = parse(payload, NUMBER);
    for (const [at, time] of [[1, '2026-03-19T13:39:00+08:00'], [2, '2026-03-18T13:39:00+08:00'], [3, '2026-03-17T13:39:00+08:00']] as const) {
      expect(result.events?.[at]).toMatchObject({ time, local_time: time.slice(0, 19), time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier' });
    }
    // A partner's row keeps its wall clock, in Japanese too.
    rows[1].ProcessContent = 'お届け済み----Sample Town';
    expect(parse(payload, NUMBER).events?.[1]!.time).toBeUndefined();
  });

  it("dates the destination post's own scans China Post relays on the destination's clock", () => {
    const payload = fixture();
    const rows = payload.ResultList[0].TrackData.ProcessGroupList.flatMap((group: { ProcessDetailList: { ProcessContent: string }[] }) => group.ProcessDetailList);
    ['离开【日本】处理中心----', '寄达地海关允许进口----', '境外进口海关留存待验(等待提交给边境机构/安全部门)----', '送交境外进口海关----', '到达寄达地处理中心----', '到达寄达地----日本']
      .forEach((content, at) => { rows[at + 1].ProcessContent = content; });
    const read = () => parse(payload, NUMBER).events!.slice(1, 7).map(({ time, time_zone, time_zone_basis }) => [time, time_zone, time_zone_basis]);
    payload.ResultList[0].TrackInfo.DestinationCountryCode = 'JP';
    expect(read()).toEqual([
      ['2026-03-19T13:39:00+09:00', 'Asia/Tokyo', 'destination'],
      ['2026-03-18T13:39:00+09:00', 'Asia/Tokyo', 'destination'],
      ['2026-03-17T13:39:00+09:00', 'Asia/Tokyo', 'destination'],
      ['2026-03-16T13:39:00+09:00', 'Asia/Tokyo', 'destination'],
      ['2026-03-15T13:39:00+09:00', 'Asia/Tokyo', 'destination'],
      // China Post's own arrival in the country stays on China's clock.
      ['2026-03-14T13:39:00+08:00', 'Asia/Shanghai', 'carrier'],
    ]);
    // A destination with several clocks leaves them to the scans around them.
    payload.ResultList[0].TrackInfo.DestinationCountryCode = 'US';
    expect(read().slice(0, 5).every(([time]) => time === undefined)).toBe(true);
    // A departure from a processing centre in China is China Post's own.
    rows[1].ProcessContent = '离开【示例处理中心】处理中心----';
    expect(parse(payload, NUMBER).events?.[1]).toMatchObject({ time: '2026-03-19T13:39:00+08:00', time_zone_basis: 'carrier' });
  });

  it("dates the destination post's latest scan on its clock, though the record states China's", () => {
    const payload = fixture();
    const item = payload.ResultList[0];
    const rows = item.TrackData.ProcessGroupList.flatMap((group: { ProcessDetailList: { ProcessContent: string }[] }) => group.ProcessDetailList);
    rows[0].ProcessContent = '【日本】已妥投----日本';
    Object.assign(item.TrackInfo.LastTrackEvent, { ProcessContent: '【日本】已妥投', ProcessLocation: '日本', GmtProcessTimezone: 'GMT+08:00' });
    item.TrackInfo.DestinationCountryCode = 'JP';
    expect(parse(payload, NUMBER).events?.[0]).toMatchObject({ time: '2026-03-20T13:39:00+09:00', time_zone: 'Asia/Tokyo', time_zone_basis: 'destination' });
    // China Post's own latest scan keeps the stated offset.
    rows[0].ProcessContent = '到达寄达地----日本';
    Object.assign(item.TrackInfo.LastTrackEvent, { ProcessContent: '到达寄达地' });
    expect(parse(payload, NUMBER).events?.[0]!.time).toBe('2026-03-20T13:39:00+08:00');
  });

  it('dates a parcel sent within its destination country as one leg', () => {
    const payload = placing(Object.fromEntries(Array.from({ length: 14 }, (_, at) => [at, ''])));
    const item = payload.ResultList[0];
    Object.assign(item.TrackInfo.LastTrackEvent, { ProcessLocation: '', GmtProcessTimezone: 'GMT+09:30' });
    item.TrackData.ProcessGroupList[4].ProcessDetailList[0].ProcessContent = 'Arrived at sort facility';
    item.TrackData.ProcessGroupList[5].ProcessDetailList[0].ProcessContent = 'Departed from facility';
    Object.assign(item.TrackInfo, { DestinationCountryCode: 'AU', OriginCountryCode: 'AU' });
    const events = parse(payload, NUMBER).events!;
    expect(events.every((event) => event.time?.endsWith('+09:30'))).toBe(true);
    expect(events[13]).toMatchObject({ time: '2026-03-07T13:39:00+09:30', time_zone: 'UTC+9:30', time_zone_basis: 'neighbour' });
    // From abroad, a history without the flight in names no leg.
    item.TrackInfo.OriginCountryCode = 'CN';
    expect(parse(payload, NUMBER).events?.filter((event) => event.time)).toHaveLength(1);
  });

  it("hands over to the partner whose own reference a relayed row's contact link carries", () => {
    const payload = fixture();
    const info = payload.ResultList[0].TrackInfo;
    const rows = payload.ResultList[0].TrackData.ProcessGroupList.flatMap((group: { ProcessDetailList: unknown[] }) => group.ProcessDetailList);
    info.TrackingNumber = '';
    info.DestinationCountryCode = 'AU';
    rows[3].ProcessContent = "1 item has been transferred to Example (synthville) <b><a href='/Contact?tracNum=CPABC0000000001'>CARD LEFT</a></b>----Example facility";
    const result = parse(payload, NUMBER);
    expect(result).toMatchObject({ delivery_carrier: 'couriersplease', delivery_tracking_number: 'CPABC0000000001' });
    expect(deliveryHandoff('yunexpress', NUMBER, result)).toEqual({ carrier: 'couriersplease', number: 'CPABC0000000001', basis: 'partner' });
    // A carrier that does not deliver where the parcel goes owns no reference.
    info.DestinationCountryCode = 'US';
    expect(parse(payload, NUMBER)).not.toHaveProperty('delivery_tracking_number');
    info.DestinationCountryCode = 'AU';
    // Neither does a shape no carrier claims, nor one of two references.
    rows[3].ProcessContent = rows[3].ProcessContent.replace('CPABC0000000001', 'CP000000000001');
    expect(parse(payload, NUMBER)).not.toHaveProperty('delivery_tracking_number');
    rows[3].ProcessContent = rows[3].ProcessContent.replace('CP000000000001', 'CPABC0000000001');
    rows[2].ProcessContent = "Card left <a href='/Contact?tracNum=CPXYZ0000000002'>here</a>----Example facility";
    expect(parse(payload, NUMBER)).not.toHaveProperty('delivery_tracking_number');
    // A reference the reply declares wins over the link.
    info.TrackingNumber = 'GFUS01000000000001';
    expect(parse(payload, NUMBER)).toMatchObject({ delivery_tracking_number: 'GFUS01000000000001' });
    expect(parse(payload, NUMBER).delivery_carrier).toBeUndefined();
  });

  it("keeps a partner link's text and drops its markup and the number it holds", () => {
    const payload = fixture();
    const rows = payload.ResultList[0].TrackData.ProcessGroupList.flatMap((group: { ProcessDetailList: unknown[] }) => group.ProcessDetailList);
    rows[3].ProcessContent = "1 item has been transferred to Example (synthville) <b><a href='/Contact?tracNum=CP000000000001'>CARD LEFT</a></b>----Example facility";
    const event = parse(payload, NUMBER).events?.[3];
    expect(event).toMatchObject({ description: '1 item has been transferred to Example (synthville) CARD LEFT', location: 'Example facility',
      stage: 'failed_attempt' });
    expect(JSON.stringify(event)).not.toMatch(/CP000000000001|href|</);
    // The map reads wording stored with the markup as the adapter now writes it.
    const stored = normalizeStatusWording("1 item has been transferred to Example (synthville) <b><a href='/Contact?tracNum=CP000000000001'>CARD LEFT</a></b>");
    expect(statusMap.stage(null, stored)).toBe('failed_attempt');
    expect(statusMap.stage(null, normalizeStatusWording(event!.description!))).toBe('failed_attempt');
  });

  it('keeps a dash given as the place out of a relayed line, newest or older', () => {
    const payload = fixture();
    const item = payload.ResultList[0];
    const rows = item.TrackData.ProcessGroupList.flatMap((group: { ProcessDetailList: unknown[] }) => group.ProcessDetailList);
    const preAdvice = 'Order information received. We\'re expecting your parcel to arrive with us.';
    rows[13].ProcessContent = `${preAdvice}-----`;
    const older = parse(payload, NUMBER);
    expect(older.events?.[13]).toMatchObject({ description: preAdvice, location: '', stage: 'registered' });
    // The latest scan's own record gives the dash as its place.
    rows[0].ProcessContent = `${preAdvice}-----`;
    Object.assign(item.TrackInfo.LastTrackEvent, { ProcessContent: preAdvice, ProcessLocation: '-' });
    const newest = parse(payload, NUMBER);
    expect(newest).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: preAdvice });
    expect(newest.events?.[0]).toMatchObject({ description: preAdvice, location: '', time: '2026-03-20T13:39:00-04:00' });
    rows[0].ProcessContent = 'Customs inspection - Import----Example facility';
    rows[13].ProcessContent = 'Shipment information received----Example-facility';
    Object.assign(item.TrackInfo.LastTrackEvent, { ProcessContent: 'Customs inspection - Import', ProcessLocation: 'Example facility' });
    expect(parse(payload, NUMBER).events?.[13]).toMatchObject({ description: 'Shipment information received', location: 'Example-facility' });
    // A wording that ends in a dash before an empty place, as its latest-scan record gives it.
    rows[0].ProcessContent = 'Arrived at sorting center -----';
    Object.assign(item.TrackInfo.LastTrackEvent, { ProcessContent: 'Arrived at sorting center -', ProcessLocation: '' });
    expect(parse(payload, NUMBER).events?.[0]).toMatchObject({ description: 'Arrived at sorting center -', location: '' });
  });

  it('names the last-mile carrier its notes link to only when that carrier offers the reference', () => {
    const payload = fixture();
    const info = payload.ResultList[0].TrackInfo;
    info.TrackingNumber = 'GFUS01000000000001';
    info.AdditionalNotes = '<p>Last Mile Website:</p><p><a href="https://www.gofo.com/" target="_blank">https://www.gofo.com</a></p>';
    expect(parse(payload, NUMBER)).toMatchObject({ delivery_carrier: 'gofo', delivery_tracking_number: 'GFUS01000000000001' });
    // The same brand's host also serves networks outside the carrier's scope.
    info.TrackingNumber = 'GFFR00000000000001';
    const regional = parse(payload, NUMBER);
    expect(regional.delivery_carrier).toBeUndefined();
    expect(regional.delivery_tracking_number).toBe('GFFR00000000000001');
    info.TrackingNumber = 'GFUS01000000000001';
    info.AdditionalNotes += '<p><a href="https://tracking.dpd.de/">https://tracking.dpd.de</a></p>';
    expect(parse(payload, NUMBER).delivery_carrier).toBeUndefined();
    info.AdditionalNotes = '<p><a href="https://www.example.com/">https://www.example.com</a></p>';
    expect(parse(payload, NUMBER).delivery_carrier).toBeUndefined();
  });

  it('names Emile when the notes link its site for an EM…CA reference', () => {
    const payload = fixture();
    const info = payload.ResultList[0].TrackInfo;
    info.TrackingNumber = 'EM000000000001CA';
    info.AdditionalNotes = '<p>Last Mile Website:</p><p><a href="https://www.emileps.com/" target="_blank">https://www.emileps.com</a></p>';
    expect(parse(payload, NUMBER)).toMatchObject({ delivery_carrier: 'emile', delivery_tracking_number: 'EM000000000001CA' });
  });

  it('files every recorded wording under its recorded stage', () => {
    for (const entry of statuses.entries) {
      if (!entry.wording) expect(yunExpressCodeStatus(Number(entry.code)), entry.code).toBeDefined();
      else expect(yunExpressStatus(entry.wording, entry.code === undefined ? undefined : Number(entry.code))?.stage, entry.wording).toBe(entry.stage);
    }
  });

  it('takes the status from the latest code when the newest wording is new, without staging it', () => {
    const payload = fixture();
    const item = payload.ResultList[0];
    item.TrackInfo.LastTrackEvent.ProcessContent = 'Synthetic partner wording';
    item.TrackData.ProcessGroupList[0].ProcessDetailList[0].ProcessContent = 'Synthetic partner wording----Example facility';
    item.TrackInfo.LastTrackEvent.TrackingStatus = 20;
    const transit = parse(payload, NUMBER);
    expect(transit.status).toBe('in_transit');
    expect(transit.current_stage).toBeUndefined();
    expect(transit.events?.[0]!.stage).toBeUndefined();
    item.TrackInfo.LastTrackEvent.TrackingStatus = 60;
    expect(parse(payload, NUMBER).status).toBe('unknown');
  });

  it('leaves a relayed notice without a stage and the status to the scan before it', () => {
    const payload = fixture();
    const item = payload.ResultList[0];
    const [newest, previous] = [item.TrackData.ProcessGroupList[0].ProcessDetailList[0], item.TrackData.ProcessGroupList[1].ProcessDetailList[0]];
    newest.ProcessContent = 'REMINDER EMAIL SENT FAILED----Example facility';
    previous.ProcessContent = 'DELIVERING, WAIT FOR CONSIGNEE PICK UP----Example facility';
    item.TrackInfo.LastTrackEvent.ProcessContent = 'REMINDER EMAIL SENT FAILED';
    item.TrackInfo.LastTrackEvent.TrackingStatus = 20;
    const waiting = parse(payload, NUMBER);
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', last_status_text: 'REMINDER EMAIL SENT FAILED' });
    expect(waiting.events?.[0]!.stage).toBeUndefined();
    expect(waiting.events?.[1]!.stage).toBe('ready_for_pickup');
    // A delivery before the notice is no delivery at the notice's time.
    previous.ProcessContent = 'POD available----Example facility';
    const delivered = parse(payload, NUMBER);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(delivered.delivered_at).toBeUndefined();
  });

  it('rejects a projection that omits scans present in the raw history', () => {
    const payload = fixture();
    payload.ResultList[0].TrackData.ProcessGroupList.pop();
    expect(() => parse(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it.each(['date', 'description', 'group'])('rejects invalid latest %s instead of promoting older progress', (mode) => {
    const payload = fixture();
    const groups = payload.ResultList[0].TrackData.ProcessGroupList;
    if (mode === 'date') groups[0].ProcessDetailList[0].ProcessDate = '2026-02-30T12:00:00';
    if (mode === 'description') groups[0].ProcessDetailList[0].ProcessContent = '';
    if (mode === 'group') groups[0].ProcessDetailList = null;
    expect(() => parse(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('uses the final capture and propagates failures rather than replaying an older success', () => {
    const page = captured();
    page.capturedResponses.push({ ...page.capturedResponses[0]!, status: 403 });
    expect(() => parseCaptured(page, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    page.capturedResponses.at(-1)!.status = 200;
    page.capturedResponses.at(-1)!.body = JSON.stringify({ ResultList: [] });
    expect(() => parseCaptured(page, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('separates a missing, truncated or failed capture from an explicit unknown parcel', () => {
    const page = captured();
    page.capturedResponses[0]!.truncated = true;
    expect(() => parseCaptured(page, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    page.capturedResponses[0]!.truncated = false;
    page.capturedResponses[0]!.body = 'invalid JSON';
    expect(() => parseCaptured(page, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    page.capturedResponses = [];
    expect(() => parseCaptured(page, NUMBER)).toThrow(expect.objectContaining({ kind: 'transport' }));
  });

  it('decodes an explicitly base64 encoded capture and proves each declared capability', () => {
    const page = captured();
    page.capturedResponses[0]!.body = Buffer.from(page.capturedResponses[0]!.body!).toString('base64');
    page.capturedResponses[0]!.base64Encoded = true;
    const result = parseCaptured(page, NUMBER);
    const delivered = fixture();
    const item = delivered.ResultList[0];
    item.Status = item.TrackInfo.TrackingStatus = item.TrackInfo.LastTrackEvent.TrackingStatus = 50;
    item.TrackInfo.TrackingNumber = 'GFUS01000000000001';
    item.TrackInfo.AdditionalNotes = '<a href="https://www.gofo.com/">GOFO</a>';
    const handed = parse(delivered, NUMBER);
    const checks: Record<string, boolean> = { history: Boolean(result.events?.length), location: Boolean(result.events?.some((event) => event.location)),
      delivered_at: Boolean(handed.delivered_at), delivery_partner: Boolean(handed.delivery_carrier && handed.delivery_tracking_number) };
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    for (const capability of metadata.capabilities) expect(checks[capability], capability).toBe(true);
  });
});

describe('YunExpress browser execution', () => {
  it('selects configured local Chromium without an additional service attempt', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const launch = vi.spyOn(chromium, 'launch').mockRejectedValue(new Error('Synthetic browser launch failure'));
    try {
      const instance = adapter({ trawl: new TrawlClient('http://127.0.0.1:8191', fetcher), browserExecutablePath: '/synthetic/chromium',
        fetcher, env: {}, recorder });
      expect(instance.steps).toEqual(['browser', 'trawl']);
      await expect(instance.track({ number: NUMBER })).rejects.toThrow('Synthetic browser launch failure');
      expect(launch).toHaveBeenCalledTimes(1);
      expect(fetcher).not.toHaveBeenCalled();
      expect(recorder.step).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ step: 'browser', outcome: 'error' }));
      expect(recorder.lookup).toHaveBeenCalledWith(expect.objectContaining({ attempts: 1, stepsAvailable: 1 }));
    } finally { launch.mockRestore(); }
  });

  it('gives local Chromium its 60 s limit out of a longer budget', async () => {
    const goto = vi.fn(async (url: string, options: { timeout: number }) => { void url; void options; return { status: () => 503 }; });
    const browser = { newPage: vi.fn(async () => ({ on: vi.fn(), goto })), close: vi.fn(async () => {}) };
    const launch = vi.spyOn(chromium, 'launch').mockResolvedValue(browser as never);
    try {
      await expect(new YunExpressTracker({ executablePath: '/synthetic/chromium' }).fetch(NUMBER, { budgetMs: 90_000 }))
        .rejects.toMatchObject({ kind: 'transport', message: 'YunExpress tracking page is unavailable' });
      expect(launch).toHaveBeenCalledOnce();
      const timeout = goto.mock.calls[0]![1].timeout;
      expect(timeout).toBeGreaterThan(50_000);
      expect(timeout).toBeLessThanOrEqual(60_000);
      expect(browser.close).toHaveBeenCalledOnce();
    } finally { launch.mockRestore(); }
  });

  it('requests Trawl capture with a fresh page and bounded cancellation-aware timeout', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(captured())));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const instance = adapter({ trawl: new TrawlClient('http://127.0.0.1:8191', fetcher), browserExecutablePath: null, fetcher, env: {}, recorder });
    await expect(instance.track({ number: NUMBER }, { budgetMs: 10_000.5 })).resolves.toMatchObject({ current_stage: 'customs' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:8191/scrape');
    expect(JSON.parse(String(init?.body))).toMatchObject({ url: `https://www.yuntrack.com/parcelTracking?id=${NUMBER}`, skipHttp: true,
      maxTier: 2, captureResponses: [API], settleTimeout: 5_000 });
    expect(Number.isInteger(JSON.parse(String(init?.body)).maxTimeout)).toBe(true);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'trawl', outcome: 'ok' }));
  });

  it('does not fabricate a direct result when browser runtime is unavailable', async () => {
    await expect(new YunExpressTracker().fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('rejects unsupported input and pre-abort before contacting Trawl', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const tracker = new YunExpressTracker({ trawl: new TrawlClient('http://127.0.0.1:8191', fetcher) });
    await expect(tracker.fetch('bad&number')).rejects.toThrow(InvalidInputError);
    await expect(tracker.fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
