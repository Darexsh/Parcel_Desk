import { describe, expect, it, vi } from 'vitest';
import { sameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { JdLogisticsTracker } from './adapter.js';
import { parseJdLogistics } from './parser.js';

const NUMBER = 'JD0000000000001';
const history = () => ({ code: 1, data: [{ waybillNo: NUMBER, waybillNum: 1,
  receiverName: 'PRIVATE_RECIPIENT', wayBillTrackItemDtoList: [{ waybillNo: NUMBER,
    podUrl: 'PRIVATE_SIGNATURE', trackNodeList: [
      { operatorTime: '2026-09-03 10:00:00', operatorDesc: 'Delivered', routeCityName: 'Example City', routeCountry: 'Example Country', timeZone: 'CST', hasPodUrl: 1 },
      { operatorTime: '2026-09-02 12:00:00', operatorDesc: 'Arrived at sorting facility', routeCityName: 'Example Hub', timeZone: 'CST' },
    ] }] }] });

describe('JD Logistics international projection', () => {
  it('binds one waybill and preserves carrier order and unresolved clocks', () => {
    const result = parseJdLogistics(history(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null,
      last_update_local: '2026-09-03T10:00:00' });
    expect(result.events).toHaveLength(2);
    expect(result.events?.[0]).toMatchObject({ local_time: '2026-09-03T10:00:00', location: 'Example City, Example Country', stage_source: 'wording:language' });
    expect(result.events?.every(event => !event.time)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('rejects a different parent and ambiguous pieces', () => {
    const wrong = history(); wrong.data[0]!.waybillNo = 'JD0000000000002';
    expect(() => parseJdLogistics(wrong, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const multi = history(); multi.data[0]!.wayBillTrackItemDtoList.push(multi.data[0]!.wayBillTrackItemDtoList[0]!);
    expect(() => parseJdLogistics(multi, NUMBER)).toThrow('multiple waybills');
    const partial = history(); partial.data[0]!.waybillNum = 2;
    expect(() => parseJdLogistics(partial, NUMBER)).toThrow('multiple waybills');
  });

  it('binds a single child waybill through its requested parent reference', () => {
    const reply = history(); reply.data[0]!.wayBillTrackItemDtoList[0]!.waybillNo = 'JD0000000000002';
    expect(parseJdLogistics(reply, NUMBER).events).toHaveLength(2);
  });

  it('keeps missing international history inconclusive, as JD\'s own answer rather than an outage', () => {
    const answer = expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' });
    expect(() => parseJdLogistics({ code: 1, data: [] }, NUMBER)).toThrow(answer);
    const unlisted = history(); unlisted.data[0]!.waybillNum = 0;
    expect(() => parseJdLogistics(unlisted, NUMBER)).toThrow(answer);
    const empty = history(); empty.data[0]!.wayBillTrackItemDtoList[0]!.trackNodeList = [];
    expect(() => parseJdLogistics(empty, NUMBER)).toThrow(answer);
    expect(() => parseJdLogistics({ code: 0, data: [] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects malformed dates and scan text instead of silently dropping rows', () => {
    const malformed = history(); malformed.data[0]!.wayBillTrackItemDtoList[0]!.trackNodeList[0]!.operatorTime = '2026-02-30 10:00:00';
    expect(() => parseJdLogistics(malformed, NUMBER)).toThrow('invalid scan clock');
    const unworded = history(); unworded.data[0]!.wayBillTrackItemDtoList[0]!.trackNodeList[0]!.operatorDesc = '';
    expect(() => parseJdLogistics(unworded, NUMBER)).toThrow('incomplete scan');
    const dateOnly = history(); dateOnly.data[0]!.wayBillTrackItemDtoList[0]!.trackNodeList[0]!.operatorTime = '2026-09-03';
    expect(() => parseJdLogistics(dateOnly, NUMBER)).toThrow('invalid scan clock');
  });

  it('uses explicit scan offsets and leaves unknown wording unclassified', () => {
    const reply = history(); reply.data[0]!.wayBillTrackItemDtoList[0]!.trackNodeList[0]!.operatorTime = '2026-09-03T10:00:00+08:00';
    reply.data[0]!.wayBillTrackItemDtoList[0]!.trackNodeList[0]!.operatorDesc = 'Unrecognized operation';
    const result = parseJdLogistics(reply, NUMBER);
    expect(result.last_update).toBe('2026-09-03T10:00:00+08:00');
    expect(result.status).toBe('unknown'); expect(result.current_stage).toBeUndefined();
  });

  describe('scan instants from the epoch and declared zone', () => {
    type Node = Record<string, unknown>;
    const scan = (wall: string, timeZone: string, epochAt: string, extra: Node = {}): Node => ({
      operatorTime: wall, operatorDesc: 'Arrived at sorting facility', timeZone, operationTimestamp: Date.parse(epochAt), ...extra });
    const parse = (...nodes: Node[]) => {
      const reply = history(); reply.data[0]!.wayBillTrackItemDtoList[0]!.trackNodeList = nodes as never;
      return parseJdLogistics(reply, NUMBER);
    };

    it('dates a scan whose epoch reads as its wall clock at the declared offset, in that offset', () => {
      const result = parse(
        scan('2026-09-03 10:00:00', 'UTC+2', '2026-09-03T10:00:00+02:00', { routeCityName: 'Example City', routeProvinceName: 'Germany' }),
        scan('2026-09-01 08:00:00', 'UTC+8', '2026-09-01T08:00:00+08:00'),
        scan('2026-08-31 10:30:00', 'GMT-03:30', '2026-08-31T10:30:00-03:30'),
      );
      expect(result.events?.map(event => event.time)).toEqual(['2026-09-03T10:00:00+02:00', '2026-09-01T08:00:00+08:00', '2026-08-31T10:30:00-03:30']);
      expect(result.last_update).toBe('2026-09-03T10:00:00+02:00');
      expect(result.last_update_local).toBeUndefined();
    });

    it('dates a Saudi scan only at the offset Saudi Arabia keeps', () => {
      const saudi = { routeCityName: 'Example Province', routeProvinceName: 'Saudi Arabia' };
      expect(parse(scan('2026-09-03 10:00:00', 'UTC+3', '2026-09-03T10:00:00+03:00', saudi)).events?.[0]?.time).toBe('2026-09-03T10:00:00+03:00');
      expect(parse(scan('2026-09-03 10:00:00', 'UTC+3', '2026-09-03T10:00:00+03:00', { routeCountry: '沙特' })).events?.[0]?.time).toBe('2026-09-03T10:00:00+03:00');
      expect(parse(scan('2026-09-03 10:00:00', 'UTC+8', '2026-09-03T10:00:00+08:00', saudi)).events?.[0]).toMatchObject({ local_time: '2026-09-03T10:00:00' });
    });

    it('dates an Egyptian summer scan at +3, not at its winter +2', () => {
      const egypt = { routeCityName: 'Example Governorate', routeProvinceName: 'Egypt' };
      expect(parse(scan('2026-07-15 10:00:00', 'UTC+3', '2026-07-15T10:00:00+03:00', egypt)).events?.[0]?.time).toBe('2026-07-15T10:00:00+03:00');
      expect(parse(scan('2026-07-15 10:00:00', 'UTC+2', '2026-07-15T10:00:00+02:00', egypt)).events?.[0]).toMatchObject({ local_time: '2026-07-15T10:00:00' });
    });

    it('dates a scan whose city is a city-state or region at that place\'s offset', () => {
      expect(parse(scan('2026-09-03 10:00:00', 'UTC+8', '2026-09-03T10:00:00+08:00', { routeCityName: 'Macau' })).events?.[0]?.time).toBe('2026-09-03T10:00:00+08:00');
      expect(parse(scan('2026-09-03 10:00:00', 'UTC+8', '2026-09-03T10:00:00+08:00', { routeCityName: '新加坡' })).events?.[0]?.time).toBe('2026-09-03T10:00:00+08:00');
    });

    it('orders a fully dated history by instant and keeps ties in JD\'s order', () => {
      const result = parse(
        scan('2026-09-02 12:00:00', 'UTC+8', '2026-09-02T12:00:00+08:00', { operatorDesc: 'Older' }),
        scan('2026-09-02 09:00:00', 'UTC+3', '2026-09-02T09:00:00+03:00', { operatorDesc: 'Newest' }),
        scan('2026-09-01 10:00:00', 'UTC', '2026-09-01T10:00:00Z', { operatorDesc: 'Tie, listed first' }),
        scan('2026-09-01 10:00:00', 'UTC', '2026-09-01T10:00:00Z', { operatorDesc: 'Tie, listed second' }),
      );
      expect(result.events?.map(event => event.description)).toEqual(['Newest', 'Older', 'Tie, listed first', 'Tie, listed second']);
      expect(result.last_status_text).toBe('Newest');
    });

    it.each([
      ['an epoch that reads the wall clock in another zone', scan('2026-09-03 10:00:00', 'UTC+2', '2026-09-03T10:00:00+08:00')],
      ['no epoch', scan('2026-09-03 10:00:00', 'UTC+2', 'invalid')],
      ['an epoch as text', { ...scan('2026-09-03 10:00:00', 'UTC+2', '2026-09-03T10:00:00+02:00'), operationTimestamp: String(Date.parse('2026-09-03T08:00:00Z')) }],
      ['a zone name instead of an offset', scan('2026-09-03 10:00:00', 'CST', '2026-09-03T10:00:00+08:00')],
      ['an impossible declared offset', scan('2026-09-03 10:00:00', 'UTC+15', '2026-09-03T10:00:00+15:00')],
      ['a declared offset the scan\'s country does not keep', scan('2026-09-03 10:00:00', 'UTC+8', '2026-09-03T10:00:00+08:00', { routeProvinceName: 'Germany' })],
      ['a wall clock its country skips', scan('2026-03-29 02:30:00', 'UTC+1', '2026-03-29T02:30:00+01:00', { routeCountry: 'Germany' })],
      ['a wall clock its country repeats', scan('2026-10-25 02:30:00', 'UTC+1', '2026-10-25T02:30:00+01:00', { routeCityName: 'Example City', routeProvinceName: 'Germany' })],
      ['a declared offset the country named in Chinese does not keep', scan('2026-09-03 10:00:00', 'UTC+8', '2026-09-03T10:00:00+08:00', { routeCountry: '德国' })],
      ['a declared offset Saudi Arabia does not keep', scan('2026-09-03 10:00:00', 'UTC+8', '2026-09-03T10:00:00+08:00', { routeCountry: '沙特阿拉伯' })],
      ['a country spanning several zones', scan('2026-09-03 10:00:00', 'UTC+7', '2026-09-03T10:00:00+07:00', { routeCountry: '印度尼西亚' })],
      ['a country spanning several zones, named in English', scan('2026-09-03 10:00:00', 'UTC-4', '2026-09-03T10:00:00-04:00', { routeProvinceName: 'United States' })],
      ['a country with several clocks', scan('2026-09-03 10:00:00', 'UTC+3', '2026-09-03T10:00:00+03:00', { routeProvinceName: 'Russia' })],
      ['a country field read neither way', scan('2026-09-03 10:00:00', 'UTC+8', '2026-09-03T10:00:00+08:00', { routeCountry: '示例国' })],
      ['a country written in a form not read here', scan('2026-09-03 10:00:00', 'UTC+8', '2026-09-03T10:00:00+08:00', { routeCityName: 'Riyadh', routeProvinceName: 'KSA' })],
      ['a country abbreviation beside a city', scan('2026-09-03 10:00:00', 'UTC+8', '2026-09-03T10:00:00+08:00', { routeCityName: 'Los Angeles', routeProvinceName: 'USA' })],
      ['a city-state its declared offset does not suit', scan('2026-09-03 10:00:00', 'UTC+3', '2026-09-03T10:00:00+03:00', { routeCityName: '新加坡' })],
      ['a province and city but no country', scan('2026-09-03 10:00:00', 'UTC+8', '2026-09-03T10:00:00+08:00', { routeCityName: '示例市', routeProvinceName: '示例省' })],
    ])('keeps the wall clock local with %s', (_, node) => {
      const result = parse(node);
      expect(result.events?.[0]).toMatchObject({ local_time: (node.operatorTime as string).replace(' ', 'T') });
      expect(result.events?.[0]?.time).toBeUndefined();
      expect(result.last_update).toBeNull();
    });

    it('keeps JD\'s order when any scan stays local', () => {
      const result = parse(
        scan('2026-09-02 12:00:00', 'UTC+8', '2026-09-02T12:00:00+08:00', { operatorDesc: 'Listed first' }),
        scan('2026-09-02 09:00:00', 'CST', '2026-09-02T09:00:00+08:00', { operatorDesc: 'Local' }),
        scan('2026-09-02 10:00:00', 'UTC+3', '2026-09-02T10:00:00+03:00', { operatorDesc: 'Dated, newer' }),
      );
      expect(result.events?.map(event => event.description)).toEqual(['Listed first', 'Local', 'Dated, newer']);
      expect(result.last_update).toBe('2026-09-02T12:00:00+08:00');
    });
  });

  it.each(['+99:00', '+02:99', '+14:01', '-1500'])('rejects an impossible offset: %s', offset => {
    const reply = history(); reply.data[0]!.wayBillTrackItemDtoList[0]!.trackNodeList[0]!.operatorTime = `2026-09-03T10:00:00${offset}`;
    expect(() => parseJdLogistics(reply, NUMBER)).toThrow('invalid scan offset');
  });

  it('stages scans by their operation code and keeps it', () => {
    const reply = history();
    const nodes = reply.data[0]!.wayBillTrackItemDtoList[0]!.trackNodeList as Record<string, unknown>[];
    nodes[0] = { ...nodes[0], operatorDesc: 'Your package has been signed for, thank you for choosing JD Logistics!', operationCode: 'DLV' };
    nodes[1] = { ...nodes[1], operatorDesc: 'Your package has begun clearance', operationCode: 'CCL' };
    nodes.push({ operatorTime: '2026-09-01 08:00:00', operatorDesc: 'Something new', operationCode: 'ZZZ', timeZone: 'UTC+8' });
    const result = parseJdLogistics(reply, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map' });
    expect(result.events?.map(event => [event.provider_code, event.stage, event.stage_source])).toEqual([
      ['DLV', 'delivered', 'carrier_map'], ['CCL', 'customs', 'carrier_map'], ['ZZZ', undefined, undefined],
    ]);
  });

  it('stages the steps of JD\'s warehouse abroad and the partner steps it relays', () => {
    const reply = history();
    const nodes = reply.data[0]!.wayBillTrackItemDtoList[0]!.trackNodeList as Record<string, unknown>[];
    nodes.splice(0, nodes.length, ...[
      ['DMPU', 'Arrived at GOFO Regional Hub'], ['1060', 'Handed over to Carrier'], ['3052', 'Departed from Warehouse.'],
      ['3043', 'Weighed at Warehouse.'], ['3041', 'Picking Completed.'], ['SRRF3P', 'Shipping Label Created'], ['COSH', 'Order Created.'],
    ].map(([operationCode, operatorDesc], index) => ({ operatorTime: `2026-09-0${9 - index} 08:00:00`, operatorDesc, operationCode })));
    const result = parseJdLogistics(reply, NUMBER);
    expect(result.events?.map(event => [event.provider_code, event.stage, event.stage_source])).toEqual([
      ['DMPU', 'in_transit', 'carrier_map'], ['1060', 'in_transit', 'carrier_map'], ['3052', 'in_transit', 'carrier_map'],
      ['3043', 'accepted', 'carrier_map'], ['3041', 'accepted', 'carrier_map'], ['SRRF3P', 'registered', 'carrier_map'],
      ['COSH', 'registered', 'carrier_map'],
    ]);
    // The partner's other steps under SRRF3P are read by their wording.
    nodes[0] = { ...nodes[0], operationCode: 'SRRF3P', operatorDesc: 'Delivered' };
    expect(parseJdLogistics(reply, NUMBER)).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language' });
    // GOFO loads the parcel at a hub under JD's courier code, before its delivery station.
    nodes[0] = { ...nodes[0], operationCode: 'DMLMLS', operatorDesc: 'Loaded on Vehicle' };
    expect(parseJdLogistics(reply, NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map' });
  });

  it('stages a line from China to GOFO\'s last mile by its codes', () => {
    const reply = history();
    const nodes = reply.data[0]!.wayBillTrackItemDtoList[0]!.trackNodeList as Record<string, unknown>[];
    const steps = [
      ['DMLMOP', 'Out for Delivery'], ['DMAPR', 'Arrived at GOFO Delivery Station'], ['DMLMIT', 'In Transit to Next Facility'],
      ['DMSCD', 'Loaded on Vehicle'], ['DMLMLW', 'Arrived at GOFO Regional Hub'], ['CXLMHL', 'Handover to local carrier'],
      ['CXLHCP', 'Cleanrance agency picked'], ['CXCCRS', 'Customs clearance completed'], ['CXLHAP', 'Arrive at destination port'],
      ['CXLHDP', 'Departure from origin port'], ['CXCCOE', 'Customs released from origin port'], ['CXCCAP', 'Arrive at airport'],
      ['CXWHSO', 'Departed from Warehouse.'], ['CXWHSP', 'Consolidation Completed'], ['CXWHRC', 'Weighed at Warehouse'],
      ['ECWHRC', 'Arrived at Warehouse'], ['FMPU', 'Shipment Picked up'], ['COSH', 'Order Created.'],
    ];
    nodes.splice(0, nodes.length, ...steps.map(([operationCode, operatorDesc], index) => ({
      operatorTime: `2026-09-${String(30 - index).padStart(2, '0')} 08:00:00`, operatorDesc, operationCode })));
    const result = parseJdLogistics(reply, NUMBER);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map' });
    expect(result.events?.map(event => event.stage)).toEqual([
      'out_for_delivery', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit',
      'in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit',
      'in_transit', 'accepted', 'accepted', 'accepted', 'accepted', 'registered',
    ]);
    expect(result.events?.filter(event => event.provider_code !== 'DMSCD').every(event => event.stage_source === 'carrier_map')).toBe(true);
  });

  it('keeps the partner\'s number out of the departure\'s wording and gives it as the delivery number', () => {
    const reply = history();
    const nodes = reply.data[0]!.wayBillTrackItemDtoList[0]!.trackNodeList as Record<string, unknown>[];
    nodes[1] = { ...nodes[1], operationCode: 'CXWHSO', operatorDesc: 'Departed from Warehouse.Tracking no GFUS01000000000001' };
    const result = parseJdLogistics(reply, NUMBER);
    expect(result.events?.[1]).toMatchObject({ description: 'Departed from Warehouse.', provider_code: 'CXWHSO', stage: 'in_transit' });
    expect(result.delivery_tracking_number).toBe('GFUS01000000000001');
    expect(JSON.stringify({ ...result, delivery_tracking_number: undefined })).not.toContain('GFUS');
    // A row holding nothing but the number is left out.
    nodes.push({ operatorTime: '2026-09-01 08:00:00', operatorDesc: 'Tracking no GFUS01000000000001', timeZone: 'CST' });
    expect(parseJdLogistics(reply, NUMBER).events).toHaveLength(2);
    // Two numbers, or JD's own, give no delivery number.
    nodes[2] = { ...nodes[2], operatorDesc: 'Departed from Warehouse.Tracking no GFUS01000000000002' };
    expect(parseJdLogistics(reply, NUMBER).delivery_tracking_number).toBeUndefined();
    nodes.splice(2, 1);
    nodes[1] = { ...nodes[1], operatorDesc: `Departed from Warehouse.Tracking no ${NUMBER}` };
    expect(parseJdLogistics(reply, NUMBER)).not.toHaveProperty('delivery_tracking_number');
    // Other wording ending in "Tracking no…" is not a number.
    nodes[1] = { ...nodes[1], operatorDesc: 'Tracking not available' };
    expect(parseJdLogistics(reply, NUMBER).events?.[1]?.description).toBe('Tracking not available');
  });

  it('lets a stored departure that still holds the partner\'s number take the scan without it', () => {
    const policy = sameInstantIdentityPolicy('jd-logistics', { supportsScanMatching: true });
    const stored = { stage: 'in_transit', location: 'Example City', description: 'Departed from Warehouse.Tracking no GFUS01000000000001',
      providerCode: 'CXWHSO' };
    const incoming = { ...stored, description: 'Departed from Warehouse.' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.(incoming, { ...stored, providerCode: 'CXWHSP' })).toBe(false);
  });

  it('drops the courier\'s name and phone from the out-for-delivery wording', () => {
    const reply = history();
    const nodes = reply.data[0]!.wayBillTrackItemDtoList[0]!.trackNodeList as Record<string, unknown>[];
    nodes[0] = { ...nodes[0], operationCode: 'DMLMLS',
      operatorDesc: 'Your package is on the way; the courier is 【EXP-Jane Example Courier，500000000】, please be   patient.' };
    const result = parseJdLogistics(reply, NUMBER);
    expect(result.events?.[0]).toMatchObject({ description: 'Your package is on the way; please be patient.', stage: 'out_for_delivery' });
    expect(result.last_status_text).toBe('Your package is on the way; please be patient.');
    expect(JSON.stringify(result)).not.toMatch(/Jane|500000000/);
    // Bracketed places stay.
    nodes[0] = { ...nodes[0], operationCode: 'VUVU', operatorDesc: 'Your package has been unloaded at【Example Hub】' };
    expect(parseJdLogistics(reply, NUMBER).events?.[0]?.description).toBe('Your package has been unloaded at【Example Hub】');
  });

  it('names each scan\'s country in English, whichever field gives it', () => {
    const reply = history();
    const nodes = reply.data[0]!.wayBillTrackItemDtoList[0]!.trackNodeList as Record<string, unknown>[];
    const at = (place: Record<string, unknown>) => {
      nodes[0] = { operatorTime: '2026-09-03 10:00:00', operatorDesc: 'Delivered', ...place };
      return parseJdLogistics(reply, NUMBER).events?.[0]?.location;
    };
    expect(at({ routeCityName: 'Example Province', routeProvinceName: 'Saudi Arabia', routeCountry: '沙特阿拉伯' })).toBe('Example Province, Saudi Arabia');
    expect(at({ routeCityName: 'Example Province', routeProvinceName: 'Saudi Arabia' })).toBe('Example Province, Saudi Arabia');
    expect(at({ routeCityName: 'Example Province', routeCountry: '沙特阿拉伯' })).toBe('Example Province, Saudi Arabia');
    expect(at({ routeCityName: 'Example District', routeCountry: '中国香港' })).toBe('Example District, Hong Kong SAR China');
    expect(at({ routeCityName: 'Singapore', routeCountry: '新加坡' })).toBe('Singapore');
    // A city that is the region itself stands alone.
    expect(at({ routeCityName: 'Hong Kong', routeCountry: '中国香港' })).toBe('Hong Kong');
    expect(at({ routeCityName: '香港', routeCountry: '香港' })).toBe('香港');
    expect(at({ routeCityName: 'Macao', routeCountry: '澳门' })).toBe('Macao');
    expect(at({ routeCityName: 'Macau', routeCountry: '中国澳门' })).toBe('Macau');
    expect(at({ routeCityName: 'Example Parish', routeCountry: '澳门' })).toBe('Example Parish, Macao SAR China');
    // The usual Chinese short forms.
    expect(['沙特', '阿联酋', '印尼', '澳洲', '中国大陆'].map(country => at({ routeCityName: 'Example City', routeCountry: country }))).toEqual([
      'Example City, Saudi Arabia', 'Example City, United Arab Emirates', 'Example City, Indonesia', 'Example City, Australia', 'Example City, China']);
    // A country read neither way stays as written; a province or a province code adds nothing.
    expect(at({ routeCityName: 'Example City', routeProvinceName: 'Example Province', routeCountry: '示例国' })).toBe('Example City, 示例国');
    expect(at({ routeCityName: 'Example City', routeProvinceName: 'IN' })).toBe('Example City');
    expect(at({ routeProvinceName: 'Germany' })).toBe('Germany');
    expect(at({})).toBeUndefined();
  });

  it('lets a stored row that still holds the courier\'s contact take the redacted scan', () => {
    const policy = sameInstantIdentityPolicy('jd-logistics', { supportsScanMatching: true });
    const stored = { stage: 'in_transit', location: 'Example Province',
      description: 'Your package is on the way; the courier is 【EXP-Jane Example Courier，500000000】, please be   patient.', providerCode: '' };
    const incoming = { stage: 'out_for_delivery', location: 'Example Province',
      description: 'Your package is on the way; please be patient.', providerCode: 'DMLMLS' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.(incoming, { ...stored, location: 'Another Province' })).toBe(false);
    expect(policy?.matches?.(incoming, { ...stored, description: 'Your package has been unloaded at【Example Hub】' })).toBe(false);
  });

  it('lets a stored row holding the courier\'s contact take a parsed scan at its English location', () => {
    const policy = sameInstantIdentityPolicy('jd-logistics', { supportsScanMatching: true });
    const contact = 'Your package is on the way; the courier is 【EXP-Jane Example Courier，500000000】, please be patient.';
    const reply = history();
    reply.data[0]!.wayBillTrackItemDtoList[0]!.trackNodeList = [{ operatorTime: '2026-09-03 10:00:00', operatorDesc: contact,
      operationCode: 'DMLMLS', routeCityName: 'Example Province', routeCountry: '沙特阿拉伯', timeZone: 'UTC+3',
      operationTimestamp: Date.parse('2026-09-03T10:00:00+03:00') }] as never;
    const event = parseJdLogistics(reply, NUMBER).events![0]!;
    expect(event).toMatchObject({ time: '2026-09-03T10:00:00+03:00', location: 'Example Province, Saudi Arabia' });
    const incoming = { stage: event.stage!, description: event.description!, location: event.location!, providerCode: event.provider_code! };
    const stored = { stage: 'in_transit', description: contact, location: 'Example Province, Saudi Arabia', providerCode: '' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.(incoming, { ...stored, location: 'Example Province, 沙特阿拉伯' })).toBe(false);
  });

  it('lets a scan stored before its code was kept take the code and its stage', () => {
    const policy = sameInstantIdentityPolicy('jd-logistics', { supportsScanMatching: true });
    expect(sameInstantIdentityPolicy('jd-logistics')).toBeUndefined();
    const stored = { stage: '', description: 'Your package has been signed for', location: 'Example City', providerCode: '' };
    const incoming = { ...stored, stage: 'delivered', providerCode: 'DLV' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    for (const different of [{ ...stored, providerCode: 'CCL' }, { ...stored, description: 'Order Created.' }, { ...stored, location: 'Another City' }]) {
      expect(policy?.matches?.(incoming, different)).toBe(false);
    }
    expect(policy?.matches?.({ ...incoming, providerCode: '' }, stored)).toBe(false);
  });

  it('sends the official anonymous request with the caller signal', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(history())));
    await new JdLogisticsTracker({ fetcher }).fetch(NUMBER, { budgetMs: 500 });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://lop-proxy.ochama.com/WayBillApi/queryOrderTraceBatchV1');
    expect(JSON.parse(String(init?.body))).toEqual([{ magicNoList: [NUMBER], clientIp: '$cooMrdGatewayIp$', lang: 'en', timeZone: 'UTC' }]);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('treats endpoint disappearance as transport failure', async () => {
    await expect(new JdLogisticsTracker({ fetcher: async () => new Response('', { status: 404 }) }).fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'transport' });
  });
});
