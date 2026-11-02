import { describe, expect, it } from 'vitest';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { STAGES } from '../../core/status/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import delivered from './fixtures/delivered.json' with { type: 'json' };
import fixture from './fixtures/service-point.en.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };
import { DhlEcommerceEsTracker, adapter } from './adapter.js';
import { normalizeDhlEcommerceEsNumber, parseDhlEcommerceEs } from './parser.js';
import { dhlEcommerceEsStatus, dhlEcommerceEsSummaryStage } from './status.js';

const NUMBER = '2800000007';
const INBOUND = 'CC000000005DE';
const POINT = 'EXAMPLE NEWSAGENT\nCALLE DE EJEMPLO 1\n00000 EXAMPLEVILLE';
const REJECTED = '<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Please consult with your administrator.</body></html>';
const clone = () => structuredClone(fixture);
const environment = (fetcher: typeof fetch) => ({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {}, fetcher });
const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

describe('DHL eCommerce Iberia parser', () => {
  it('reads a parcel collected at a ServicePoint, newest scan first, on local clocks', () => {
    const result = normalizeCarrierResult(parseDhlEcommerceEs(clone(), NUMBER));
    expect(result.status).toBe('delivered');
    expect(result.current_stage).toBe('delivered');
    expect(result.last_status_text).toBe('Parcel picked up by recipient');
    expect(result.last_update).toBeNull();
    expect(result.last_update_local).toBe('2026-03-12T10:15:00');
    expect(result.delivered_at).toBeUndefined();
    expect(result.events).toHaveLength(10);
    expect(result.events?.[0]).toEqual({ provider_code: 'RS', description: 'Parcel picked up by recipient', location: 'Madrid',
      local_time: '2026-03-12T10:15:00', stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events?.[7]).toMatchObject({ provider_code: 'ZZZ', description: 'Arrived at Madrid', location: 'Madrid' });
    expect(result.events?.at(-1)).toEqual({ provider_code: 'DOC', description: 'Shipment data received',
      local_time: '2026-03-10T19:45:00', stage: 'registered', stage_source: 'carrier_map' });
    expect(result.events?.map((event) => event.stage)).toEqual(['delivered', 'ready_for_pickup', 'in_transit', 'in_transit', 'in_transit',
      'failed_attempt', 'out_for_delivery', 'in_transit', 'in_transit', 'registered']);
    expect(result.events?.every((event) => event.time === undefined)).toBe(true);
  });

  it('keeps the ServicePoint a parcel was collected from, the weight and none of the references', () => {
    const result = parseDhlEcommerceEs(clone(), NUMBER);
    expect(result.pickup_point).toBe(POINT);
    const output = JSON.stringify(result);
    for (const dropped of ['ES-0000000', 'Servicepoint"', '09:00 - 14:00', 'REF-0000001', '1000001', 'JJD0000', '28 6000000007']) {
      expect(output).not.toContain(dropped);
    }
    expect(Object.keys(result).sort()).toEqual(['current_stage', 'current_stage_source', 'events', 'expected_delivery',
      'last_status_text', 'last_update', 'last_update_local', 'pickup_point', 'status', 'weight_kg']);
    expect(result.weight_kg).toBe(2);
  });

  it('gives the ServicePoint its address while the parcel waits there', () => {
    const waiting = clone();
    waiting.Tracking = waiting.Tracking.slice(1);
    waiting.DeliveredInServicePoint = false;
    const result = normalizeCarrierResult(parseDhlEcommerceEs(waiting, NUMBER));
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'ready_for_pickup', pickup_point: POINT });
    // Without its street or town the ServicePoint is its name alone.
    for (const field of ['Address', 'Location'] as const) {
      const partial = structuredClone(waiting);
      partial.ServicePoint[field] = ' ';
      expect(parseDhlEcommerceEs(partial, NUMBER).pickup_point).toBe('EXAMPLE NEWSAGENT');
    }
    const unzipped = structuredClone(waiting);
    unzipped.ServicePoint.ZipCode = '';
    expect(parseDhlEcommerceEs(unzipped, NUMBER).pickup_point).toBe('EXAMPLE NEWSAGENT\nCALLE DE EJEMPLO 1\nEXAMPLEVILLE');
    waiting.ServicePoint.Name = '   ';
    expect(parseDhlEcommerceEs(waiting, NUMBER).pickup_point).toBeUndefined();
  });

  it('names no ServicePoint before the parcel reaches it or after a delivery elsewhere', () => {
    const planned = clone();
    planned.Tracking = planned.Tracking.slice(3);
    expect(parseDhlEcommerceEs(planned, NUMBER).current_stage).toBe('in_transit');
    expect(parseDhlEcommerceEs(planned, NUMBER).pickup_point).toBeUndefined();
    // Collection needs the recipient's pickup scan and the shipment's word that it was delivered there.
    const unflagged = clone();
    unflagged.DeliveredInServicePoint = false;
    expect(parseDhlEcommerceEs(unflagged, NUMBER).pickup_point).toBeUndefined();
    expect(parseDhlEcommerceEs({ ...clone(), DeliveredInServicePoint: undefined }, NUMBER).pickup_point).toBeUndefined();
    const door = clone();
    door.Tracking[0] = { ...door.Tracking[0]!, Code: 'R', SolutionCode: 'REP', Description: 'Delivered' };
    expect(parseDhlEcommerceEs(door, NUMBER)).toMatchObject({ current_stage: 'delivered' });
    expect(parseDhlEcommerceEs(door, NUMBER).pickup_point).toBeUndefined();
    const doorstep = { ...structuredClone(delivered), DeliveredInServicePoint: true, ServicePoint: clone().ServicePoint };
    expect(parseDhlEcommerceEs(doorstep, INBOUND).pickup_point).toBeUndefined();
  });

  it('reads the weight in kilos and nothing else', () => {
    const payload = clone();
    for (const [weight, expected] of [['2,5', 2.5], [' 12 ', 12], [3, 3], ['0', undefined], ['', undefined], ['2 kg', undefined],
      ['-1', undefined], ['150000', undefined], [null, undefined]] as const) {
      (payload as { Weight: unknown }).Weight = weight;
      expect(parseDhlEcommerceEs(payload, NUMBER).weight_kg).toBe(expected);
    }
  });

  it('reads a door delivery with a depot scan that lost its code', () => {
    const result = parseDhlEcommerceEs(structuredClone(delivered), INBOUND.toLowerCase());
    expect(result.status).toBe('delivered');
    expect(result.last_status_text).toBe('Entregado');
    expect(result.events?.map((event) => event.stage)).toEqual(['delivered', 'out_for_delivery', 'in_transit', 'exception',
      'out_for_delivery', 'in_transit', 'in_transit', 'in_transit', 'registered']);
    expect(result.events?.[2]).toEqual({ description: 'Tránsito en Valencia', location: 'Valencia', local_time: '2026-03-17T07:35:00',
      stage: 'in_transit', stage_source: 'carrier_map' });
    expect(result.events?.at(-1)?.location).toBeUndefined();
    // CTT Express delivers it in Spain under its own label code.
    expect(result).toMatchObject({ weight_kg: 2, delivery_carrier: 'ctt-express', delivery_tracking_number: '0099990099990000000001' });
    for (const code of ['00999900999900000000', 'REF-0000002', 42]) {
      expect(parseDhlEcommerceEs({ ...structuredClone(delivered), ShippingCode: code }, INBOUND).delivery_carrier).toBeUndefined();
    }
    const asked = { ...structuredClone(delivered), ExpeditionNumber: '0099990099990000000001' };
    expect(parseDhlEcommerceEs(asked, '0099990099990000000001').delivery_tracking_number).toBeUndefined();
  });

  it('files arrangements, incidents and returns, and reopens a delivery a later round contradicts', () => {
    const scan = (Code: string, Description: string, Time: string, SolutionCode?: string) =>
      ({ Date: '20/03/2026', Time, Description, Code, ...(SolutionCode ? { SolutionCode } : {}), Town: 'Valencia' });
    const payload = clone();
    payload.Status = 0;
    payload.Tracking = [scan('EC', 'Delivery agreed with recipient 23/03/2026', '18:00'), scan('CR', 'Receiver closed: delivery not possible', '12:00', 'CLI'),
      scan('PC', 'Delivered, POD pending', '11:00', 'DHL'), scan('CH', 'Not delivered today: delivery expected for the next working day', '10:00', 'RET')];
    const reopened = parseDhlEcommerceEs(payload, NUMBER);
    expect(reopened).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Delivery agreed with recipient 23/03/2026' });
    expect(reopened.events?.map((event) => event.stage)).toEqual(['in_transit', 'failed_attempt', 'delivered', 'exception']);
    payload.Tracking = payload.Tracking.slice(2);
    expect(parseDhlEcommerceEs(payload, NUMBER)).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    payload.Tracking = [scan('RT', 'Shipment being returned to sender', '09:00', 'DEV'), scan('FA', 'Shipment with incidence', '08:00', 'DHL')];
    expect(parseDhlEcommerceEs(payload, NUMBER)).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Shipment being returned to sender' });
    payload.Tracking = [scan('ZZZ', 'Picked up', '08:00'), scan('BS', 'Parcel dropped off at DHL ServicePoint', '07:00')];
    const accepted = parseDhlEcommerceEs(payload, NUMBER);
    expect(accepted).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'Picked up Valencia' });
    expect(accepted.events?.map((event) => event.stage)).toEqual(['accepted', 'accepted']);
    // The delivering depot's receipt comes without a code and without its town in the wording.
    payload.Tracking = [{ Date: '20/03/2026', Time: '08:50', Description: 'Shipment received at DHL Depot', Town: 'Valencia' } as typeof payload.Tracking[number]];
    expect(parseDhlEcommerceEs(payload, NUMBER).events?.[0]).toMatchObject({ description: 'Shipment received at DHL Depot', stage: 'in_transit' });
    expect(parseDhlEcommerceEs(payload, NUMBER).events?.[0]?.provider_code).toBeUndefined();
  });

  it('takes the stage of an unknown code from the shipment status', () => {
    const payload = clone();
    payload.Tracking = payload.Tracking.slice(1);
    payload.Tracking[0]!.Code = 'QQ';
    payload.Status = 5;
    const result = parseDhlEcommerceEs(payload, NUMBER);
    expect(result.events?.[0]).toMatchObject({ provider_code: 'QQ', description: 'Delivered to DHL ServicePoint, ready for collection by the recipient' });
    expect(result.events?.[0]?.stage).toBeUndefined();
    expect(result.current_stage).toBe('ready_for_pickup');
    expect(result.status).toBe('in_transit');
    payload.Status = 0;
    expect(parseDhlEcommerceEs(payload, NUMBER)).toMatchObject({ status: 'unknown' });
    expect(dhlEcommerceEsSummaryStage('8')).toBeUndefined();
  });

  it('follows the latest scan while the parcel is on its way and keeps a delivery under a later notice', () => {
    const payload = clone();
    payload.Tracking = payload.Tracking.slice(5);
    payload.Status = 6;
    expect(parseDhlEcommerceEs(payload, NUMBER)).toMatchObject({ status: 'exception', current_stage: 'failed_attempt',
      last_update_local: '2026-03-11T12:01:00' });
    const noticed = clone();
    noticed.Tracking.unshift({ Date: '12/03/2026', Time: '11:00', Description: 'An attempt was made to contact the recipient by phone', Code: 'GT', Town: 'Madrid' });
    expect(parseDhlEcommerceEs(noticed, NUMBER)).toMatchObject({ current_stage: 'delivered', last_update_local: '2026-03-12T11:00:00' });
  });

  it('leaves a malformed clock out and never guesses one', () => {
    const payload = clone();
    payload.Tracking[0]!.Date = '31/02/2026';
    payload.Tracking[1]!.Time = '24:00';
    const result = parseDhlEcommerceEs(payload, NUMBER);
    expect(result.events?.[0]?.local_time).toBeUndefined();
    expect(result.events?.[1]?.local_time).toBeUndefined();
    expect(result.last_update_local).toBeUndefined();
  });

  it('requires the answer to echo the requested number', () => {
    const wrong = clone();
    wrong.ExpeditionNumber = '2800000008';
    expect(() => parseDhlEcommerceEs(wrong, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    // The licence plate of another query is not this shipment's identity.
    expect(() => parseDhlEcommerceEs(clone(), 'JJD00000000000000000001')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const spaced = clone();
    spaced.ExpeditionNumber = '28 00000007';
    expect(() => parseDhlEcommerceEs(spaced, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDhlEcommerceEs([clone()], NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const scan = clone();
    (scan.Tracking[0] as { Code: unknown }).Code = { value: 'RS' };
    expect(() => parseDhlEcommerceEs(scan, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const empty = clone();
    empty.Tracking = [];
    expect(() => parseDhlEcommerceEs(empty, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('accepts the numbers the portal answers and nothing else', () => {
    expect(normalizeDhlEcommerceEsNumber(' 28 0000 0007 ')).toBe(NUMBER);
    expect(normalizeDhlEcommerceEsNumber('es-0000001-0')).toBe('ES00000010');
    for (const number of ['280000000007', INBOUND, 'JJD00000000000000000001', '0099990099990000000001', 'JVGL0099999999', '3SABCD012345678']) {
      expect(normalizeDhlEcommerceEsNumber(number)).toBe(number);
    }
    for (const number of ['', '   ', '12345678901', 'ES00000011', '00340434000000000000', '<script>']) {
      expect(() => normalizeDhlEcommerceEsNumber(number)).toThrow(InvalidInputError);
    }
  });

  it('gives every recorded code one known stage', () => {
    for (const entry of statuses.entries) {
      expect(STAGES).toContain(entry.stage);
      expect(dhlEcommerceEsStatus(entry.code, entry.wording).stage).toBe(entry.stage);
    }
    expect(dhlEcommerceEsStatus(undefined, 'In transit in')).toEqual({ movement: true, stage: 'in_transit' });
    expect(dhlEcommerceEsStatus(undefined, 'Something new')).toEqual({ movement: false });
  });
});

describe('DHL eCommerce Iberia adapter', () => {
  it('asks the gateway for the one number, in English and without a postcode', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async (url, init) => {
      calls += 1;
      const request = new URL(String(url));
      expect(request.origin + request.pathname).toBe('https://clientesparcel.dhl.es/LiveTracking.GTW/api/shipment-detail');
      expect([...request.searchParams]).toEqual([['number', NUMBER]]);
      const headers = new Headers(init?.headers);
      expect(headers.get('cultura')).toBe('en');
      expect(headers.get('accept')).toBe('application/json');
      expect(headers.get('cookie')).toBeNull();
      expect(init?.signal).toBeDefined();
      return Response.json(clone());
    };
    const result = normalizeCarrierResult(await new DhlEcommerceEsTracker({ fetcher }).fetch(' 28-0000-0007 '));
    expect(result.current_stage).toBe('delivered');
    expect(calls).toBe(1);
  });

  it('never sends an empty or foreign number', async () => {
    let calls = 0;
    const tracker = adapter(environment(async () => { calls += 1; return Response.json(clone()); }));
    expect(() => tracker.track({ number: '' })).toThrow(InvalidInputError);
    expect(() => tracker.track({ number: '00340434000000000000' })).toThrow(InvalidInputError);
    await expect(tracker.recognize?.('00340434000000000000')).resolves.toEqual({ known: false });
    expect(calls).toBe(0);
  });

  it('reads absence from the empty 204 only', async () => {
    const unknown = adapter(environment(async () => new Response(null, { status: 204 })));
    await expect(unknown.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(unknown.recognize?.(NUMBER)).resolves.toEqual({ known: false });
    const rejected = adapter(environment(async () => html(REJECTED)));
    await expect(rejected.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(rejected.recognize?.(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    const page = adapter(environment(async () => html('<html><body>Maintenance</body></html>')));
    await expect(page.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
    const blank = adapter(environment(async () => new Response('', { status: 200 })));
    await expect(blank.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
    const broken = adapter(environment(async () => new Response('{"ExpeditionNumber":', { status: 200, headers: { 'content-type': 'application/json' } })));
    await expect(broken.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('recognizes a known parcel without an instant and leaves other answers inconclusive', async () => {
    const known = adapter(environment(async () => Response.json(clone())));
    await expect(known.recognize?.(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-12T10:15:00' });
    const other = adapter(environment(async () => Response.json(structuredClone(delivered))));
    await expect(other.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'schema' });
    for (const status of [409, 503]) {
      const inconclusive = adapter(environment(async () => new Response('', { status })));
      await expect(inconclusive.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
      await expect(inconclusive.recognize?.(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    const limited = adapter(environment(async () => new Response('', { status: 429 })));
    await expect(limited.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'rate_limited' });
  });
});
