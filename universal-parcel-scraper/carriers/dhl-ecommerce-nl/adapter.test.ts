import { describe, expect, it } from 'vitest';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { STAGES } from '../../core/status/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import fixture from './fixtures/collected.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };
import { DhlEcommerceNlTracker, adapter } from './adapter.js';
import { normalizeDhlEcommerceNlNumber, parseDhlEcommerceNl, parseDhlEcommerceNlNotFound } from './parser.js';
import { dhlEcommerceNlStatus } from './status.js';

const NUMBER = 'JVGL09999999000000000000';
const MISSING = 'No parcel found for the given key(s)';
const clone = () => structuredClone(fixture);
const environment = (fetcher: typeof fetch) => ({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {}, fetcher });

describe('DHL eCommerce Netherlands parser', () => {
  it('reads a parcel collected at a ServicePoint, newest scan first', () => {
    const result = normalizeCarrierResult(parseDhlEcommerceNl(clone(), NUMBER));
    expect(result.status).toBe('delivered');
    expect(result.current_stage).toBe('delivered');
    expect(result.last_status_text).toBe('Collected at DHL ServicePoint by the recipient');
    expect(result.last_update).toBe('2026-04-03T10:42:00.269Z');
    expect(result.delivered_at).toBe('2026-04-03T10:42:00.269Z');
    expect(result.expected_delivery).toBeNull();
    expect(result.events).toHaveLength(11);
    expect(result.events?.[0]).toMatchObject({ provider_code: 'COLLECTED_AT_PARCELSHOP', stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events?.at(-1)).toMatchObject({ provider_code: 'PRENOTIFICATION_RECEIVED', stage: 'registered' });
    expect(result.events?.map((event) => event.stage)).toEqual(['delivered', 'ready_for_pickup', 'in_transit', 'in_transit',
      'failed_attempt', 'out_for_delivery', 'in_transit', 'in_transit', 'accepted', 'registered', 'registered']);
  });

  it('keeps the newest planned window or expected moment while the parcel is on its way', () => {
    const upTo = (count: number) => {
      const payload = clone();
      payload[0]!.events = payload[0]!.events.slice(0, count);
      delete (payload[0] as { deliveredAt?: string }).deliveredAt;
      return parseDhlEcommerceNl(payload, NUMBER);
    };
    expect(upTo(4)).toMatchObject({ status: 'in_transit', expected_delivery: null });
    expect(upTo(4)).not.toHaveProperty('expected_delivery_from');
    expect(upTo(5)).toMatchObject({ expected_delivery_from: '2026-04-02T10:00:00+02:00', expected_delivery: '2026-04-02T18:00:00+02:00' });
    // A later moment replaces the window, and a new plan after a missed delivery replaces the moment.
    expect(upTo(6)).toMatchObject({ status: 'out_for_delivery', expected_delivery: '2026-04-02T14:00:00+02:00' });
    expect(upTo(6)).not.toHaveProperty('expected_delivery_from');
    expect(upTo(6).delivered_at).toBeUndefined();
    expect(upTo(7)).toMatchObject({ current_stage: 'failed_attempt', expected_delivery: '2026-04-02T14:00:00+02:00' });
    expect(upTo(8)).toMatchObject({ expected_delivery: '2026-04-03T14:00:00+02:00' });
    // At the ServicePoint the moment is when it can be collected, not an estimate.
    expect(upTo(10)).toMatchObject({ current_stage: 'ready_for_pickup', expected_delivery: null });
    expect(upTo(10).events).toHaveLength(10);
  });

  it('drops an estimate a later scan has passed or that does not read', () => {
    const withEstimate = (estimate: Record<string, string>, later?: string) => {
      const payload = clone();
      payload[0]!.events = payload[0]!.events.slice(0, 4);
      delete (payload[0] as { deliveredAt?: string }).deliveredAt;
      payload[0]!.events.push({ category: 'UNDERWAY', localTimestamp: '2026-04-02T06:40:11+02:00', leg: { network: 'ECOMMERCE' },
        status: 'INFORMATION_ON_DELIVERY_TRANSMITTED', timestamp: '2026-04-02T04:40:11Z', type: 'PIECE_EVENT', ...estimate });
      if (later) payload[0]!.events.push({ category: 'UNDERWAY', localTimestamp: later, leg: { network: 'ECOMMERCE' },
        status: 'PARCEL_SORTED_AT_HUB', timestamp: later, type: 'PIECE_EVENT' });
      return parseDhlEcommerceNl(payload, NUMBER);
    };
    const moment = { momentIndication: '2026-04-02T14:00:00+02:00' };
    expect(withEstimate(moment, '2026-04-02T13:59:00+02:00').expected_delivery).toBe('2026-04-02T14:00:00+02:00');
    expect(withEstimate(moment, '2026-04-02T14:01:00+02:00').expected_delivery).toBeNull();
    // The page reads the window first when a scan carries both.
    expect(withEstimate({ ...moment, plannedDeliveryTimeframe: '2026-04-02T10:00:00+02:00/2026-04-02T12:00:00+02:00' }))
      .toMatchObject({ expected_delivery_from: '2026-04-02T10:00:00+02:00', expected_delivery: '2026-04-02T12:00:00+02:00' });
    expect(withEstimate({ plannedDeliveryTimeframe: '2026-04-02T10:00:00+02:00/2026-04-02T10:00:00+02:00' })).not.toHaveProperty('expected_delivery_from');
    // A clock without an offset keeps only its day.
    expect(withEstimate({ momentIndication: '2026-04-02T14:00:00' }).expected_delivery).toBe('2026-04-02');
    expect(withEstimate({ plannedDeliveryTimeframe: '2026-04-02T10:00:00/2026-04-02T18:00:00' })).toMatchObject({ expected_delivery: '2026-04-02' });
    for (const unreadable of [{ momentIndication: 'soon' }, { plannedDeliveryTimeframe: '2026-04-02T18:00:00+02:00/2026-04-02T10:00:00+02:00' },
      { plannedDeliveryTimeframe: '2026-04-02T10:00:00+02:00/2026-04-02T12:00:00+02:00/2026-04-02T14:00:00+02:00' }]) {
      // An unreadable newer estimate does not bring back an older one.
      const payload = clone();
      delete (payload[0] as { deliveredAt?: string }).deliveredAt;
      const events: Record<string, unknown>[] = payload[0]!.events.slice(0, 5);
      Object.assign(events[4]!, { plannedDeliveryTimeframe: undefined }, unreadable);
      events.splice(4, 0, { ...events[3]!, status: 'INFORMATION_ON_DELIVERY_TRANSMITTED',
        plannedDeliveryTimeframe: '2026-04-02T10:00:00+02:00/2026-04-02T18:00:00+02:00' });
      const result = parseDhlEcommerceNl([{ ...payload[0], events }], NUMBER);
      expect(result.expected_delivery, JSON.stringify(unreadable)).toBeNull();
      expect(result).not.toHaveProperty('expected_delivery_from');
    }
  });

  it('does not let a later notice undo a delivery', () => {
    const payload = clone();
    payload[0]!.events.push({ category: 'UNDERWAY', localTimestamp: '2026-04-03T13:00:00+02:00', leg: { network: 'ECOMMERCE' },
      status: 'IMAGE_AVAILABLE', timestamp: '2026-04-03T11:00:00Z', type: 'PIECE_EVENT' });
    const result = parseDhlEcommerceNl(payload, NUMBER);
    expect(result.current_stage).toBe('delivered');
    expect(result.last_update).toBe('2026-04-03T11:00:00Z');
  });

  it('keeps a parcel waiting at a ServicePoint when its notice fails, and the courier hand-over out for delivery', () => {
    const payload = clone();
    payload[0]!.events = payload[0]!.events.slice(0, 10);
    payload[0]!.events[9]!.status = 'NOTIFICATION_FOR_PARCELSHOP_COLLECTION_HAS_FAILED';
    expect(parseDhlEcommerceNl(payload, NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'ready_for_pickup' });
    payload[0]!.events = payload[0]!.events.slice(0, 6);
    payload[0]!.events[5]!.status = 'PARCEL_HANDED_OVER_TO_COURIER';
    expect(parseDhlEcommerceNl(payload, NUMBER)).toMatchObject({ status: 'out_for_delivery', last_status_text: 'Handed over to the courier' });
  });

  it('drops a scan the feed repeats and files an unknown code under its category', () => {
    const payload = clone();
    payload[0]!.events.splice(4, 0, structuredClone(payload[0]!.events[3]!));
    payload[0]!.events[1]!.status = 'SOME_NEW_CODE';
    const result = parseDhlEcommerceNl(payload, NUMBER);
    expect(result.events).toHaveLength(11);
    expect(result.events?.at(-2)).toMatchObject({ provider_code: 'SOME_NEW_CODE', description: 'Some new code', stage: 'registered' });
    expect(dhlEcommerceNlStatus('SOME_NEW_CODE', 'SOMETHING_ELSE')).toEqual({ description: 'Some new code' });
  });

  it('requires the answer to name the requested parcel', () => {
    const wrong = clone();
    wrong[0]!.barcode = 'JVGL09999999000000000001';
    wrong[0]!.barcodes = ['JVGL09999999000000000001'];
    expect(() => parseDhlEcommerceNl(wrong, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDhlEcommerceNl([...clone(), ...clone()], NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDhlEcommerceNl({}, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const empty = clone();
    empty[0]!.events = [];
    expect(() => parseDhlEcommerceNl(empty, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads absence only from the gateway\'s own sentence', () => {
    expect(() => parseDhlEcommerceNlNotFound(MISSING)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDhlEcommerceNlNotFound('<html>Not Found</html>')).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('accepts the Benelux label families only', () => {
    expect(normalizeDhlEcommerceNlNumber('jvgl 0999 9999 0000 0000 0000')).toBe(NUMBER);
    expect(normalizeDhlEcommerceNlNumber('3SABCD012345678')).toBe('3SABCD012345678');
    expect(normalizeDhlEcommerceNlNumber('JJD0099999999')).toBe('JJD0099999999');
    expect(normalizeDhlEcommerceNlNumber('00 0123456 0000000001 2')).toBe('00012345600000000012');
    expect(() => normalizeDhlEcommerceNlNumber('00012345600000000013')).toThrow(InvalidInputError);
    // DHL Paket's own SSCCs stay with DHL Paket; a manufacturer's prefix among or below them is a shipper's.
    expect(() => normalizeDhlEcommerceNlNumber('00340434160000000001')).toThrow(InvalidInputError);
    expect(() => normalizeDhlEcommerceNlNumber('00340433830000000004')).toThrow(InvalidInputError);
    expect(normalizeDhlEcommerceNlNumber('00340433660000000007')).toBe('00340433660000000007');
    expect(normalizeDhlEcommerceNlNumber('00340433820000000005')).toBe('00340433820000000005');
    expect(normalizeDhlEcommerceNlNumber('00340435330000000007')).toBe('00340435330000000007');
    expect(() => normalizeDhlEcommerceNlNumber('1234567890')).toThrow(InvalidInputError);
  });

  it('gives every recorded code a wording and a known stage', () => {
    expect(statuses.entries.length).toBeGreaterThan(300);
    for (const entry of statuses.entries) {
      expect(STAGES).toContain(entry.stage);
      expect(dhlEcommerceNlStatus(entry.code, 'UNKNOWN')).toEqual({ description: entry.wording, stage: entry.stage });
    }
  });
});

describe('DHL eCommerce Netherlands adapter', () => {
  it('asks the gateway for the one key and returns a normalized parcel', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async (url, init) => {
      calls += 1;
      const request = new URL(String(url));
      expect(request.origin + request.pathname).toBe('https://api-gw.dhlparcel.nl/track-trace');
      expect([...request.searchParams]).toEqual([['key', NUMBER]]);
      expect(init?.signal).toBeDefined();
      return Response.json(clone());
    };
    const result = normalizeCarrierResult(await new DhlEcommerceNlTracker({ fetcher }).fetch(NUMBER));
    expect(result.current_stage).toBe('delivered');
    expect(calls).toBe(1);
  });

  it('recognizes a known parcel, an absent one, and leaves other errors inconclusive', async () => {
    const known = adapter(environment(async () => Response.json(clone())));
    await expect(known.recognize?.(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: '2026-04-03T10:42:00.269Z' });
    const unknown = adapter(environment(async () => new Response(MISSING, { status: 404 })));
    await expect(unknown.recognize?.(NUMBER)).resolves.toEqual({ known: false });
    await expect(unknown.recognize?.('00340434160000000001')).resolves.toEqual({ known: false });
    const generic = adapter(environment(async () => new Response('Not Found', { status: 404 })));
    await expect(generic.recognize?.(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    const limited = adapter(environment(async () => new Response('', { status: 429 })));
    await expect(limited.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'rate_limited' });
  });
});
