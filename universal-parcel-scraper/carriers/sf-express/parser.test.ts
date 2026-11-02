import { describe, expect, it } from 'vitest';
import fixture from './fixtures/delivered.json' with { type: 'json' };
import { normalizeSfExpressNumber, parse } from './parser.js';
import { sfExpressEventStatus, sfExpressSummaryStatus } from './status.js';

const NUMBER = 'SF0000000000001';
const copy = () => structuredClone(fixture);

describe('SF Express public route parsing', () => {
  it('dates every scan on UTC+08:00, the newest as the last update and the delivery as delivered', () => {
    const result = parse(copy(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      last_update: '2026-01-08T11:20:00+08:00', delivered_at: '2026-01-08T11:20:00+08:00', expected_delivery: null });
    expect(result.events).toHaveLength(6);
    expect(result.events?.[0]).toEqual({ time: '2026-01-08T11:20:00+08:00', description: 'Delivered', provider_code: '80', stage: 'delivered' });
    expect(result.events?.[1]?.stage).toBe('out_for_delivery');
    expect(result.events?.at(-1)?.time).toBe('2026-01-04T12:00:00+08:00');
    expect(result.events?.every((event) => event.local_time === undefined && event.time?.endsWith('+08:00'))).toBe(true);
    expect(result.last_update_local).toBeUndefined();
    expect(result.timezone).toBeUndefined();
  });

  it('reads a scan abroad, in Hong Kong or without a site on the same clock as a mainland one, in every season', () => {
    const value = copy(); const routes = value.result[0]!.routes;
    // A mainland site, Hong Kong, a site abroad on summer time, and a scan without a site.
    routes[0]!.zoneCode = '755XA'; routes[1]!.zoneCode = '852XA'; routes[2]!.zoneCode = 'LHR01R';
    routes[2]!.scanDateTime = '2026-07-06 15:00:00'; routes[3]!.scanDateTime = '2026-07-07 10:00:00';
    routes[4]!.scanDateTime = '2026-07-08 07:50:00'; routes[5]!.scanDateTime = '2026-07-08 11:20:00';
    delete (routes[3] as { zoneCode?: string }).zoneCode;
    const times = parse(value, NUMBER).events!.map((event) => event.time);
    expect(times).toEqual(['2026-07-08T11:20:00+08:00', '2026-07-08T07:50:00+08:00', '2026-07-07T10:00:00+08:00',
      '2026-07-06T15:00:00+08:00', '2026-01-05T14:00:00+08:00', '2026-01-04T12:00:00+08:00']);
  });

  it('gives a scan the same instant on every check, whatever the rest of the reply says', () => {
    const first = parse(copy(), NUMBER).events!;
    expect(parse(copy(), NUMBER).events).toEqual(first);
    const value = copy(); const shipment = value.result[0]!;
    shipment.mainlandToMainland = true; shipment.origin = 'Synthetic origin'; shipment.routes.reverse();
    shipment.routes.forEach((route) => { route.zoneCode = 'ZZZ99Z'; });
    shipment.routes.push({ ...shipment.routes[0]!, scanDateTime: '2026-01-09 08:00:00', opCode: '31', remark: 'Later movement' });
    const later = parse(value, NUMBER);
    expect(later.events!.slice(1)).toEqual(first);
    expect(later).toMatchObject({ last_update: '2026-01-09T08:00:00+08:00', delivered_at: '2026-01-08T11:20:00+08:00' });
  });

  it('keeps scans of one instant in the carrier\'s order', () => {
    const value = copy(); const routes = value.result[0]!.routes;
    routes[3]!.scanDateTime = routes[2]!.scanDateTime;
    expect(parse(value, NUMBER).events!.map((event) => event.provider_code)).toEqual(['80', '204', '14', '106', '30', '950']);
  });

  it('dates no delivery before the parcel is delivered', () => {
    const value = copy(); value.result[0]!.signed = false; value.result[0]!.routes.pop();
    expect(parse(value, NUMBER)).toMatchObject({ status: 'out_for_delivery', last_update: '2026-01-08T07:50:00+08:00' });
    expect(parse(value, NUMBER).delivered_at).toBeUndefined();
    value.result[0]!.signed = true;
    expect(parse(value, NUMBER)).toMatchObject({ status: 'delivered', last_update: '2026-01-08T07:50:00+08:00' });
    expect(parse(value, NUMBER).delivered_at).toBeUndefined();
  });

  it('normalizes only supported public number formats', () => {
    expect(normalizeSfExpressNumber('sf 0000000000001')).toBe(NUMBER);
    expect(normalizeSfExpressNumber('1234-5678-9012')).toBe('123456789012');
    for (const value of ['', 'SF123', '1234567890123', 'SF0000000000001/other']) {
      expect(() => normalizeSfExpressNumber(value)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('requires one independently matching result and does not follow sibling identities', () => {
    const wrong = copy(); wrong.result[0]!.id = 'SF0000000000002';
    expect(() => parse(wrong, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const duplicate = copy(); duplicate.result.push(duplicate.result[0]!);
    expect(() => parse(duplicate, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const mixed = copy(); mixed.result.unshift(wrong.result[0]!);
    expect(parse(mixed, NUMBER).events).toHaveLength(6);
  });

  it('keeps an empty success envelope inconclusive', () => {
    expect(() => parse({ ...fixture, result: [] }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
  });

  it('keeps verification failures and server errors distinct from unknown shipments', () => {
    expect(() => parse({ code: 1, result: null, detailMessage: 'Captcha  verification failure' }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parse({ code: 70000, result: null }, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parse({ code: 60000, result: null, detailMessage: '运单路由查询被管控' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parse({ code: 500, result: null }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: undefined }));
    for (const value of [null, [], {}, { ...fixture, success: false }, { ...fixture, result: [null] }]) {
      expect(() => parse(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('validates calendars, history shape and operation codes', () => {
    for (const scanDateTime of ['2026-02-30 10:00:00', '2026-01-02 25:00:00', '', '2026-01-01T00:00:00Z']) {
      const value = copy(); value.result[0]!.routes[0]!.scanDateTime = scanDateTime;
      expect(() => parse(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const routes of [[], [null], [{ ...fixture.result[0]!.routes[0], opCode: '' }], [{ ...fixture.result[0]!.routes[0], remark: '' }]]) {
      expect(() => parse({ ...fixture, result: [{ ...fixture.result[0], routes }] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('classifies the codes whose remarks settle their stage, and only those', () => {
    for (const [code, reason, stage, status] of [
      ['208', '', 'in_transit', 'in_transit'], // In transit
      ['98', '', 'in_transit', 'in_transit'], // In transit
      ['649', '', 'in_transit', 'in_transit'], // Shipment in transit at a country or town
      ['310', '', 'in_transit', 'in_transit'], // A truck on a long-distance run near a city
      ['115', '', 'in_transit', 'in_transit'], // On the flight between two places
      ['116', '', 'in_transit', 'in_transit'], // A flight's stopover
      ['302', '', 'in_transit', 'in_transit'], // Departed for the next centre
      ['305', '', 'in_transit', 'in_transit'], // Arrived at a centre
      ['570', '', 'in_transit', 'in_transit'], // Vehicle departed, between two centres
      ['605', '', 'customs', 'in_transit'], // Under customs clearance
      ['16', '', 'customs', 'in_transit'], // Under customs clearance, please wait
      ['10', '', 'in_transit', 'in_transit'], // Departed from a transit place on a flight
      ['11', '', 'in_transit', 'in_transit'], // Arrived at a transit place off a flight
      ['1105', '', 'in_transit', 'in_transit'], // In transit at an airport or town, please wait
      ['1106', '', 'in_transit', 'in_transit'],
      ['70', '4', 'failed_attempt', 'exception'], // The receiver's address could not be reached
      ['70', '222', 'ready_for_pickup', 'out_for_delivery'], // Left at a post office or pickup point
      ['70', '5', 'out_for_delivery', 'out_for_delivery'], // The frontend's delivery-round group
      ['70', '65', 'out_for_delivery', 'out_for_delivery'],
    ] as const) {
      expect(sfExpressEventStatus(code, reason)).toEqual({ stage, status });
    }
    // Code 99 is read by its remark.
    expect(sfExpressEventStatus('99', '', 'The shipment is being returned')).toEqual({ stage: 'returned', status: 'exception' });
    expect(sfExpressEventStatus('99', '', 'The shipment is being forwarded')).toEqual({ stage: 'in_transit', status: 'in_transit' });
    for (const remark of ['', 'The shipment is being returned to the hub for sorting', 'Status updated']) expect(sfExpressEventStatus('99', '', remark)).toBeUndefined();
    // Code 70 with a reason it does not know is read by its remark.
    expect(sfExpressEventStatus('70', '', 'The shipment has arrived at the warehouse and is waiting for inspection and acceptance. Please wait patiently.'))
      .toEqual({ stage: 'out_for_delivery', status: 'out_for_delivery' });
    // Code 99 needs a known remark, 70 a known reason or remark.
    for (const [code, reason] of [['99', ''], ['70', ''], ['70', '999'], ['70_5', '']] as const) expect(sfExpressEventStatus(code, reason)).toBeUndefined();
    const value = copy(); value.result[0]!.signed = false; value.result[0]!.routes.pop();
    value.result[0]!.routes.push({ ...value.result[0]!.routes[0]!, scanDateTime: '2026-01-08 18:00:00', opCode: '70', stayWhyCode: '222',
      remark: 'The shipment has been placed at the self-pickup location, waiting for the customer to pick it up' });
    expect(parse(value, NUMBER)).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup' });
    value.result[0]!.routes.at(-1)!.opCode = '208';
    expect(parse(value, NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
  });

  it('does not turn warehouse dispatch, redirects, returns or ambiguous codes into delivery', () => {
    expect(sfExpressEventStatus('202', '')).toMatchObject({ status: 'in_transit' });
    expect(sfExpressEventStatus('626', '')).toMatchObject({ status: 'in_transit' });
    expect(sfExpressEventStatus('8000', '4')).toMatchObject({ status: 'exception', stage: 'returned' });
    expect(sfExpressEventStatus('8000', '')).toBeUndefined();
    expect(sfExpressEventStatus('8000', '__proto__')).toBeUndefined();
    expect(sfExpressSummaryStatus('__proto__', false)).toBeUndefined();
    expect(sfExpressSummaryStatus('4', true)).toMatchObject({ stage: 'returned' });
    expect(sfExpressSummaryStatus('99', true)).toMatchObject({ stage: 'in_transit' });
    const value = copy(); value.result[0]!.signed = false;
    value.result[0]!.routes = [{ ...value.result[0]!.routes[0]!, opCode: 'NEW_CODE', remark: 'Unrecognized movement' }];
    expect(parse(value, NUMBER)).toMatchObject({ status: 'unknown', last_status_text: 'Unrecognized movement' });
    expect(parse(value, NUMBER).events?.[0]!.stage).toBeUndefined();
    value.result[0]!.expressState = '99';
    expect(parse(value, NUMBER).status).toBe('in_transit');
    value.result[0]!.routes[0]!.opCode = '204';
    expect(parse(value, NUMBER).status).toBe('out_for_delivery');
  });

  it('drops proof-access rows and personal detail fields', () => {
    const value = copy();
    value.result[0]!.routes[0]!.remark = 'Collected <a id="opr_phone" href="tel:000000000">Synthetic Person</a><script>private()</script>';
    value.result[0]!.routes[5]!.remark = 'Delivered to Synthetic Person';
    value.result[0]!.routes.push({ ...value.result[0]!.routes[5]!, remark: '<a href="https://example.invalid/private">AWB Info &amp; POD</a>', scanDateTime: '' });
    const result = parse({ ...value, recipient: 'Synthetic Person', proof: 'https://example.invalid/private' }, NUMBER);
    expect(result.events).toHaveLength(6);
    expect(JSON.stringify(result)).not.toMatch(/Synthetic Person|private|opr_phone|zoneCode|promiseTime|waybillNo/);
  });

  it('keeps the English name of a site the English remark also names in Chinese', () => {
    const value = copy(); const routes = value.result[0]!.routes;
    routes[2]!.remark = 'The shipment has arrived at 【Sample Town】 and is ready for transportation to 【样本中转场99R（ZZ Sample Gateway 99R ）】';
    routes[3]!.remark = 'Arrived at 【样本营业点(Sample Point)】, then 【样本站】 and 【样本（站）】';
    const events = parse(value, NUMBER).events!;
    expect(events[3]).toMatchObject({
      description: 'The shipment has arrived at 【Sample Town】 and is ready for transportation to 【ZZ Sample Gateway 99R】',
      provider_code: fixture.result[0]!.routes[2]!.opCode,
    });
    // A site without an English name keeps its Chinese one.
    expect(events[2]?.description).toBe('Arrived at 【Sample Point】, then 【样本站】 and 【样本（站）】');
    // The first site a remark names is its scan's.
    expect(events[3]?.location).toBe('Sample Town');
    expect(events[2]?.location).toBe('Sample Point');
  });

  it("keeps neither a courier's name and number nor a service point's address", () => {
    const value = copy(); const routes = value.result[0]!.routes;
    routes[2]!.remark = 'The shipment has arrived at【Sample Service Point，Address：样本区样本路1号A1-A9）】';
    routes[3]!.remark = 'Arrived at 【样本营业点（Sample Point，Address：样本路2号）】';
    routes[1]!.remark = 'The shipment has been handed over to and is being delivered by 样本人 (contact number: 00000000000. '
      + 'Please answer the call at ease as your privacy is properly protected by "safety call"!)';
    const events = parse(value, NUMBER).events!;
    expect(events[3]).toMatchObject({ description: 'The shipment has arrived at【Sample Service Point】', location: 'Sample Service Point' });
    expect(events[2]).toMatchObject({ description: 'Arrived at 【Sample Point】', location: 'Sample Point' });
    expect(events[4]?.description).toBe('The shipment has been handed over to and is being delivered by the courier');
    expect(JSON.stringify(events)).not.toMatch(/样本人|样本路|样本区|contact|00000/);
  });

  it('names no place for a remark about a person, a number in brackets or a delivery', () => {
    const value = copy(); const routes = value.result[0]!.routes;
    routes[2]!.remark = 'Out for delivery by courier 【Synthetic Person】';
    routes[3]!.remark = 'About 【120】 km to the next station';
    routes[1]!.remark = 'Shipment loaded at 【Sample Hub】, prepare to send to next station';
    const events = parse(value, NUMBER).events!;
    expect(events[3]).not.toHaveProperty('location');
    expect(events[2]).not.toHaveProperty('location');
    expect(events[4]?.location).toBe('Sample Hub');
    expect(events[0]).not.toHaveProperty('location');
  });

  it('names the place a remark waits in transit at without brackets, town first, and no place for a country given twice', () => {
    const value = copy(); const routes = value.result[0]!.routes;
    routes[2]!.remark = 'Shipment in transit at AU,SAMPLE TOWN, please wait in patience';
    routes[3]!.remark = 'Shipment in transit at AU,AU, please wait in patience';
    routes[1]!.remark = 'The shipment has arrived at the transit place【AU,AU】, flight arrival';
    const events = parse(value, NUMBER).events!;
    expect(events[3]).toMatchObject({ description: 'Shipment in transit at AU,SAMPLE TOWN, please wait in patience', location: 'SAMPLE TOWN, AU' });
    expect(events[2]).toMatchObject({ description: 'Shipment in transit at AU,AU, please wait in patience' });
    expect(events[2]).not.toHaveProperty('location');
    expect(events[4]).not.toHaveProperty('location');
    // An operation centre's departure and arrival name it without brackets; another code's remark names none so.
    Object.assign(routes[2]!, { opCode: '302', remark: 'The shipment has departed from 样本国际件操作中心 ,has been sent to CN Sample Province Sample Parcels Center' });
    Object.assign(routes[3]!, { opCode: '305', remark: 'The shipment has arrived atCN Sample Province Sample Parcels Center' });
    Object.assign(routes[1]!, { opCode: '31', remark: 'The shipment has arrived at the next station' });
    routes[0]!.remark = 'Shipment in transit at US,EX,Sample Town, please wait in patience';
    routes[4]!.remark = 'Shipment in transit at Sample Town, please wait in patience';
    const centres = parse(value, NUMBER).events!;
    expect(centres[3]).toMatchObject({ description: routes[2]!.remark, location: '样本国际件操作中心' });
    expect(centres[2]).toMatchObject({ description: routes[3]!.remark, location: 'CN Sample Province Sample Parcels Center' });
    expect(centres[4]).not.toHaveProperty('location');
    expect(centres[5]).toMatchObject({ description: routes[0]!.remark, location: 'Sample Town, EX, US' });
    expect(centres[1]).toMatchObject({ description: routes[4]!.remark, location: 'Sample Town' });
  });

  it('bounds retained and inspected scans, deduplicates exact repeats and sorts like the portal', () => {
    const value = copy(); value.result[0]!.routes.reverse(); value.result[0]!.routes.push(value.result[0]!.routes[0]!);
    expect(parse(value, NUMBER).events).toHaveLength(6);
    expect(parse(value, NUMBER).history_truncated).toBeUndefined();
    const full = Array.from({ length: 100 }, (_, i) => ({ ...value.result[0]!.routes[0]!, remark: `Movement ${i}`, opCode: '31' }));
    value.result[0]!.routes = full;
    expect(parse(value, NUMBER).events).toHaveLength(100);
    expect(parse(value, NUMBER).history_truncated).toBeUndefined();
    value.result[0]!.routes = Array.from({ length: 110 }, (_, i) => ({ ...full[0]!, remark: `Movement ${i}` }));
    expect(parse(value, NUMBER)).toMatchObject({ history_truncated: true });
    expect(parse(value, NUMBER).events).toHaveLength(100);
    value.result[0]!.routes = Array.from({ length: 501 }, () => value.result[0]!.routes[0]!);
    expect(() => parse(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});
