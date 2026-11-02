// @vitest-environment node
import { DateTime } from 'luxon';
import { readFileSync } from 'node:fs';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { carrierErrorKind } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/index.js';
import { adapter, parse17TrackResponse, SeventeenTrackTracker } from './adapter.js';

const number = 'ZZ12345678900';
const API = 'https://t.17track.net/track/restapi';
interface Payload { meta: { code: number }; shipments: Record<string, unknown>[] }
const delivered = JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8')) as Payload;
const history = (value = number): Payload => ({ ...delivered, shipments: [{ ...delivered.shipments[0], number: value }] });
const noHistory = (value = number): Payload => ({ meta: { code: 200 }, shipments: [{ number: value, code: 400, shipment: null }] });
const postalHistory = (events: Record<string, unknown>[], status = 'Expired'): Payload => ({
  meta: { code: 200 }, shipments: [{ number, code: 200, shipment: {
    latest_status: { status, sub_status: `${status}_Other` },
    tracking: { providers: [{ provider: { key: 3011, name: 'China Post' }, events }] },
  } }],
});
const postalScan = (sub_status: string, description = '邮件运输中') => ({
  time_iso: '2026-09-20T12:22:00+08:00', time_utc: '2026-09-20T04:22:00Z',
  time_raw: { date: '2026-09-20', time: '12:22:00', timezone: null }, description, stage: null, sub_status,
});
const thrown = (run: () => unknown): unknown => {
  try { run(); } catch (error) { return error; }
  return null;
};

const captured = (data: unknown, overrides: Record<string, unknown> = {}) => new Response(JSON.stringify({
  url: `https://t.17track.net/en#nums=${number}`, html: '<html></html>', statusCode: 200, tier: 3,
  capturedResponses: [{ url: API, body: JSON.stringify(data), status: 200, truncated: false, base64Encoded: false }],
  ...overrides,
}));

function tracker(fetcher: typeof fetch, trawlUrl = 'http://browser.test') {
  return new SeventeenTrackTracker({ trawl: new TrawlClient(trawlUrl, fetcher) });
}

describe('17TRACK result parsing', () => {
  it.each(['Not delivered to sender', 'Will be delivered back to sender', 'May have been delivered to the sender',
    "Wasn't delivered back to shipper", 'To be delivered to the shipper', 'Being delivered back to sender', 'Will not be delivered to sender'])(
    'does not complete sender delivery from %s without a provider status', description => {
      const result = parse17TrackResponse(postalHistory([postalScan('', description)]), number);
      expect(result).toMatchObject({ status: 'exception', current_stage: 'exception', events: [{ stage: 'exception' }] });
      expect(result.delivered_at).toBeUndefined();
    },
  );

  it.each(['Delivered back to sender', 'Delivered to the shipper', 'Has been delivered back to the sender',
    'The item was not delivered and has been returned to sender'])(
    'keeps affirmative completed sender delivery from %s without a provider status', description => {
      const result = parse17TrackResponse(postalHistory([postalScan('', description)]), number);
      expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', events: [{ stage: 'returned' }] });
    },
  );
  it('refines Swiss Post vehicle loading without reclassifying other operators or future wording', () => {
    const payload = postalHistory([postalScan('InTransit_Other', 'Loading into delivery vehicle')]);
    const shipment = payload.shipments[0]!.shipment as { tracking: { providers: Array<{ provider: { name: string }; events: unknown[] }> } };
    shipment.tracking.providers[0]!.provider = { name: 'Swiss Post' };
    expect(parse17TrackResponse(payload, number)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery',
      events: [{ stage: 'out_for_delivery', provider_code: 'InTransit_Other' }] });
    shipment.tracking.providers[0]!.provider = { name: 'Other postal operator' };
    expect(parse17TrackResponse(payload, number).current_stage).toBe('in_transit');
    shipment.tracking.providers[0]!.provider = { name: 'Swiss Post' };
    shipment.tracking.providers[0]!.events = [postalScan('InTransit_Other', 'Will be loaded into delivery vehicle')];
    expect(parse17TrackResponse(payload, number).current_stage).toBe('in_transit');
  });
  it("reads Swiss Post's Registered as the sender's data, and leaves other operators' to the shared rules", () => {
    const payload = postalHistory([postalScan('InTransit_Other', 'Registered')]);
    const shipment = payload.shipments[0]!.shipment as { tracking: { providers: Array<{ provider: { name: string }; events: unknown[] }> } };
    shipment.tracking.providers[0]!.provider = { name: 'Swiss Post' };
    expect(parse17TrackResponse(payload, number)).toMatchObject({ current_stage: 'registered',
      events: [{ stage: 'registered', provider_code: 'InTransit_Other' }] });
    shipment.tracking.providers[0]!.provider = { name: 'Ukrposhta' };
    expect(parse17TrackResponse(payload, number).current_stage).toBe('in_transit');
  });

  it('reads an order ready for the courier to collect as registered, not ready for the recipient', () => {
    const description = 'Order information has been received and ready for pickup';
    expect(parse17TrackResponse(postalHistory([postalScan('InTransit_Other', description)]), number)).toMatchObject({
      current_stage: 'registered', events: [{ stage: 'registered', provider_code: 'InTransit_Other' }] });
    expect(parse17TrackResponse(postalHistory([postalScan('AvailableForPickup_Other', 'Ready for pickup at the post office')]), number))
      .toMatchObject({ current_stage: 'ready_for_pickup' });
  });

  it('lets information received yield to a scan 17TRACK files under it', () => {
    expect(parse17TrackResponse(postalHistory([postalScan('InfoReceived', 'Objeto recebido na unidade de exportação no país de origem')]), number))
      .toMatchObject({ current_stage: 'in_transit', events: [{ stage: 'in_transit', provider_code: 'InfoReceived' }] });
    expect(parse17TrackResponse(postalHistory([postalScan('InfoReceived', 'Objeto postado')]), number))
      .toMatchObject({ current_stage: 'accepted', events: [{ stage: 'accepted', provider_code: 'InfoReceived' }] });
    // A notice keeps the code's stage, also where the shared rules read customs or movement in it.
    for (const description of ['Shipment information received', 'Order processed', 'Pre-advice received, customs declaration generated']) {
      expect(parse17TrackResponse(postalHistory([postalScan('InfoReceived', description)]), number))
        .toMatchObject({ current_stage: 'registered', events: [{ stage: 'registered', provider_code: 'InfoReceived' }] });
    }
  });

  it('reads an exact voided label as a problem despite the generic transit code', () => {
    const label = { ...postalScan('InfoReceived', 'Shipping Label Created'),
      time_iso: '2026-09-19T12:22:00+08:00', time_utc: '2026-09-19T04:22:00Z' };
    for (const description of ['Parcel Void', 'PARCEL VOIDED', 'Shipping label has been voided.']) {
      expect(parse17TrackResponse(postalHistory([postalScan('InTransit_Other', description), label]), number)).toMatchObject({
        status: 'exception', current_stage: 'exception', last_status_text: description,
        events: [{ stage: 'exception', provider_code: 'InTransit_Other' }, { stage: 'registered', provider_code: 'InfoReceived' }] });
    }
    // A relabel is a new label, not a cancelled shipment.
    expect(parse17TrackResponse(postalHistory([postalScan('InTransit_Other', 'Label voided, new label created')]), number))
      .toMatchObject({ status: 'pending', current_stage: 'registered' });
  });

  it.each(['Returning to sender', 'Return to sender', 'Will be returned to sender',
    'To be returned to the sender', 'Being returned to sender', 'Will soon be returned to sender',
    'Not yet returned to sender', 'Could not be returned to sender', 'Cannot be returned to sender',
    'Will not be returned to sender', "Hasn't been returned to sender", 'Hasn’t yet been returned to the sender',
    "Won't be returned to sender", "Wasn't returned to sender", 'May be returned to sender',
    'Should be returned to sender', 'Might have been returned to sender', 'Will have been returned to sender',
    'Could already have been returned to sender', 'Return initiated'])(
    'does not complete a return from generic transit and %s', description => {
      const result = parse17TrackResponse(postalHistory([postalScan('InTransit_Other', description)]), number);
      expect(result).toMatchObject({ status: 'exception', current_stage: 'exception' });
      expect(result.events?.[0]?.stage).toBe('exception');
      expect(result.delivered_at).toBeUndefined();
    },
  );

  it.each(['Returned to sender', 'Has been returned to the sender', 'Has already been returned to sender',
    'The item was not delivered and has been returned to sender'])(
    'preserves completed sender return from generic transit and %s', description => {
      const result = parse17TrackResponse(postalHistory([postalScan('InTransit_Other', description)]), number);
      expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', events: [{ stage: 'returned' }] });
    },
  );

  it.each([
    ['InTransit_TransportArrived', '飞机进港', 'in_transit', 'Plane has landed'],
    ['InTransit_Other', '航空公司接收', 'in_transit', 'Received by airline'],
    ['InTransit_PickedUp', '中国邮政已收取邮件', 'accepted', 'China Post has received the mail'],
    ['InTransit_CustomsProcessing', '送交出口海关', 'customs', 'Presented to export customs'],
    ['InTransit_CustomsReleased', '出口海关/放行', 'in_transit', 'Export customs release'],
    ['InTransit_Other', 'Export customs/release [Example City]', 'in_transit', 'Export customs/release [Example City]'],
    ['InTransit_CustomsRequiringInformation', '等待清关资料', 'customs', '等待清关资料'],
    ['Exception_Delayed', '运输延误', 'exception', '运输延误'],
    ['Exception_Returning', '退回中', 'exception', '退回中'],
    ['Exception_Returned', '已退回', 'returned', 'Returned'],
    ['OutForDelivery_Other', '正在投递', 'out_for_delivery', '正在投递'],
    ['Delivered_Other', '已妥投', 'delivered', 'Delivered'],
  ])('uses %s with a null stage independently of scan language', (code, description, stage, shown) => {
    const result = parse17TrackResponse(postalHistory([postalScan(code, description)]), number);
    expect(result.current_stage).toBe(stage);
    expect(result.events?.[0]).toMatchObject({ stage, provider_code: code,
      reporting_carrier: 'China Post', reporting_carrier_key: 3011,
      time_provenance: 'provider_inferred', provider_time_iso: '2026-09-20T12:22:00+08:00' });
    // China Post's labels show in English where it is known; others keep their Chinese.
    expect(result.events?.[0]?.description).toBe(shown);
  });

  it('credits the stage a code gives to the map, beside a stage name the wording rules do not read', () => {
    const result = parse17TrackResponse(postalHistory([{ ...postalScan('InTransit_PickedUp', '中国邮政已收取邮件'), stage: 'PickedUp' }]), number);
    expect(result.events?.[0]).toMatchObject({ stage: 'accepted', stage_source: 'carrier_map' });
  });

  it("reads the place China Post's feed gives after a status, and no place for a status alone", () => {
    const located = (location: string) => parse17TrackResponse(
      postalHistory([{ ...postalScan('InTransit_Other', 'In transit'), location }]), number).events?.[0]?.location;
    expect(located('Departure from【深圳】')).toBe('深圳');
    expect(located('Received by Carrier 【深圳】')).toBe('深圳');
    expect(located('In Transit【深圳】, 快件在该国内转运中')).toBe('深圳');
    expect(located('Arriyal at Processing Center【Example City 99999】')).toBe('Example City 99999');
    expect(located('Dispatching【Example City X9X9X9】')).toBe('Example City');
    expect(located('Arrival at【US】')).toBe('US');
    expect(located('Arrival at Example Land Airport')).toBe('Example Land');
    // "Destination country", given an arrival in place of a country's code, names no place.
    for (const status of ['Departure from Airport', 'Arrival at Destination Airport', 'Export Customs Clearance Completed',
      'Out For Delivery', 'In Transit', '99999 DELIVERED', '9999 PA DELIVERED', 'Delivered【99/999】', 'Departure from Processing Center【Example Ci',
      '目的国', 'Arrival at【目的国】', '--']) {
      expect(located(status), status).toBeUndefined();
    }
    for (const location of ['Example Transit Hub', 'Arrival Hall, Example City', 'EXAMPLE CITY, CA 99999', 'Example City 99999999']) expect(located(location)).toBe(location);
    // China Post's office code after a town goes.
    expect(located('示例市 99999999')).toBe('示例市');
  });

  it("shows China Post's labels in English, a partner's scan abroad too, with the place as the location", () => {
    const shown = (code: string, description: string, location: string | null = null) => parse17TrackResponse(
      postalHistory([{ ...postalScan(code, description), location }]), number).events?.[0];
    expect(shown('OutForDelivery_Other', '出门投递【ZZ Dispatching【Example Ci】', 'Dispatching【Example City X9X9X9】'))
      .toMatchObject({ description: 'Out for delivery', location: 'Example City', stage: 'out_for_delivery' });
    expect(shown('InTransit_Other', '邮件到达处理中心【ZZ Arriyal at Processin】', 'Arriyal at Processing Center【Example City】'))
      .toMatchObject({ description: 'Arrival at processing center', location: 'Example City', stage: 'in_transit' });
    expect(shown('InTransit_Other', '邮件离开【示例市国际营业部】，正在发往【示例中心】', '示例市 00000000'))
      .toMatchObject({ description: 'Departed for the next office', location: '示例市', stage: 'in_transit' });
    expect(shown('InTransit_CustomsReleased', '出口清关完成【Customs Clearance Completed【示例市】】', 'Customs Clearance Completed【示例市】'))
      .toMatchObject({ description: 'Export customs clearance completed', location: '示例市', stage: 'in_transit' });
    expect(shown('InTransit_Other', '承运商接收')).toMatchObject({ description: 'Received by carrier', stage: 'in_transit' });
    // The estimate of the next arrival keeps its date, and the place it is at.
    expect(shown('InTransit_Other', '预计【01月02日】到达【示例市】，两地距离1000km，将在【01月02日上午】更新邮件状态，请您放心。', '示例市 00000000'))
      .toMatchObject({ description: 'Expected to arrive at the next stop on January 2', location: '示例市', stage: 'in_transit' });
    // A state label with a name in 【】 and no location: the name becomes the location, unless it names no place.
    expect(shown('InTransit_Other', '启运【示例】')).toMatchObject({ description: 'Departure', location: '示例', stage: 'in_transit' });
    expect(shown('InTransit_Other', '启运【Example Hub】', 'EXH')).toMatchObject({ description: 'Departure', location: 'EXH' });
    expect(shown('InTransit_Other', '启运【目的国】')).not.toHaveProperty('location');
    // A partner's scan abroad at a location that names no place is in the country its label gives before its English.
    expect(shown('InTransit_Other', '邮件离开处理中心【FR Departure from Proc】', 'Departure from Processing Center【99/999】'))
      .toMatchObject({ description: 'Departure from processing center', location: 'FR' });
    expect(shown('InTransit_Other', '邮件离开处理中心【ZZ Departure from Proc】', 'Departure from Processing Center【99/999】'))
      .not.toHaveProperty('location');
    // A label without known English keeps China Post's wording.
    expect(shown('InTransit_Other', '邮件运输中')).toMatchObject({ description: '邮件运输中', stage: 'in_transit' });
    // Another carrier's leg keeps its own wording.
    const other = parse17TrackResponse({ ...postalHistory([]), shipments: [{ number, code: 200, shipment: {
      latest_status: { status: 'InTransit' },
      tracking: { providers: [{ provider: { key: 190000, name: 'Example Forwarder' }, events: [postalScan('InTransit_Other', '承运商接收')] }] },
    } }] }, number);
    expect(other.events?.[0]?.description).toBe('承运商接收');
    // JHGJ's leg relays China Post's labels, its place after them in 【】 and an express item's (快件) wording.
    const relayed = parse17TrackResponse({ ...postalHistory([]), shipments: [{ number, code: 200, shipment: {
      latest_status: { status: 'InTransit' },
      tracking: { providers: [{ provider: { key: 192049, name: 'JHGJ' }, events: [
        postalScan('InTransit_Other', '启运【Example Airport】'), postalScan('InTransit_Other', '快件到达处理中心【Example City】'),
        postalScan('InTransit_Other', '邮件已完成分拣，准备发出【示例市】'), postalScan('InTransit_PickedUp', '示例处理中心已收寄【示例市】'),
        postalScan('InTransit_Other', '邮件运输中【示例市】'),
      ] }] },
    } }] }, number);
    expect(relayed.events?.map((event) => [event.description, event.location])).toEqual([
      ['Departure', 'Example Airport'], ['Arrival at processing center', 'Example City'], ['Sorted and ready to leave', '示例市'],
      ['Accepted', '示例市'], ['邮件运输中【示例市】', undefined],
    ]);
  });

  it('takes the place Pengyou writes in brackets after its wording for the location', () => {
    const leg = (key: number, ...events: object[]) => parse17TrackResponse({ ...postalHistory([]), shipments: [{ number, code: 200, shipment: {
      latest_status: { status: 'InTransit' },
      tracking: { providers: [{ provider: { key, name: 'Example' }, events }] },
    } }] }, number).events?.map((event) => [event.description, event.location]);
    expect(leg(191878,
      postalScan('InTransit_Other', 'Example Processing Center has received it [Example City]'),
      postalScan('InTransit_Other', 'Export customs/release [Example City]'),
      postalScan('InTransit_Other', 'Airline received【Example Port】'),
      postalScan('InTransit_Other', 'Departure【Example International Airport】'),
      postalScan('InTransit_Other', 'Arrive at Airport'),
      postalScan('InTransit_Other', 'Arrive at Airport [--]'),
      { ...postalScan('InTransit_Other', 'Departure【Example Port】'), location: 'EXP' },
    )).toEqual([
      ['Example Processing Center has received it', 'Example City'], ['Export customs/release', 'Example City'],
      ['Airline received', 'Example Port'], ['Departure', 'Example International Airport'],
      ['Arrive at Airport', undefined], ['Arrive at Airport [--]', undefined], ['Departure【Example Port】', 'EXP'],
    ]);
    // Another leg keeps its wording whole.
    expect(leg(190000, postalScan('InTransit_Other', 'Airline received【Example Port】')))
      .toEqual([['Airline received【Example Port】', undefined]]);
  });

  it("reads JCEX's places 17TRACK gives with their row's offset, without the offset or a postcode", () => {
    const located = (location: string) => parse17TrackResponse({ ...postalHistory([]), shipments: [{ number, code: 200, shipment: {
      latest_status: { status: 'InTransit' },
      tracking: { providers: [{ provider: { key: 190120, name: 'JCEX' }, events: [{ ...postalScan('InTransit_Other', 'In transit'), location }] }] },
    } }] }, number).events?.[0]?.location;
    expect(located('Example Town;CA;;-07:00')).toBe('Example Town, CA');
    expect(located('Example Town;CA;99999;-07:00')).toBe('Example Town, CA');
    // Or as a town, its state and country, then the postcode.
    expect(located('Example Town,CA,US,99999')).toBe('Example Town,CA,US');
    expect(located('Example Town,CA,US')).toBe('Example Town,CA,US');
    // The destination JCEX files a row under is no place under a clock it never keeps: a row in China at +08:00.
    expect(located('US-07:00')).toBe('US');
    expect(located('US+08:00')).toBeUndefined();
    expect(located('The carrier')).toBeUndefined();
  });

  it("reads China Post's US places 17TRACK relays as the facility's town and state", () => {
    const located = (location: string) => parse17TrackResponse(postalHistory([{ ...postalScan('InTransit_Other', 'In transit'), location }]), number)
      .events?.[0]?.location;
    expect(located('Example Town, NC, Example Town 99999')).toBe('Example Town, NC');
    // The town before the ZIP code can be another's.
    expect(located('Example Town, NC, Sample City 99999')).toBe('Example Town, NC');
    expect(located('Example Town, NC 99999')).toBe('Example Town, NC 99999');
    // Only a US state's code.
    expect(located('Example Town, ZZ, Example Town 99999')).toBe('Example Town, ZZ, Example Town 99999');
  });

  it('does not convert stale tracking or unknown codes into shipment progress', () => {
    expect(parse17TrackResponse(postalHistory([postalScan('Future_Unknown')]), number).current_stage).toBe('pending');
    expect(parse17TrackResponse(postalHistory([postalScan('InTransit_Other')]), number).status).toBe('in_transit');
    expect(parse17TrackResponse(postalHistory([postalScan('Delivered_Other', 'Not delivered')]), number).current_stage).toBe('failed_attempt');
    expect(parse17TrackResponse(postalHistory([postalScan('Delivered_Other', 'Delivered to local carrier')]), number).current_stage).toBe('in_transit');
    expect(parse17TrackResponse(postalHistory([postalScan('InTransit_Other', 'Returned to sender')]), number).current_stage).toBe('returned');
  });

  it('keeps dated history when explanatory rows have no dates, without inventing timestamps', () => {
    const result = parse17TrackResponse(postalHistory([
      { ...postalScan('InTransit_Other'), time_iso: null, time_utc: null, time_raw: { date: null, time: null, timezone: null } },
      { ...postalScan('Delivered_Other', 'Delivered'), time_raw: { timezone: '+08:00' } },
    ]), number);
    expect(result).toMatchObject({ current_stage: 'delivered', undated_event_count: 1 });
    expect(result.events).toHaveLength(1);
    expect(result.events?.[0]?.time_provenance).toBe('carrier_reported');
    expect(() => parse17TrackResponse(postalHistory([{ ...postalScan('InTransit_Other'), time_utc: 'broken' }]), number))
      .toThrow('invalid tracking event');
  });

  it('keeps the day of a row the carrier dates by its day alone, on any leg, instead of a midnight', () => {
    const reply = (key: number, name: string, events: Record<string, unknown>[]): Payload => ({ meta: { code: 200 }, shipments: [{ number, code: 200,
      shipment: { latest_status: { status: 'InTransit' }, tracking: { providers: [{ provider: { key, name }, events }] } } }] });
    const created = (time: string | null, timezone: string | null, sub_status = 'InfoReceived', description = 'Creation date') => ({
      time_iso: '2026-10-26T00:00:00+01:00', time_utc: '2026-10-25T23:00:00Z', time_raw: { date: '2026-10-26', time, timezone },
      description, location: null, stage: null, sub_status });
    // Swiss Post's creation date: a raw clock with no time, or information received at midnight.
    for (const row of [created(null, '+01:00'), created('', '+01:00'), created('00:00:00', '+01:00'), created(null, null, 'InTransit_Other', 'Sorted')]) {
      const [event] = parse17TrackResponse(reply(19251, 'Swiss Post', [row]), number).events ?? [];
      expect(event).toMatchObject({ local_time: '2026-10-26', provider_time_iso: '2026-10-26T00:00:00+01:00' });
      expect(event?.time).toBeUndefined();
    }
    // GLS Italy's "created by the sender", which its own page dates by its day, under an offset 17TRACK adds.
    const gls = parse17TrackResponse(reply(100024, 'GLS (IT)', [created('00:00:00', null, 'InfoReceived',
      'La spedizione e\' stata creata dal mittente, attendiamo che ci venga affidata.')]), number);
    expect(gls.events?.map((event) => event.time ?? event.local_time)).toEqual(['2026-10-26']);
    // A scan at midnight, and information received at another time, keep their clock.
    expect(parse17TrackResponse(reply(19251, 'Swiss Post', [created('00:00:00', '+01:00', 'InTransit_Other', 'Sorted')]), number)
      .events?.[0]?.time).toBe('2026-10-25T23:00:00.000Z');
    expect(parse17TrackResponse(reply(19251, 'Swiss Post', [{ ...created('00:00:01', '+01:00'), time_iso: '2026-10-26T00:00:01+01:00',
      time_utc: '2026-10-25T23:00:01Z' }]), number).events?.[0]?.time).toBe('2026-10-25T23:00:01.000Z');
  });

  it('counts a scan 17TRACK dates with a placeholder because its raw clock has no date', () => {
    const placeholder = { ...postalScan('OutForDelivery_Other', 'Parcel out for delivery'), time_iso: '01.01.2000, 00:00', time_utc: null,
      time_raw: { date: null, time: null, timezone: null } };
    const result = parse17TrackResponse(postalHistory([postalScan('Delivered_Other', 'Parcel delivered'), placeholder, placeholder]), number);
    expect(result).toMatchObject({ current_stage: 'delivered', undated_event_count: 2 });
    expect(result.events).toHaveLength(1);
    // A placeholder beside a raw date is not one 17TRACK left undated.
    expect(() => parse17TrackResponse(postalHistory([{ ...placeholder, time_raw: { date: '2026-09-20', time: null, timezone: null } }]), number))
      .toThrow('invalid tracking event');
  });

  it('reads DHL Express scans on their facility\'s clock, not on the one offset 17TRACK gives the parcel', () => {
    // Public shape: every scan stamped with the destination's offset, the facility's clock in time_raw.
    const scan = (date: string, time: string, location: string, description = 'Processed') => ({
      time_iso: `${date}T${time}+02:00`, time_utc: `${date}T${time}Z`, time_raw: { date, time, timezone: null },
      description, location, stage: null, sub_status: 'InTransit_Other' });
    const reply = (events: Record<string, unknown>[], name = 'DHL Express'): Payload => ({ meta: { code: 200 }, shipments: [{ number, code: 200,
      shipment: { latest_status: { status: 'InTransit' }, tracking: { providers: [{ provider: { key: 100001, name }, events }] } } }] });
    const result = parse17TrackResponse(reply([
      scan('2026-10-05', '09:13:00', 'EXAMPLE CITY - ITALY'),
      scan('2026-10-04', '17:34:00', 'EXAMPLE CITY - HONG KONG SAR, CHINA'),
      scan('2026-10-04', '11:13:00', 'EXAMPLE CITY - CHINA, PEOPLES REPUBLIC'),
      scan('2026-10-04', '09:20:00', 'EXAMPLE CITY - THE PEOPLE\'S REPUBLIC OF CHINA'),
      scan('2026-10-03', '18:00:00', 'EXAMPLE CITY - EXAMPLELAND'),
    ]), number);
    expect(result.events?.map((event) => event.time)).toEqual([
      '2026-10-05T07:13:00.000Z', '2026-10-04T09:34:00.000Z', '2026-10-04T03:13:00.000Z', '2026-10-04T01:20:00.000Z']);
    // The provider's own reading stays on the scan; a facility it cannot place is counted, not dated.
    expect(result.undated_event_count).toBe(1);
    expect(result.events?.[0]).toMatchObject({ provider_time_iso: '2026-10-05T09:13:00+02:00', time_provenance: 'provider_inferred' });
    // Unplaced as the latest scan, the reply cannot say where the parcel is.
    expect(carrierErrorKind(thrown(() => parse17TrackResponse(reply([
      scan('2026-10-05', '09:13:00', 'EXAMPLE CITY - EXAMPLELAND'), scan('2026-10-04', '09:20:00', 'EXAMPLE CITY - ITALY'),
    ]), number)))).toBe('indeterminate');
    // Another carrier's scans keep 17TRACK's reading: the clock and offset it shows.
    expect(parse17TrackResponse(reply([scan('2026-10-04', '17:34:00', 'EXAMPLE CITY - HONG KONG SAR, CHINA')], 'Example Parcel Co'), number)
      .events?.[0]?.time).toBe('2026-10-04T15:34:00.000Z');
  });

  it('reads Asendia USA\'s offset-less clock as the UTC A1 dates its scans in, not as US Eastern time', () => {
    const scan = (key: number) => ({ meta: { code: 200 }, shipments: [{ number, code: 200,
      shipment: { latest_status: { status: 'InTransit' }, tracking: { providers: [{ provider: { key, name: 'Asendia USA' }, events: [{
        time_iso: '2026-05-07T16:20:00-04:00', time_utc: '2026-05-07T20:20:00Z', time_raw: { date: '2026-05-07', time: '16:20:00', timezone: null },
        description: 'Arrived at destination', location: 'EXAMPLE CITY, Switzerland', stage: null, sub_status: 'InTransit_Other' }] }] } } }] });
    expect(parse17TrackResponse(scan(100016), number).events?.[0]).toMatchObject({ time: '2026-05-07T16:20:00.000Z',
      provider_time_iso: '2026-05-07T16:20:00-04:00', time_provenance: 'provider_inferred' });
    // Another feed of the same name keeps 17TRACK's reading.
    expect(parse17TrackResponse(scan(100999), number).events?.[0]?.time).toBe('2026-05-07T20:20:00.000Z');
  });

  it('reads Shiprocket\'s rows in India on India\'s clock, not as US Eastern time, and others as wall times', () => {
    const row = (time: string, location: string | null, timezone: string | null = null) => ({
      time_iso: `2026-05-07T${time}${timezone ?? '-04:00'}`, time_utc: null, time_raw: { date: '2026-05-07', time, timezone },
      description: 'In Transit - Trip Arrived', location, stage: null, sub_status: 'InTransit_Other' });
    const reply = (key: number, events: unknown[]) => ({ meta: { code: 200 }, shipments: [{ number, code: 200,
      shipment: { latest_status: { status: 'InTransit' }, tracking: { providers: [{ provider: { key, name: 'Shiprocket' }, events }] } } }] });
    const parsed = parse17TrackResponse(reply(100662, [row('18:10:00', 'EXAMPLE CITY'), row('16:22:51', 'Example_Hub_D (Delhi)'),
      row('12:46:17', 'Example_Hub (Haryana)'), row('10:16:04', null), row('09:00:00', 'Example_Hub (Delhi)', '+05:30')]), number);
    expect(parsed.events?.map((event) => event.time ?? event.local_time).sort()).toEqual(['2026-05-07T03:30:00.000Z',
      '2026-05-07T07:16:17.000Z', '2026-05-07T10:16:04', '2026-05-07T10:52:51.000Z', '2026-05-07T18:10:00']);
    expect(parsed.events?.find((event) => event.location?.includes('Hub_D'))).toMatchObject({ time: '2026-05-07T10:52:51.000Z',
      provider_time_iso: '2026-05-07T16:22:51-04:00', time_provenance: 'provider_inferred' });
    expect(parsed.undated_event_count).toBeUndefined();
    // Another feed of the same name keeps 17TRACK's reading.
    expect(parse17TrackResponse(reply(100999, [row('16:22:51', 'Example_Hub_D (Delhi)')]), number).events?.[0]?.time)
      .toBe('2026-05-07T20:22:51.000Z');
  });

  it('reads Quick Rabbit\'s rows on Madrid\'s clock, not under the -04:00 17TRACK adds', () => {
    const row = (date: string, time: string, timezone: string | null = null) => ({
      time_iso: `${date}T${time}${timezone ?? '-04:00'}`, time_utc: null, time_raw: { date, time, timezone },
      description: 'Delivered', location: null, stage: null, sub_status: 'Delivered_Other' });
    const reply = (key: number, events: unknown[]) => ({ meta: { code: 200 }, shipments: [{ number, code: 200,
      shipment: { latest_status: { status: 'Delivered' }, tracking: { providers: [{ provider: { key, name: 'QUICK RABBIT' }, events }] } } }] });
    const parsed = parse17TrackResponse(reply(101309, [row('2026-10-25', '23:07:00'), row('2026-10-23', '01:11:36')]), number);
    expect(parsed.events?.map((event) => event.time)).toEqual(['2026-10-25T22:07:00.000Z', '2026-10-22T23:11:36.000Z']);
    expect(parsed.events?.[0]).toMatchObject({ provider_time_iso: '2026-10-25T23:07:00-04:00', time_provenance: 'provider_inferred' });
    // Another feed keeps 17TRACK's reading.
    expect(parse17TrackResponse(reply(100999, [row('2026-10-25', '23:07:00')]), number).events?.[0]?.time).toBe('2026-10-26T03:07:00.000Z');
  });

  it('reads CTT\'s rows at a CTT Express agency, and the acceptance as it takes the parcel in, on Madrid\'s clock', () => {
    const row = (date: string, time: string, description: string, location: string | null) => ({
      time_iso: `${date}T${time}+00:00`, time_utc: null, time_raw: { date, time, timezone: null },
      description, location, stage: null, sub_status: 'InTransit_Other' });
    const reply = (key: number, events: unknown[]) => ({ meta: { code: 200 }, shipments: [{ number, code: 200,
      shipment: { latest_status: { status: 'InTransit' }, shipping_info: { shipper_address: { country: 'ES' }, recipient_address: { country: 'PT' } },
        tracking: { providers: [{ provider: { key, name: 'CTT', country: 'PT' }, events }] } } }] });
    const times = (key: number, events: unknown[]) => parse17TrackResponse(reply(key, events), number).events?.map((event) => event.time);
    expect(times(16101, [row('2026-10-28', '03:17:09', 'Em trânsito, Chegou ao centro operacional', 'C.O. EXAMPLE'),
      row('2026-10-27', '11:00:05', 'Em trânsito, Chegou ao centro operacional', '009999 - (PL) EXAMPLE AGENCY'),
      row('2026-10-27', '11:00:04', 'Aceite, O envio foi aceite. O processo de envio foi iniciado', null),
      row('2026-10-27', '09:13:40', 'Informação recebida, A informação sobre o envio foi recebida.', null)]))
      .toEqual(['2026-10-28T03:17:09.000Z', '2026-10-27T10:00:05.000Z', '2026-10-27T10:00:04.000Z', '2026-10-27T09:13:40.000Z']);
    // In summer too, where 17TRACK labels the row with the offset Portugal keeps on the day it looks.
    expect(times(16101, [row('2026-10-22', '16:27:53', 'Em trânsito, Chegou ao centro operacional', '009999 - (PL) EXAMPLE AGENCY'),
      row('2026-10-22', '16:27:52', 'Aceite, O envio foi aceite. O processo de envio foi iniciado', null)]))
      .toEqual(['2026-10-22T14:27:53.000Z', '2026-10-22T14:27:52.000Z']);
    // Another feed keeps 17TRACK's reading.
    expect(times(100999, [row('2026-10-27', '11:00:05', 'In transit', '009999 - (PL) EXAMPLE AGENCY')])).toEqual(['2026-10-27T11:00:05.000Z']);
  });

  it('reads Huiyi Logistics\' rows in China on Beijing\'s clock, not as their "+00:00", and keeps the others\' wall clocks', () => {
    const row = (time: string, location: string) => ({
      time_iso: `2026-05-07T${time}+00:00`, time_utc: `2026-05-07T${time}Z`, time_raw: { date: '2026-05-07', time, timezone: '+00:00' },
      description: 'In Transit', location, stage: null, sub_status: 'InTransit_Other' });
    const reply = (key: number, events: unknown[]) => ({ meta: { code: 200 }, shipments: [{ number, code: 200,
      shipment: { latest_status: { status: 'InTransit' }, tracking: { providers: [{ provider: { key, name: 'HYWL' }, events }] } } }] });
    const parsed = parse17TrackResponse(reply(192109, [row('22:43:31', 'Example Town, 00000'), row('19:43:31', 'Hong Kong International Hub'),
      row('15:51:00', 'Shenzhen 00000000'), row('10:43:31', '深圳')]), number);
    expect(parsed.events?.map((event) => event.time)).toEqual([undefined, '2026-05-07T11:43:31.000Z',
      '2026-05-07T07:51:00.000Z', '2026-05-07T02:43:31.000Z']);
    expect(parsed.events?.[0]?.local_time).toBe('2026-05-07T22:43:31');
    expect(parsed.undated_event_count).toBeUndefined();
    // Another feed keeps 17TRACK's reading.
    expect(parse17TrackResponse(reply(100999, [row('15:51:00', 'Shenzhen')]), number).events?.[0]?.time).toBe('2026-05-07T15:51:00.000Z');
  });

  it('reads DAI Post\'s scans on their country\'s clock, not on the one offset 17TRACK gives the parcel', () => {
    // Public shape: every scan stamped with one offset, the scan's local clock in time_raw, its town and country code.
    const row = (date: string, time: string, location: string, description = 'Parcel arrived in trans-shipment country.') => ({
      time_iso: `${date}T${time}+01:00`, time_utc: null, time_raw: { date, time, timezone: null },
      description, location, stage: null, sub_status: 'InTransit_Other' });
    const reply = (key: number, events: unknown[]): Payload => ({ meta: { code: 200 }, shipments: [{ number, code: 200,
      shipment: { latest_status: { status: 'InTransit' }, tracking: { providers: [{ provider: { key, name: 'DAI Post', country: 'AU' }, events }] } } }] });
    const parsed = parse17TrackResponse(reply(100790, [
      row('2026-10-10', '10:19:06', 'Example Town, SG'),
      row('2026-10-09', '23:40:00', 'Example Town, NZ'),
      row('2026-10-08', '21:19:03', 'Example Town, GB', 'Your parcel is in the air and is heading your way.'),
      row('2026-10-07', '18:00:00', 'Example Town, GB', 'We’ve received your delivery details. We’ll let you know as soon as your parcel is in our hands.'),
    ]), number);
    expect(parsed.events?.map((event) => event.time)).toEqual([
      '2026-10-10T02:19:06.000Z', '2026-10-09T10:40:00.000Z', '2026-10-08T20:19:03.000Z']);
    expect(parsed.events?.[0]).toMatchObject({ provider_time_iso: '2026-10-10T10:19:06+01:00', time_provenance: 'provider_inferred' });
    // The label data's clock is no hub's, so it is counted, not dated.
    expect(parsed.undated_event_count).toBe(1);
    // A latest scan in Australia, on one of several clocks, leaves the reply unable to say where the parcel is.
    const error = thrown(() => parse17TrackResponse(reply(100790, [
      row('2026-10-11', '15:06:00', 'Example Town, Brisbane, AU'), row('2026-10-10', '10:19:06', 'Example Town, SG')]), number));
    expect(carrierErrorKind(error)).toBe('indeterminate');
    expect(String(error)).toContain('cannot place the latest DAI Post scan');
    // Another feed keeps 17TRACK's reading.
    expect(parse17TrackResponse(reply(100999, [row('2026-10-11', '15:06:00', 'Example Town, Brisbane, AU')]), number).events?.[0]?.time)
      .toBe('2026-10-11T14:06:00.000Z');
  });

  it('reads USPS\'s scans in their state\'s zone, not on the offset 17TRACK guesses for it', () => {
    // Public shape: USPS's wall clock in time_raw with no zone, and the offset 17TRACK guessed from the state.
    const row = (date: string, time: string, offset: string, location: string | null, description = 'Arrived at USPS Regional Facility') => {
      const at = DateTime.fromISO(`${date}T${time}${offset}`, { setZone: true });
      return { time_iso: at.toISO({ suppressMilliseconds: true }), time_utc: at.toUTC().toISO({ suppressMilliseconds: true }),
        time_raw: { date, time, timezone: null }, description, location, stage: null, sub_status: 'InTransit_Other' };
    };
    const reply = (key: number, events: unknown[], name = 'USPS', country = 'US'): Payload => ({ meta: { code: 200 }, shipments: [{ number, code: 200,
      shipment: { latest_status: { status: 'InTransit' }, tracking: { providers: [{ provider: { key, name, country }, events }] } } }] });
    const indiana = row('2026-05-07', '20:16:00', '-05:00', 'EXAMPLE CITY IN DISTRIBUTION CENTER');
    const parsed = parse17TrackResponse(reply(21051, [
      row('2026-05-08', '09:00:00', '-05:00', null, 'In Transit to Next Facility'),
      indiana,
      row('2026-05-06', '16:35:00', '-07:00', 'EXAMPLE CITY AZ DISTRIBUTION CENTER'),
      row('2026-05-06', '15:20:00', '-07:00', 'EXAMPLE CITY, AZ 00000', 'Accepted at USPS Origin Facility'),
    ]), number);
    // Indiana keeps Eastern time; a row with no place keeps USPS's wall clock, as USPS's adapter gives it.
    expect(parsed.events?.map((event) => event.time ?? event.local_time)).toEqual([
      '2026-05-08T09:00:00', '2026-05-08T00:16:00.000Z', '2026-05-06T23:35:00.000Z', '2026-05-06T22:20:00.000Z']);
    expect(parsed.events?.[0]).toMatchObject({ provider_time_iso: '2026-05-08T09:00:00-05:00' });
    expect(parsed.events?.[0]?.time).toBeUndefined();
    // So does a row placed in the country alone.
    const country = parse17TrackResponse(reply(21051, [row('2026-05-08', '09:00:00', '-06:00', 'US')]), number).events?.[0];
    expect(country).toMatchObject({ local_time: '2026-05-08T09:00:00', provider_time_iso: '2026-05-08T09:00:00-06:00' });
    expect(country?.time).toBeUndefined();
    // A place that names no state keeps 17TRACK's reading.
    expect(parse17TrackResponse(reply(21051, [row('2026-05-08', '09:00:00', '-05:00', 'EXAMPLE FACILITY')]), number).events?.[0]?.time)
      .toBe('2026-05-08T14:00:00.000Z');
    expect(parsed.events?.[1]).toMatchObject({ provider_time_iso: '2026-05-07T20:16:00-05:00', time_provenance: 'provider_inferred' });
    expect(parsed.undated_event_count).toBeUndefined();
    // Another feed keeps 17TRACK's reading.
    expect(parse17TrackResponse(reply(100999, [indiana]), number).events?.[0]?.time).toBe('2026-05-08T01:16:00.000Z');
    // A row to the second that names USPS's zone keeps it, wherever the place is.
    const zoned = { ...row('2026-05-07', '20:16:09', '-04:00', 'US'), time_raw: { date: '2026-05-07', time: '20:16:09', timezone: '-04:00' } };
    expect(parse17TrackResponse(reply(21051, [zoned]), number).events?.[0])
      .toMatchObject({ time: '2026-05-08T00:16:09.000Z', time_provenance: 'carrier_reported' });
    // A place that gives only its ZIP code is read in that ZIP code's state.
    expect(parse17TrackResponse(reply(21051, [row('2026-05-06', '14:03:00', '-05:00', '94000')]), number).events?.[0]?.time)
      .toBe('2026-05-06T21:03:00.000Z');
    // A step USPS dates by its day alone keeps its day, whether 17TRACK writes no clock or midnight.
    const printed = row('2026-05-06', '00:00:00', '-04:00', 'EXAMPLE CITY, NY 00000', 'Shipping Label Printed at Post Office');
    for (const label of [printed, { ...printed, time_raw: { date: '2026-05-06', time: null, timezone: null } }]) {
      const [event] = parse17TrackResponse(reply(21051, [label]), number).events ?? [];
      expect(event).toMatchObject({ description: 'Shipping Label Printed at Post Office', local_time: '2026-05-06',
        provider_time_iso: '2026-05-06T00:00:00-04:00' });
      expect(event?.time).toBeUndefined();
    }
    // Another feed's midnight is its own.
    expect(parse17TrackResponse(reply(100999, [printed]), number).events?.[0]?.time).toBe('2026-05-06T04:00:00.000Z');
    // BRT's delivery round, which its page dates by its day alone, keeps its day; its other scans their clock.
    const round = row('2026-10-22', '00:00:00', '+02:00', 'EXAMPLE CITY (000)', 'FOR DELIVERY');
    const brt = parse17TrackResponse(reply(199997, [round, row('2026-10-22', '00:00:00', '+02:00', 'EXAMPLE CITY (000)', 'DEPARTED')], 'BRT (IT)', 'IT'), number);
    expect(brt.events?.map((event) => event.time ?? event.local_time)).toEqual(['2026-10-22', '2026-10-21T22:00:00.000Z']);
  });

  it('leaves out the EN ROUTE row DHL eCommerce US stamps with each request', () => {
    const row = (time: string, description: string, location: string | null) => ({ time_iso: `2026-10-29T${time}-04:00`, time_utc: null,
      time_raw: { date: '2026-10-29', time, timezone: '-04:00' }, description, location, stage: null, sub_status: 'InTransit_Other' });
    const reply = (key: number, events: unknown[]): Payload => ({ meta: { code: 200 }, shipments: [{ number, code: 200,
      shipment: { latest_status: { status: 'InTransit' }, tracking: { providers: [{ provider: { key, name: 'DHL eCommerce US', country: 'US' }, events }] } } }] });
    const rows = [row('07:31:46', 'EN ROUTE', null), row('06:10:00', 'EN ROUTE', 'EXAMPLE CITY, US'), row('05:00:00', 'PROCESSED', null)];
    expect(parse17TrackResponse(reply(7047, rows), number).events?.map((event) => event.description)).toEqual(['EN ROUTE', 'PROCESSED']);
    // Another feed's EN ROUTE stays.
    expect(parse17TrackResponse(reply(100999, rows), number).events).toHaveLength(3);
  });

  it('reads Correos de Chile\'s scans on Santiago\'s clock, in summer time too', () => {
    // Public shape: Correos de Chile's wall clock in time_raw with no zone, under 17TRACK's -04:00.
    const row = (date: string, time: string, location: string | null) => ({ time_iso: `${date}T${time}-04:00`, time_utc: null,
      time_raw: { date, time, timezone: null }, description: 'En tránsito', location, stage: null, sub_status: 'InTransit_Other' });
    const reply = (key: number, events: unknown[]): Payload => ({ meta: { code: 200 }, shipments: [{ number, code: 200,
      shipment: { latest_status: { status: 'InTransit' }, tracking: { providers: [{ provider: { key, name: 'Correos Chile', country: 'CL' }, events }] } } }] });
    const parsed = parse17TrackResponse(reply(3101, [row('2026-09-11', '10:43:00', 'EXAMPLE TOWN'), row('2026-06-02', '09:15:00', null)]), number);
    expect(parsed.events?.map((event) => event.time)).toEqual(['2026-09-11T13:43:00.000Z', '2026-06-02T13:15:00.000Z']);
    expect(parsed.events?.[0]).toMatchObject({ provider_time_iso: '2026-09-11T10:43:00-04:00', time_provenance: 'provider_inferred' });
    // Another feed keeps 17TRACK's reading.
    expect(parse17TrackResponse(reply(100999, [row('2026-09-11', '10:43:00', null)]), number).events?.[0]?.time).toBe('2026-09-11T14:43:00.000Z');
  });

  it('reads Poland Post\'s clock at the scan\'s own date, and a partner\'s scan after the departure on the recipient\'s', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-25T09:00:00Z') });
    onTestFinished(() => { vi.useRealTimers(); });
    // Public shape: Poland Post's wall clocks in time_raw with no zone, under the +01:00 17TRACK put on July scans in late October.
    const row = (date: string, time: string, description: string) => ({ time_iso: `${date}T${time}+01:00`, time_utc: null,
      time_raw: { date, time, timezone: null }, description, location: null, stage: null, sub_status: 'InTransit_Other' });
    const reply = (key: number, country?: string): Payload => ({ meta: { code: 200 }, shipments: [{ number, code: 200, shipment: {
      latest_status: { status: 'InTransit' }, ...(country ? { shipping_info: { recipient_address: { country } } } : {}),
      tracking: { providers: [{ provider: { key, name: 'Poland Post', country: 'PL' }, events: [
        row('2026-07-20', '14:25:00', 'Customs service'),
        row('2026-07-08', '10:02:20', 'Departure from Poland'),
        row('2026-07-06', '17:11:32', 'Posting/collection'),
      ] }] } } }] });
    // July is Poland's summer, +02:00; the customs scan abroad is Japan's +09:00.
    expect(parse17TrackResponse(reply(16081, 'JP'), number).events?.map((event) => event.time)).toEqual(['2026-07-20T05:25:00.000Z',
      '2026-07-08T08:02:20.000Z', '2026-07-06T15:11:32.000Z']);
    // With no recipient country, or one on several clocks, the scan abroad keeps 17TRACK's reading.
    for (const country of [undefined, 'ES']) {
      expect(parse17TrackResponse(reply(16081, country), number).events?.map((event) => event.time)).toEqual(['2026-07-20T13:25:00.000Z',
        '2026-07-08T08:02:20.000Z', '2026-07-06T15:11:32.000Z']);
    }
    // Another feed relays no partner: its scan abroad is only read on Poland's clock at its own date.
    expect(parse17TrackResponse(reply(100999, 'JP'), number).events?.[0]?.time).toBe('2026-07-20T12:25:00.000Z');
  });

  it('reads the scans FIC relays from its partner carrier on the recipient\'s clock, and its own in Britain on London\'s', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-26T09:00:00Z') });
    onTestFinished(() => { vi.useRealTimers(); });
    // Public shape: wall clocks in time_raw with no zone, under London's offset on the day 17TRACK looks.
    const row = (time: string, description: string, location: string | null = null) => ({ time_iso: `2026-10-22T${time}+00:00`,
      time_utc: null, time_raw: { date: '2026-10-22', time, timezone: null }, description, location, stage: null, sub_status: 'InTransit_Other' });
    const reply = (key: number, country?: string): Payload => ({ meta: { code: 200 }, shipments: [{ number, code: 200, shipment: {
      latest_status: { status: 'InTransit' }, ...(country ? { shipping_info: { recipient_address: { country } } } : {}),
      tracking: { providers: [{ provider: { key, name: 'FedEx International Connect', country: 'GB' }, events: [
        row('07:30:41', 'DEPARTED SITE', 'READING, GB'),
        row('06:12:00', 'IN TRANSIT'),
        row('06:10:00', 'RECEIVED BY PARTNER CARRIER'),
        row('02:05:12', 'SHIPMENT MANIFESTED FOR DEPARTURE'),
      ] }] } } }] });
    // A partner in Hungary keeps Central European summer time; FIC's own scans keep London's.
    expect(parse17TrackResponse(reply(100222, 'HU'), number).events?.map((event) => event.time)).toEqual(['2026-10-22T06:30:41.000Z',
      '2026-10-22T04:12:00.000Z', '2026-10-22T04:10:00.000Z', '2026-10-22T01:05:12.000Z']);
    // With no recipient country, or one on several clocks, the partner's scans keep 17TRACK's reading, and so does another feed.
    for (const [key, country] of [[100222, undefined], [100222, 'US'], [100999, 'HU']] as const) {
      expect(parse17TrackResponse(reply(key, country), number).events?.map((event) => event.time)).toEqual(['2026-10-22T06:30:41.000Z',
        '2026-10-22T05:12:00.000Z', '2026-10-22T05:10:00.000Z', '2026-10-22T01:05:12.000Z']);
    }
  });

  it('reads a clock 17TRACK labelled with its zone\'s offset on the day it looks at the scan\'s own date', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-25T09:00:00Z') });
    onTestFinished(() => { vi.useRealTimers(); });
    // Public shape: BRT's wall clocks in time_raw with no zone, under the +01:00 17TRACK put on July scans in late October.
    const row = (date: string, time: string, offset = '+01:00', timezone: string | null = null) => ({ time_iso: `${date}T${time}${offset}`,
      time_utc: null, time_raw: { date, time, timezone }, description: 'DEPARTED', location: null, stage: null, sub_status: 'InTransit_Other' });
    const reply = (key: number, country: string, events: unknown[]): Payload => ({ meta: { code: 200 }, shipments: [{ number, code: 200,
      shipment: { latest_status: { status: 'InTransit' }, tracking: { providers: [{ provider: { key, name: 'Example', country }, events }] } } }] });
    const times = (payload: Payload) => parse17TrackResponse(payload, number).events?.map((event) => event.time);
    // July is Italy's summer, +02:00; a scan since the change keeps +01:00, and one 17TRACK labelled +02:00 kept its label.
    expect(times(reply(199997, 'IT', [row('2026-10-26', '08:10:00'), row('2026-07-24', '13:42:00'), row('2026-07-23', '21:00:00', '+02:00')])))
      .toEqual(['2026-10-26T07:10:00.000Z', '2026-07-24T11:42:00.000Z', '2026-07-23T19:00:00.000Z']);
    // A zone the carrier stated stays.
    expect(times(reply(199997, 'IT', [row('2026-07-24', '13:42:00', '+01:00', '+01:00')]))).toEqual(['2026-07-24T12:42:00.000Z']);
    // GLS's leg names Great Britain, but 17TRACK labels it on Central European time.
    expect(times(reply(100005, 'GB', [row('2026-09-30', '16:50:00')]))).toEqual(['2026-09-30T14:50:00.000Z']);
    // Great Britain keeps +00:00 now, so +01:00 there is no label on its clock, and stays.
    expect(times(reply(100999, 'GB', [row('2026-01-12', '10:00:00')]))).toEqual(['2026-01-12T09:00:00.000Z']);
    // In summer a winter scan labelled with summer's offset is read the same way.
    vi.setSystemTime(new Date('2027-07-01T09:00:00Z'));
    expect(times(reply(100007, 'DE', [row('2027-01-12', '10:00:00', '+02:00')]))).toEqual(['2027-01-12T09:00:00.000Z']);
  });

  it('reads NZ Post\'s clock at the scan\'s own date, abroad too when nothing names a country', () => {
    const row = (date: string, time: string, offset: string, description: string) => ({
      time_iso: `${date}T${time}${offset}`, time_utc: null, time_raw: { date, time, timezone: null },
      description, location: null, stage: null, sub_status: 'InTransit_Other' });
    const reply = (requested: string) => ({ meta: { code: 200 }, shipments: [{ number: requested, code: 200,
      shipment: { latest_status: { status: 'InTransit' }, tracking: { providers: [{ provider: { key: 14061, name: 'NZ Post (New Zealand Post)' }, events: [
        row('2026-08-14', '12:47:00', '+13:00', 'Held for clearance, Your item is currently being held for clearance'),
        row('2026-08-08', '11:13:00', '+13:00', 'In transit with airline, Your item is being transported by the airline'),
        row('2026-08-06', '13:55:10', '+13:00', 'International departure, Your item has been processed'),
        row('2026-08-05', '15:59:44', '+13:00', 'Label created'),
      ] }] } } }] });
    const outbound = parse17TrackResponse(reply('ZZ123456785NZ'), 'ZZ123456785NZ');
    // August is New Zealand's winter, +12:00, whatever offset 17TRACK put on it in October. The scan
    // abroad, in no country the reply names, keeps that reading as the last guess.
    expect(outbound.events?.map(e => e.time ?? e.local_time)).toEqual(['2026-08-14T00:47:00.000Z',
      '2026-08-07T23:13:00.000Z', '2026-08-06T01:55:10.000Z', '2026-08-05T03:59:44.000Z']);
    expect(outbound.events?.[0]).toMatchObject({ description: 'Held for clearance, Your item is currently being held for clearance',
      provider_time_iso: '2026-08-14T12:47:00+13:00' });
    // An item coming into New Zealand is scanned there throughout.
    expect(parse17TrackResponse(reply('ZZ123456785CH'), 'ZZ123456785CH').events?.[0]?.time).toBe('2026-08-14T00:47:00.000Z');
  });

  it('reads a scan NZ Post dates abroad in a country it borrows, and China Post\'s mirror of NZ Post on Auckland\'s clock', () => {
    const number = 'ZZ123456785NZ';
    const row = (date: string, time: string, offset: string, description: string, location: string | null = null) => ({
      time_iso: `${date}T${time}${offset}`, time_utc: null, time_raw: { date, time, timezone: null },
      description, location, stage: null, sub_status: 'InTransit_Other' });
    const nzLeg = (airline: string | null) => ({ provider: { key: 14061, name: 'NZ Post (New Zealand Post)', country: 'NZ' }, events: [
      row('2026-08-14', '12:47:00', '+13:00', 'Held for clearance, Your item is currently being held for clearance'),
      row('2026-08-08', '11:13:00', '+13:00', 'In transit with airline, Your item is being transported by the airline', airline),
      row('2026-08-06', '13:55:10', '+13:00', 'International departure, Your item has been processed'),
    ] });
    const chinaPostLeg = (country: string) => ({ provider: { key: 3011, name: 'China Post', country }, events: [
      row('2026-08-06', '06:09:00', '+08:00', '到达境外出口互换局'),
    ] });
    const reply = (providers: unknown[], recipient: string | null = null, requested = number) => ({ meta: { code: 200 },
      shipments: [{ number: requested, code: 200, shipment: { latest_status: { status: 'InTransit' },
        shipping_info: { shipper_address: { country: 'NZ' }, recipient_address: { country: recipient } }, tracking: { providers } } }] });
    const held = (payload: unknown, requested = number) => parse17TrackResponse(payload, requested).events
      ?.find(e => e.description?.startsWith('Held')) ?? null;
    // The recipient's country, China, lends its clock: 12:47 in Guangzhou.
    expect(held(reply([nzLeg(null)], 'CN'))).toMatchObject({ time: '2026-08-14T04:47:00.000Z' });
    // So does the post whose leg follows NZ Post's, and its mirror of NZ Post's exchange scan is Auckland's 06:09.
    const relayed = parse17TrackResponse(reply([chinaPostLeg('CN'), nzLeg(null)]), number);
    expect(relayed.events?.find(e => e.description === 'Held for clearance, Your item is currently being held for clearance')?.time)
      .toBe('2026-08-14T04:47:00.000Z');
    expect(relayed.events?.find(e => e.description === "Arrival at the origin post's office of exchange")).toMatchObject({ time: '2026-08-05T18:09:00.000Z' });
    // An airline scan naming a country lends it before the destination does, though a transit hub's can be the wrong one.
    expect(held(reply([nzLeg('Japan')], 'CN'))).toMatchObject({ time: '2026-08-14T03:47:00.000Z' });
    // A lender on several clocks leaves the wall time; with none at all, NZ Post's Auckland reading stays.
    expect(held(reply([nzLeg('United States')], 'CN'))).toMatchObject({ local_time: '2026-08-14T12:47:00' });
    expect(held(reply([nzLeg(null)]))).toMatchObject({ time: '2026-08-14T00:47:00.000Z' });
    // An origin on several clocks keeps 17TRACK's reading of the exchange scan.
    expect(parse17TrackResponse(reply([chinaPostLeg('CN')], null, 'ZZ123456785US'), 'ZZ123456785US').events?.[0]?.time)
      .toBe('2026-08-05T22:09:00.000Z');
  });

  it('reads Correos de El Salvador\'s scans in UTC, its copies of the origin post\'s and Swiss Post\'s relays on their offices\' clocks', () => {
    const row = (date: string, time: string, offset: string | null, description: string, location: string | null = null) => ({
      time_iso: `${date}T${time}${offset ?? '-05:00'}`, time_utc: null, time_raw: { date, time, timezone: offset },
      description, location, stage: null, sub_status: 'InTransit_Other' });
    const reply = (requested: string, recipient: string | null) => ({ meta: { code: 200 }, shipments: [{ number: requested, code: 200,
      shipment: { latest_status: { status: 'InTransit' }, shipping_info: { recipient_address: { country: recipient } }, tracking: { providers: [
        { provider: { key: 19031, name: 'Correo El Salvador', country: 'SV' }, events: [
          row('2026-10-08', '18:26:18', null, 'Transferir envío al agente de entrega (entrada)', 'SAN BENITO'),
          row('2026-09-03', '12:20:00', null, 'Recibir envío en oficina de cambio (salida)', 'CHGVAC'),
        ] },
        { provider: { key: 19251, name: 'Swiss Post', country: 'CH' }, events: [
          row('2026-10-08', '12:26:00', '+02:00', 'Sorting - forwarding'),
          row('2026-10-06', '06:45:39', '+02:00', 'Enquiry initiated', 'CH'),
          row('2026-09-03', '12:20:28', '+02:00', 'Forwarding abroad', 'Example, CH 000000'),
        ] },
      ] } } }] });
    const times = (requested: string, recipient: string | null) => parse17TrackResponse(reply(requested, recipient), requested).events
      ?.map(e => `${e.time} ${e.description}`);
    // UPU has the delivery round at 12:26 in El Salvador, -06:00, and Geneva's departure at 12:20 Zurich time.
    expect(times('ZZ123456785CH', 'SV')).toEqual([
      '2026-10-08T18:26:18.000Z Transferir envío al agente de entrega (entrada)', '2026-10-08T18:26:00.000Z Sorting - forwarding',
      '2026-10-06T04:45:39.000Z Enquiry initiated', '2026-09-03T10:20:28.000Z Forwarding abroad',
      '2026-09-03T10:20:00.000Z Recibir envío en oficina de cambio (salida)']);
    // From an origin on several clocks the copy keeps 17TRACK's reading; with no recipient named, so does Swiss Post's relay.
    expect(times('ZZ123456785US', null)).toEqual([
      '2026-10-08T18:26:18.000Z Transferir envío al agente de entrega (entrada)', '2026-10-08T10:26:00.000Z Sorting - forwarding',
      '2026-10-06T04:45:39.000Z Enquiry initiated', '2026-09-03T17:20:00.000Z Recibir envío en oficina de cambio (salida)',
      '2026-09-03T10:20:28.000Z Forwarding abroad']);
  });

  it('reads Correos\'s copies of an origin post\'s scans on that post\'s clock, its own on Madrid\'s', () => {
    // 17TRACK words Correos's rows "PHASE, summary, details" and puts Madrid's offset on their wall clocks.
    const row = (time: string, utc: string, description: string) => ({ time_iso: `${time}+02:00`, time_utc: utc,
      time_raw: { date: time.slice(0, 10), time: time.slice(11), timezone: null }, description, location: null, stage: null,
      sub_status: 'InTransit_Other' });
    const reply = (requested: string) => ({ meta: { code: 200 }, shipments: [{ number: requested, code: 200,
      shipment: { latest_status: { status: 'InTransit' }, tracking: { providers: [{ provider: { key: 19181, name: 'Correos Spain', country: 'ES' },
        events: [
          row('2026-10-05T09:11:05', '2026-10-05T07:11:05Z', 'EN CAMINO, Llegada a oficina de cambio, El envío ha llegado a la oficina de cambio'),
          row('2026-09-29T17:01:00', '2026-09-29T15:01:00Z', 'EN CAMINO, En aduana de origen, El envío está en la aduana de origen'),
          row('2026-09-29T16:56:00', '2026-09-29T14:56:00Z', 'EN CAMINO, En oficina de cambio, El envío está en la oficina de cambio'),
        ] }] } } }] });
    const times = (requested: string) => parse17TrackResponse(reply(requested), requested).events?.map((e) => e.time ?? `local ${e.local_time}`);
    expect(times('RR123456785IN')).toEqual(['2026-10-05T07:11:05.000Z', '2026-09-29T11:31:00.000Z', '2026-09-29T11:26:00.000Z']);
    // An origin on several clocks leaves the wall clock, and Spain's own items keep Madrid's.
    expect(times('RR123456785US')).toEqual(['2026-10-05T07:11:05.000Z', 'local 2026-09-29T17:01:00', 'local 2026-09-29T16:56:00']);
    expect(times('RR123456785ES')).toEqual(['2026-10-05T07:11:05.000Z', '2026-09-29T15:01:00.000Z', '2026-09-29T14:56:00.000Z']);
  });

  it('reads the clock and offset 17TRACK shows when its UTC conversion disagrees', () => {
    // An India Post leg: the wall clock under India's offset, and a conversion 30 minutes after it.
    const scan = { time_iso: '2026-07-14T14:40:00+05:30', time_utc: '2026-07-14T09:40:00Z',
      time_raw: { date: '2026-07-14', time: '14:40:00', timezone: null },
      description: 'Item received', location: 'EXAMPLE OFFICE', stage: null, sub_status: 'InTransit_Other' };
    const reply: Payload = { meta: { code: 200 }, shipments: [{ number, code: 200, shipment: { latest_status: { status: 'InTransit' },
      tracking: { providers: [{ provider: { key: 9021, name: 'India Post' }, events: [scan] }] } } }] };
    expect(parse17TrackResponse(reply, number).events?.[0]).toMatchObject({
      time: '2026-07-14T09:10:00.000Z', provider_time_iso: '2026-07-14T14:40:00+05:30',
      reporting_carrier: 'India Post', time_provenance: 'provider_inferred',
    });
    // Agreeing readings, or a shown clock without an offset, leave time_utc in charge.
    const utc = (overrides: Record<string, unknown>) =>
      parse17TrackResponse(postalHistory([{ ...postalScan('InTransit_Other'), ...overrides }]), number).events?.[0]?.time;
    expect(utc({})).toBe('2026-09-20T04:22:00.000Z');
    expect(utc({ time_iso: '2026-09-20T12:22:00' })).toBe('2026-09-20T04:22:00.000Z');
    expect(utc({ time_iso: null })).toBe('2026-09-20T04:22:00.000Z');
    expect(utc({ time_utc: null })).toBe('2026-09-20T04:22:00.000Z');
    expect(() => utc({ time_utc: 'broken' })).toThrow('invalid tracking event');
  });

  it('counts India Post take-offs, whose airport clock 17TRACK reads as UTC, without dating them', () => {
    // A Frankfurt take-off at 21:20 local, shown as if 21:20 were UTC.
    const scan = (description: string, time: string) => ({ time_iso: `2026-10-04T${time}+05:30`, time_utc: `2026-10-03T21:${time.slice(3, 5)}:00Z`,
      time_raw: { date: '2026-10-04', time, timezone: null }, description, location: '', stage: null, sub_status: 'InTransit_Other' });
    const reply = (events: Record<string, unknown>[], name = 'India Post'): Payload => ({ meta: { code: 200 }, shipments: [{ number, code: 200,
      shipment: { latest_status: { status: 'InTransit' }, tracking: { providers: [{ provider: { key: 9021, name }, events }] } } }] });
    const result = parse17TrackResponse(reply([
      scan('UPLIFT', '02:55:00'), scan('Aircraft Departure', '02:50:00'), scan('Bag dispatched', '01:10:00'),
    ]), number);
    expect(result.events?.map((event) => event.description)).toEqual(['Bag dispatched']);
    // The scans before it still say where the parcel is.
    expect(result).toMatchObject({ current_stage: 'in_transit', undated_event_count: 2 });
    // Other operators, and India Post's other rows, keep 17TRACK's reading.
    expect(parse17TrackResponse(reply([scan('Aircraft Departure', '02:50:00')], 'Example Parcel Co'), number).events)
      .toHaveLength(1);
    expect(parse17TrackResponse(reply([scan('Aircraft departure scheduled', '02:50:00')]), number).events).toHaveLength(1);
  });

  it('requires a completed identity-matched NotFound and an empty history for a negative answer', () => {
    expect(thrown(() => parse17TrackResponse(postalHistory([], 'NotFound'), number)))
      .toMatchObject({ name: 'NotFoundError', kind: 'not_found', status: 404 });
    expect(thrown(() => parse17TrackResponse(postalHistory([]), number))).not.toMatchObject({ kind: 'not_found' });
    expect(thrown(() => parse17TrackResponse(postalHistory([], 'NotFound'), 'OTHER123')))
      .toMatchObject({ kind: 'schema' });
    expect(parse17TrackResponse(postalHistory([postalScan('InTransit_Other')], 'NotFound'), number).current_stage).toBe('in_transit');
  });

  it('distinguishes a matching no-history reply from request failure, polling and an invalid number', () => {
    expect(thrown(() => parse17TrackResponse(noHistory(), number)))
      .toMatchObject({ name: 'SeventeenTrackNoHistoryError', kind: 'indeterminate', status: 502, reason: 'no_history', providerCode: 400 });
    expect(thrown(() => parse17TrackResponse({ meta: { code: 400 }, shipments: [] }, number)))
      .toMatchObject({ name: 'SeventeenTrackLookupError', kind: 'transport', reason: 'lookup_unavailable', providerCode: 400 });
    expect(thrown(() => parse17TrackResponse({ meta: { code: 200 }, shipments: [{ number, code: 100, shipment: null }] }, number)))
      .toMatchObject({ name: 'SeventeenTrackLookupError', kind: 'transport', reason: 'lookup_pending', providerCode: 100 });
    // The USPS cap is an answer, not an outage: a cooldown for it would cost every other carrier.
    expect(thrown(() => parse17TrackResponse({ meta: { code: 200 }, shipments: [{ number, code: 402, shipment: null }] }, number)))
      .toMatchObject({ name: 'SeventeenTrackQuotaError', kind: 'indeterminate', reason: 'usps_quota', providerCode: 402 });
  });

  it.each([
    { params_v2: [{ key: 'postal_code', input_type: 'Text' }] },
    { param: { type: 'PostalCode' } },
    { params: [{ type: 'PostalCode' }] },
  ])('relays a matching postcode prompt without inferring that a supplied postcode worked: %j', fields => {
    const payload = { meta: { code: 200 }, shipments: [{ number, code: 400, shipment: null, ...fields }] };
    expect(thrown(() => parse17TrackResponse(payload, number))).toMatchObject({ kind: 'input_required', provider: '17TRACK', field: 'postcode' });
    expect(thrown(() => parse17TrackResponse(payload, number, '8000'))).toMatchObject({ name: 'SeventeenTrackNoHistoryError' });
    expect(thrown(() => parse17TrackResponse(payload, 'OTHER123'))).toMatchObject({ kind: 'schema' });
    expect(thrown(() => parse17TrackResponse({ ...payload, shipments: [...payload.shipments, ...payload.shipments] }, number))).toMatchObject({ kind: 'schema' });
  });

  it('keeps history ahead of optional postcode metadata and ignores other requested inputs', () => {
    const payload = history();
    payload.shipments[0]!.params_v2 = [{ key: 'postal_code' }];
    expect(parse17TrackResponse(payload, number).current_stage).toBe('delivered');
    for (const fields of [{ params_v2: [{ key: 'phone_number_last_4' }] }, { param: { type: 'ShipDate' } },
      { params_v2: [], param: { type: 'PostalCode' } }]) {
      expect(thrown(() => parse17TrackResponse({ meta: { code: 200 }, shipments: [{ number, code: 400, shipment: null, ...fields }] }, number)))
        .toMatchObject({ name: 'SeventeenTrackNoHistoryError' });
    }
  });

  it('asks for a postcode only when the form requires it and no other field', () => {
    const country = { key: 'destination_country', input_type: 'Options', regex: '^([A-Z]{2})$' };
    const postcode = { key: 'postal_code', input_type: 'Text', regex: '^([A-Z0-9\\- ]{4,9})$' };
    const reply = (fields: Record<string, unknown>) => ({ meta: { code: 200 }, shipments: [{ number, code: 400, shipment: null, ...fields }] });
    for (const fields of [{ params_v2: [country, postcode] }, { params_v2: [{ key: 'destination_country' }, postcode] },
      { param: { type: 'DestCountry', format: '^([A-Z]{2})$' }, params: [{ type: 'DestCountry', format: '^([A-Z]{2})$' }, { type: 'PostalCode' }] }]) {
      expect(thrown(() => parse17TrackResponse(reply(fields), number))).toMatchObject({ name: 'SeventeenTrackNoHistoryError' });
    }
    // An optional field beside it leaves the postcode the only input to give.
    for (const fields of [{ params_v2: [{ ...country, regex: '^(|[A-Z]{2})$' }, postcode] }, { params_v2: [postcode] }]) {
      expect(thrown(() => parse17TrackResponse(reply(fields), number))).toMatchObject({ kind: 'input_required', field: 'postcode' });
    }
    // A postcode the form would submit empty is not needed.
    const optional = { ...postcode, regex: '^(|[A-Z0-9\\- ]{4,9})$' };
    for (const fields of [{ params_v2: [optional] }, { param: { type: 'PostalCode', format: '^(|\\d{5})$' } }]) {
      expect(thrown(() => parse17TrackResponse(reply(fields), number))).toMatchObject({ name: 'SeventeenTrackNoHistoryError' });
    }
  });

  it('does not infer no history from another identity, ambiguity, an unknown code or an unexpected payload', () => {
    for (const payload of [noHistory('OTHER123'), { ...noHistory(), shipments: [noHistory().shipments[0], noHistory().shipments[0]] }]) {
      expect(thrown(() => parse17TrackResponse(payload, number))).toMatchObject({ kind: 'schema' });
    }
    for (const shipment of [{ number, code: 500, shipment: null }, { number, code: 400 }, { number, code: 400, shipment: {} }]) {
      expect(thrown(() => parse17TrackResponse({ meta: { code: 200 }, shipments: [shipment] }, number)))
        .toMatchObject({ name: 'SeventeenTrackLookupError', kind: 'transport' });
    }
  });

  it('uses matching history, keeps the reported carrier and scan places, and strips recipient data', () => {
    const result = parse17TrackResponse(delivered, number);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', tracking_provider: '17TRACK',
      last_update: '2026-08-31T18:50:50.000Z' });
    expect(result.events?.[0]).toMatchObject({ stage: 'delivered', description: 'Delivered' });
    expect(result.events?.[1]).toMatchObject({ stage: 'out_for_delivery', time: '2026-08-31T17:12:44.000Z',
      location: 'EXAMPLE TOWN, CH' });
    // A place holding private delivery details is dropped, and the street-level address never read.
    expect(result.events?.[0]?.location).toBeUndefined();
    expect(result).toMatchObject({ reported_carriers: ['Swiss Post'], discovered_carrier: 'swiss-post' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('rejects demos, ambiguity, unfinished polling and verification errors', () => {
    const ambiguous: Payload = { ...delivered, shipments: [delivered.shipments[0]!, delivered.shipments[0]!] };
    for (const payload of [history('TestNumber00017'), ambiguous, { meta: { code: 400 }, shipments: [] }]) {
      expect(() => parse17TrackResponse(payload, number)).toThrow();
    }
    expect(thrown(() => parse17TrackResponse({ meta: { code: -14 }, shipments: [] }, number)))
      .toMatchObject({ name: 'SeventeenTrackVerificationError', reason: 'verification_required', providerCode: -14, status: 403 });
    expect(thrown(() => parse17TrackResponse({ meta: { code: 200 }, shipments: [{ number, code: 100 }] }, number)))
      .toMatchObject({ name: 'SeventeenTrackLookupError', reason: 'lookup_pending', providerCode: 100 });
  });
});

describe('17TRACK carrier choice', () => {
  // GLS France's key in 17TRACK's carrier list; its detection reads such numbers as GLS's group service.
  const GLS_FR = 101272;
  const reply = (key: number, name: string, days: number[]): Payload => ({ meta: { code: 200 }, shipments: [{ number, code: 200, shipment: {
    latest_status: { status: 'InTransit' }, tracking: { providers: [{ provider: { key, name }, events: days.map((day) => ({
      time_iso: `2026-09-${String(day).padStart(2, '0')}T10:00:00+02:00`, time_utc: `2026-09-${String(day).padStart(2, '0')}T08:00:00Z`,
      time_raw: { date: `2026-09-${String(day).padStart(2, '0')}`, time: '10:00:00', timezone: null },
      description: 'Parcel in transit', stage: null, sub_status: 'InTransit_Other' })) }] } } }],
  });
  const chosen = `https://t.17track.net/en#nums=${number}&fc=${GLS_FR}`;
  const lookups = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>) => fetcher.mock.calls.map(([, init]) => JSON.parse(String(init!.body)).url);

  it('asks again for the filed carrier when 17TRACK detects another one, and keeps the fuller answer', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(captured(reply(100005, 'GLS', [20])))
      .mockResolvedValueOnce(captured(reply(GLS_FR, 'GLS (FR)', [20, 19, 18]), { url: chosen }));
    await expect(tracker(fetcher).fetch(number, undefined, undefined, null, 'gls-fr')).resolves.toMatchObject({
      reported_carriers: ['GLS (FR)'], events: [{ reporting_carrier_key: GLS_FR }, {}, {}] });
    expect(lookups(fetcher)).toEqual([`https://t.17track.net/en#nums=${number}`, chosen]);
    // A carrier answer with fewer scans leaves the detected one.
    fetcher.mockReset().mockResolvedValueOnce(captured(reply(100005, 'GLS', [20, 19])))
      .mockResolvedValueOnce(captured(reply(GLS_FR, 'GLS (FR)', [20]), { url: chosen }));
    await expect(tracker(fetcher).fetch(number, undefined, undefined, null, 'gls-fr')).resolves.toMatchObject({ reported_carriers: ['GLS'] });
  });

  it('turns a detection without history, or still polling, into the carrier\'s history, and keeps the first answer when that has none', async () => {
    const polling = { meta: { code: 200 }, shipments: [{ number, code: 100, shipment: null }] };
    for (const first of [noHistory(), polling]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(captured(first))
        .mockResolvedValueOnce(captured(reply(GLS_FR, 'GLS (FR)', [20]), { url: chosen }));
      await expect(tracker(fetcher).fetch(number, undefined, undefined, null, 'gls-fr')).resolves.toMatchObject({ current_stage: 'in_transit' });
    }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(captured(noHistory()))
      .mockResolvedValueOnce(captured(postalHistory([], 'NotFound'), { url: chosen }));
    await expect(tracker(fetcher).fetch(number, undefined, undefined, null, 'gls-fr')).rejects.toMatchObject({ name: 'SeventeenTrackNoHistoryError' });
    fetcher.mockReset().mockResolvedValueOnce(captured(noHistory())).mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(tracker(fetcher).fetch(number, undefined, undefined, null, 'gls-fr')).rejects.toMatchObject({ name: 'SeventeenTrackNoHistoryError' });
  });

  it('asks once when the detected carrier is the filed one, none is listed, or 17TRACK did not answer', async () => {
    // Korea Post is asked for its domestic service; its international one is the same carrier.
    for (const [data, carrier] of [[reply(GLS_FR, 'GLS (FR)', [20]), 'gls-fr'], [reply(11051, 'ePOST', [20]), 'korea-post'],
      [noHistory(), null], [noHistory(), 'unknown'],
      [{ meta: { code: -14 }, shipments: [] }, 'gls-fr'], [{ meta: { code: 200 }, shipments: [{ number, code: 402, shipment: null }] }, 'gls-fr'],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => captured(data));
      await tracker(fetcher).fetch(number, undefined, undefined, null, carrier).catch(() => null);
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('forwards the filed carrier from the adapter input and leaves no time-starved second lookup', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => captured(noHistory()));
    const provider = adapter({ trawl: new TrawlClient('http://browser.test', fetcher), recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null });
    await expect(provider.track({ number, carrier: 'gls-fr' })).rejects.toMatchObject({ name: 'SeventeenTrackNoHistoryError' });
    expect(lookups(fetcher)).toEqual([`https://t.17track.net/en#nums=${number}`, chosen]);
    fetcher.mockClear();
    await expect(provider.track({ number, carrier: 'gls-fr' }, { budgetMs: 4_000 })).rejects.toMatchObject({ name: 'SeventeenTrackNoHistoryError' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('17TRACK browser capture', () => {
  it('preserves completed not-found and malformed matching history errors through capture', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(captured(postalHistory([], 'NotFound')));
    await expect(tracker(fetcher).fetch(number)).rejects.toMatchObject({ kind: 'not_found' });
    fetcher.mockResolvedValue(captured(postalHistory([{ ...postalScan('InTransit_Other'), time_utc: 'broken' }])));
    await expect(tracker(fetcher).fetch(number)).rejects.toMatchObject({ kind: 'schema' });
  });
  it('asks the browser service for the page and reads its captured API response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(captured(delivered));
    await expect(tracker(fetcher, 'http://browser.test/v1').fetch(number)).resolves.toMatchObject({ tracking_provider: '17TRACK' });
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('http://browser.test/scrape');
    expect(JSON.parse(String(options!.body))).toMatchObject({
      url: `https://t.17track.net/en#nums=${number}`, skipHttp: true, maxTier: 3,
      captureResponses: [API], settleTimeout: 15_000,
    });
    expect(Number.isInteger(JSON.parse(String(options!.body)).maxTimeout)).toBe(true);
  });

  it('forwards adapter input, accepts a bound postcode reply, and records a prompt through telemetry', async () => {
    const prompt = { meta: { code: 200 }, shipments: [{ number, code: 400, shipment: null, params_v2: [{ key: 'postal_code' }] }] };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(captured(prompt));
    const recorder = { step: vi.fn(), lookup: vi.fn() };
    const provider = adapter({ trawl: new TrawlClient('http://browser.test', fetcher), recorder, env: {}, browserExecutablePath: null });
    await expect(provider.track({ number, postcode: null, timezone: null })).rejects.toMatchObject({ kind: 'input_required', field: 'postcode' });
    expect(recorder.lookup).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'input_required', errorType: 'InputRequiredError' }));
    const url = `https://t.17track.net/en#nums=${number}&trawl-postcode=AB1%202CD`;
    fetcher.mockResolvedValue(captured(null, { url, capturedResponses: [
      { url: API, status: 200, body: JSON.stringify(prompt) },
      { url: API, status: 200, body: JSON.stringify(delivered), postcodeSubmitted: true },
    ] }));
    await expect(provider.track({ number, postcode: ' ab1  2cd ', timezone: null })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(JSON.parse(String(fetcher.mock.calls.at(-1)![1]!.body)).url).toBe(url);
    fetcher.mockResolvedValue(captured(null, { url, capturedResponses: [
      { url: API, status: 200, body: JSON.stringify(prompt), postcodeSubmitted: true },
    ] }));
    await expect(provider.track({ number, postcode: 'AB1 2CD', timezone: null })).rejects.toMatchObject({ name: 'SeventeenTrackNoHistoryError' });
  });

  it('does not silently claim a postcode retry when the browser service ignored it', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(captured(noHistory(), { url: `https://t.17track.net/en#nums=${number}&trawl-postcode=8000` }));
    await expect(tracker(fetcher).fetch(number, undefined, undefined, '8000')).rejects.toMatchObject({ kind: 'transport', reason: 'postcode_not_submitted' });
    fetcher.mockClear();
    await expect(tracker(fetcher).fetch(number, undefined, undefined, '<script>8000')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('needs the browser service and never requests an arbitrary user URL', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new SeventeenTrackTracker().fetch(number)).rejects.toThrow('tracking browser service');
    await expect(tracker(fetcher).fetch('http://localhost')).rejects.toThrow('Invalid tracking number');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects redirected, unsolved, truncated and binary pages', async () => {
    for (const overrides of [{ url: 'https://evil.test/' }, { statusCode: 403 }, { tier: 1 }, { error: 'browser failed' },
      { capturedResponses: [{ url: API, body: JSON.stringify(delivered), status: 200, truncated: true }] },
      { capturedResponses: [{ url: API, body: JSON.stringify(delivered), status: 200, base64Encoded: true }] }]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(captured(delivered, overrides));
      await expect(tracker(fetcher).fetch(number)).rejects.toThrow();
    }
  });

  it('distinguishes missing capture capability, unreadable bodies and provider lookup failures', async () => {
    for (const [data, overrides, expected] of [
      [null, { capturedResponses: undefined }, { name: 'TrackingCaptureError', reason: 'capture_missing' }],
      [null, { capturedResponses: [{ url: API, status: 200, body: null, error: 'compressed gzip body was not read safely' }] },
        { name: 'TrackingCaptureError', reason: 'capture_unreadable' }],
      [null, { capturedResponses: [{ url: 'https://t.17track.net/other', status: 200, body: '{}' }] },
        { name: 'TrackingCaptureError', reason: 'history_missing' }],
      [{ meta: { code: 200 }, shipments: [{ number, code: 400, shipment: null }] }, {},
        { name: 'SeventeenTrackNoHistoryError', kind: 'indeterminate', reason: 'no_history', providerCode: 400 }],
      [{ meta: { code: -14 }, shipments: [] }, {}, { name: 'SeventeenTrackVerificationError', providerCode: -14 }],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(captured(data, overrides));
      await expect(tracker(fetcher).fetch(number)).rejects.toMatchObject(expected);
    }
  });

  it('reports no history through telemetry and accepts a later completed history', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(captured(noHistory()));
    const recorder = { step: vi.fn(), lookup: vi.fn() };
    const adapter = new SeventeenTrackTracker({ trawl: new TrawlClient('http://browser.test', fetcher), recorder });
    await expect(adapter.fetch(number)).rejects.toMatchObject({ name: 'SeventeenTrackNoHistoryError', kind: 'indeterminate' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'indeterminate', errorType: 'SeventeenTrackNoHistoryError' }));
    expect(recorder.lookup).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'indeterminate', errorType: 'SeventeenTrackNoHistoryError' }));
    fetcher.mockResolvedValue(captured(null, { capturedResponses: [
      { url: API, status: 200, body: JSON.stringify(noHistory()) },
      { url: API, status: 200, body: JSON.stringify(delivered) },
    ] }));
    await expect(adapter.fetch(number)).resolves.toMatchObject({ tracking_provider: '17TRACK', current_stage: 'delivered' });
  });

  it('accepts completed matching history after intermediate polling and keeps the API Retry-After', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(captured(null, { capturedResponses: [
      { url: API, status: 200, body: JSON.stringify({ meta: { code: 200 }, shipments: [{ number, code: 100 }] }) },
      { url: API, status: 200, body: JSON.stringify(delivered) },
    ] }));
    await expect(tracker(fetcher).fetch(number)).resolves.toMatchObject({ tracking_provider: '17TRACK' });
    fetcher.mockResolvedValue(captured(null, { capturedResponses: [
      { url: API, status: 429, body: null, headers: { 'retry-after': '300' } },
    ] }));
    await expect(tracker(fetcher).fetch(number)).rejects.toMatchObject({ name: 'UpstreamHttpError', status: 429, retryAfterMs: 300_000 });
    fetcher.mockResolvedValue(captured(null, { capturedResponses: [{ url: API, status: 503, body: null }] }));
    await expect(tracker(fetcher).fetch(number)).rejects.toMatchObject({ name: 'UpstreamHttpError', status: 503 });
  });
});
