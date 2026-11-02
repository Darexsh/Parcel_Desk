import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, BringTracker } from './adapter.js';
import { normalizeBringNumber, parseBring } from './parser.js';
import { bringStatus } from './status.js';
import { InvalidInputError } from '../../core/errors/index.js';

const NUMBER = '00000000000000001';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const payload = () => structuredClone(fixture);
const parcel = (value: ReturnType<typeof payload>) => value.consignmentWithDomainAsync.packageSet[0];
const latest = (value: ReturnType<typeof payload>, changes: Record<string, unknown>) => {
  Object.assign(parcel(value).eventSet[0], changes);
  Object.assign(parcel(value).domain.latestSignificantEvent, changes);
};

/** The fixture parcel still on its way, with an estimate the portal says is available. */
const travelling = (eta: unknown = { status: 'AVAILABLE', dateOfEstimatedDeliveryIso: '2026-01-08' }) => {
  const value = payload(); parcel(value).eventSet.shift(); parcel(value).eventSet.shift();
  parcel(value).eventSet.shift(); Object.assign(parcel(value).domain, { currentStatus: 'EN_ROUTE', eta,
    latestSignificantEvent: { ...parcel(value).eventSet[0] } });
  return parseBring(value, NUMBER);
};
/** The fixture parcel waiting at its pickup point. */
const waiting = (pickup: Record<string, unknown> = { expectedPickupUnitName: 'Example Kiosk' }) => {
  const value = payload(); parcel(value).eventSet.splice(0, 2); Object.assign(parcel(value), pickup);
  Object.assign(parcel(value).domain, { currentStatus: 'READY_FOR_PICKUP', eta: { status: 'AVAILABLE', dateOfEstimatedDeliveryIso: '2026-01-08' },
    deliveryType: { type: 'pickup-point', pickupPointInfo: { expectedPickupUnitName: 'Example Locker' } },
    latestSignificantEvent: { ...parcel(value).eventSet[0] } });
  return parseBring(value, NUMBER);
};

describe('Bring consumer parcel projection', () => {
  it('binds both consignment and S10 queries, preserves units and excludes personal fields', () => {
    const result = normalizeCarrierResult(parseBring(payload(), NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-01-06T12:00:00+01:00',
      delivered_at: '2026-01-06T12:00:00+01:00', expected_delivery: null, weight_kg: 0.5, dimensions_text: '20 × 15 × 4 cm',
      sender_name: 'Example Shop AS', destination_country: 'NO', service_name: 'Home Delivery Parcel' });
    expect(result).not.toHaveProperty('pickup_point'); expect(result).not.toHaveProperty('canonical_tracking_number');
    expect(result.events?.map(event => event.stage)).toEqual(['delivered', 'out_for_delivery', 'ready_for_pickup', 'accepted', 'registered']);
    expect(normalizeCarrierResult(parseBring(payload(), 'RR000000005NO')).events).toEqual(result.events);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|description.*signature|Address|recipient|pickup.code/);
    const declared = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    const evidence: Record<string, boolean> = { history: Boolean(result.events?.length), location: Boolean(result.events?.[0]?.location),
      delivered_at: Boolean(result.delivered_at), weight: Boolean(result.weight_kg), dimensions: Boolean(result.dimensions_text),
      sender_name: Boolean(result.sender_name), pickup_point: Boolean(waiting().pickup_point), eta: Boolean(travelling().expected_delivery),
      service_name: Boolean(result.service_name) };
    for (const capability of declared.capabilities) expect(evidence[capability], capability).toBe(true);
  });

  it('rejects wrong identities, unbound aliases, unknown brands and multiple pieces', () => {
    const wrong = payload(); wrong.consignmentWithDomainAsync.consignmentId = '00000000000000002';
    const unknown = payload(); parcel(unknown).brand = 'UNDEFINED';
    const malformed = payload(); parcel(malformed).brand = ['POSTEN'];
    for (const value of [wrong, unknown, malformed]) expect(() => parseBring(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const change of [{ numberOfConsignmentItems: 2 }, { packageSet: [] }, { domain: { isMultiParcel: true } }]) {
      const value = payload(); Object.assign(value.consignmentWithDomainAsync, change);
      expect(() => parseBring(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
    const duplicate = payload(); duplicate.consignmentWithDomainAsync.packageSet.push(parcel(duplicate));
    expect(() => parseBring(duplicate, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps notifications in history while current progress follows the significant scan', () => {
    const value = payload(); parcel(value).eventSet.unshift({ status: 'NOTIFICATION_SENT', description: 'PRIVATE phone',
      dateIso: '2026-01-07T12:00:00+01:00', insignificant: true, lmEventCode: 'N', city: '' });
    const result = parseBring(value, NUMBER);
    expect(result.last_update).toBe('2026-01-06T12:00:00+01:00'); expect(result.status).toBe('delivered');
    expect(result.events?.[0]).toMatchObject({ provider_code: 'NOTIFICATION_SENT', description: 'Notification sent' });
    expect(result.events?.[0]).not.toHaveProperty('stage');
  });

  it('requires the selected current scan to match the summary and rejects terminal conflicts', () => {
    for (const changes of [{ status: 'IN_TRANSIT' }, { dateIso: '2026-01-07T12:00:00+01:00' },
      { city: 'Other City' }, { insignificant: true }, { lmEventCode: 'X' }]) {
      const value = payload(); Object.assign(parcel(value).domain.latestSignificantEvent, changes);
      expect(() => parseBring(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
    const value = payload(); parcel(value).domain.currentStatus = 'EN_ROUTE';
    expect(() => parseBring(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    latest(value, { status: 'IN_TRANSIT' }); parcel(value).domain.currentStatus = 'DELIVERED';
    expect(() => parseBring(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('distinguishes return transport and returned delivery without trusting a return flag alone', () => {
    const value = payload(); latest(value, { status: 'RETURN' }); parcel(value).domain.currentStatus = 'EN_ROUTE_RETURN';
    parcel(value).domain.returnData.isReturned = true;
    expect(parseBring(value, NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(parseBring(value, NUMBER)).not.toHaveProperty('delivered_at');
    latest(value, { status: 'DELIVERED_SENDER' }); parcel(value).domain.currentStatus = 'DELIVERED_RETURN';
    expect(parseBring(value, NUMBER)).toMatchObject({ status: 'exception', current_stage: 'returned' });
    expect(parseBring(value, NUMBER).events?.[0]).toMatchObject({ provider_leg: 'return', stage: 'returned' });
    expect(parseBring(value, NUMBER).events?.[1]).not.toHaveProperty('provider_leg');
  });

  it.each(['2026-02-30T12:00:00+01:00', '2026-01-06T24:00:00Z', '2026-01-06T12:00:00+02:99',
    '2026-01-06T12:00:00+15:00', '', null])('preserves an unresolved current clock %s', dateIso => {
    const value = payload(); latest(value, { dateIso });
    const result = parseBring(value, NUMBER);
    expect(result.status).toBe('delivered'); expect(result.last_update).toBeNull(); expect(result).not.toHaveProperty('delivered_at');
    expect(result.events?.[0]).not.toHaveProperty('time');
    if (dateIso) expect(result.events?.[0]).toMatchObject({ provider_time_text: dateIso });
  });

  it('retains offsetless clocks, unmapped statuses and exact duplicates safely', () => {
    const value = payload(); latest(value, { dateIso: '2026-01-06T12:00:00' });
    expect(parseBring(value, NUMBER)).toMatchObject({ last_update: null, last_update_local: '2026-01-06T12:00:00.000' });
    latest(value, { status: 'NEW_CODE' }); parcel(value).domain.currentStatus = 'UNKNOWN';
    expect(parseBring(value, NUMBER).status).toBe('unknown'); expect(bringStatus('constructor')).toBeUndefined();
    parcel(value).eventSet.push({ ...parcel(value).eventSet[0], description: 'PRIVATE alternate' });
    expect(parseBring(value, NUMBER).events).toHaveLength(5);
  });

  it('bounds schema and skips invalid measurements without dropping matching history', () => {
    for (const row of [null, {}, { status: 'DELIVERED', dateIso: 123, insignificant: false }]) {
      const value = payload(); parcel(value).eventSet.push(row);
      expect(() => parseBring(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    const value = payload(); parcel(value).eventSet = Array(501).fill(parcel(value).eventSet[0]);
    expect(() => parseBring(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const units = payload(); parcel(units).weightInKgs = '0.5'; parcel(units).lengthInCm = -1;
    expect(parseBring(units, NUMBER)).not.toHaveProperty('weight_kg'); expect(parseBring(units, NUMBER)).not.toHaveProperty('dimensions_text');
    expect(() => parseBring({ errorState: 'NOT_FOUND', error: 'No shipments found' }, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });
});

describe('Bring fields, pieces and causes', () => {
  it('reads the estimated day only while the parcel travels and the portal says it is available', () => {
    expect(travelling()).toMatchObject({ status: 'in_transit', current_stage: 'accepted', expected_delivery: '2026-01-08' });
    expect(travelling({ status: 'AVAILABLE', dateOfEstimatedDeliveryIso: '2026-01-09T00:00:00+01:00' }).expected_delivery).toBe('2026-01-09');
    for (const eta of [{ status: 'NOT_AVAILABLE', dateOfEstimatedDeliveryIso: '2026-01-08' }, { status: 'MISSING' },
      { status: 'AVAILABLE', dateOfEstimatedDeliveryIso: '2026-02-30' }, { status: 'AVAILABLE', dateOfEstimatedDeliveryIso: 'soon' }, null]) {
      expect(travelling(eta).expected_delivery).toBeNull();
    }
    expect(waiting().expected_delivery).toBeNull();
  });

  it('names the pickup point while the parcel waits there and after it is collected there', () => {
    expect(waiting()).toMatchObject({ current_stage: 'ready_for_pickup', pickup_point: 'Example Kiosk' });
    expect(waiting({}).pickup_point).toBe('Example Locker');
    expect(travelling()).not.toHaveProperty('pickup_point');

    const collected = () => JSON.parse(readFileSync(new URL('./fixtures/collected.json', import.meta.url), 'utf8'));
    const rows = (value: ReturnType<typeof collected>) => parcel(value).eventSet as Record<string, unknown>[];
    const result = parseBring(collected(), '370000000000000001');
    expect(result).toMatchObject({ status: 'delivered', pickup_point: 'Example Parcel Locker' });
    // The scans themselves are unchanged.
    expect(result.events?.slice(0, 2)).toMatchObject([{ description: 'Delivered', location: '' }, { description: 'Ready for pickup', location: 'EXAMPLE TOWN' }]);
    const numeric = collected(); parcel(numeric).expectedPickupUnitId = 100001;
    expect(parseBring(numeric, '370000000000000001').pickup_point).toBe('Example Parcel Locker');
    const noticed = collected(); rows(noticed).splice(1, 0, { ...rows(noticed)[2], status: 'NOTIFICATION_SENT', unitId: '' });
    expect(parseBring(noticed, '370000000000000001').pickup_point).toBe('Example Parcel Locker');
    // Delivered at another unit, taken back out for delivery, or with no pickup unit: no pickup point.
    const elsewhere = collected(); rows(elsewhere)[0]!.unitId = '200001'; parcel(elsewhere).domain.latestSignificantEvent.unitId = '200001';
    const readyElsewhere = collected(); rows(readyElsewhere)[1]!.unitId = '200001';
    const redelivered = collected(); rows(redelivered).splice(1, 0, { ...rows(redelivered)[2], dateIso: '2026-01-06T08:00:00+01:00', unitId: '100001' });
    const unbound = collected(); parcel(unbound).expectedPickupUnitId = null;
    for (const value of [elsewhere, readyElsewhere, redelivered, unbound]) {
      expect(parseBring(value, '370000000000000001')).not.toHaveProperty('pickup_point');
    }
    // Nor does the fixture parcel, delivered to the door after it was ready for pickup.
    expect(parseBring(payload(), NUMBER)).not.toHaveProperty('pickup_point');
  });

  it('leaves out a sender or country the portal does not give', () => {
    const value = payload(); delete value.consignmentWithDomainAsync.senderName; parcel(value).senderName = 'Example Brand AS';
    value.consignmentWithDomainAsync.recipientAddress.countryCode = 'Norway';
    expect(parseBring(value, NUMBER)).toMatchObject({ sender_name: 'Example Brand AS' });
    expect(parseBring(value, NUMBER)).not.toHaveProperty('destination_country');
    delete parcel(value).senderName; expect(parseBring(value, NUMBER)).not.toHaveProperty('sender_name');
  });

  it('follows the piece asked for in a larger consignment, but not the consignment number', () => {
    const value = payload(); const second = structuredClone(parcel(value));
    Object.assign(second, { packageNumber: '370000000000000002', weightInKgs: 2 });
    Object.assign(value.consignmentWithDomainAsync, { numberOfConsignmentItems: 2, domain: { isMultiParcel: true } });
    value.consignmentWithDomainAsync.packageSet.push(second);
    expect(parseBring(value, '370000000000000002')).toMatchObject({ status: 'delivered', weight_kg: 2 });
    expect(parseBring(value, 'RR000000005NO')).toMatchObject({ weight_kg: 0.5 });
    expect(() => parseBring(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    value.consignmentWithDomainAsync.numberOfConsignmentItems = 3;
    expect(() => parseBring(value, '370000000000000002')).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('asks for the parcel number behind an SSCC with its 00 identifier and reports that number', async () => {
    const value = payload(); parcel(value).packageNumber = '370000000000000001';
    expect(normalizeBringNumber('00 370000000000000001')).toBe('370000000000000001');
    expect(parseBring(value, '00370000000000000001')).toMatchObject({ canonical_tracking_number: '370000000000000001' });
    expect(parseBring(value, '370000000000000001')).not.toHaveProperty('canonical_tracking_number');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(value));
    await new BringTracker({ fetcher }).fetch('00370000000000000001');
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://sporing.bring.no/sporing/json/370000000000000001?lang=en');
  });

  it('matches the summary past a newer delivery change notice, which takes no stage', () => {
    const value = payload(); parcel(value).eventSet.unshift({ status: 'DELIVERY_CHANGED', description: 'PRIVATE choice',
      dateIso: '2026-01-07T12:00:00+01:00', insignificant: false, lmEventCode: 'YG', city: '' });
    const result = parseBring(value, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', last_update: '2026-01-06T12:00:00+01:00' });
    expect(result.events?.[0]).toMatchObject({ provider_code: 'DELIVERY_CHANGED', description: 'Delivery details changed' });
    expect(result.events?.[0]).not.toHaveProperty('stage');
  });

  it('reads deviation causes, customs and missed deliveries', () => {
    const value = payload(); parcel(value).domain.currentStatus = 'EN_ROUTE';
    latest(value, { status: 'DEVIATION', lmCauseCode: '28' });
    expect(parseBring(value, NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'Handed in after the deadline' });
    latest(value, { status: 'DEVIATION', lmCauseCode: '41' });
    expect(parseBring(value, NUMBER)).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Delayed' });
    latest(value, { status: 'DEVIATION', lmCauseCode: '99' });
    expect(parseBring(value, NUMBER)).toMatchObject({ current_stage: 'exception', last_status_text: 'Delivery exception' });
    latest(value, { status: 'CUSTOMS', lmCauseCode: '' });
    expect(parseBring(value, NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'customs' });
    latest(value, { status: 'ATTEMPTED_DELIVERY' });
    expect(parseBring(value, NUMBER)).toMatchObject({ status: 'exception', current_stage: 'failed_attempt' });
  });
});

describe('Bring bounded anonymous retrieval', () => {
  it('uses one current consumer JSON GET with no credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload()));
    await new BringTracker({ fetcher }).fetch(NUMBER);
    expect(fetcher).toHaveBeenCalledOnce(); const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://sporing.bring.no/sporing/json/${NUMBER}?lang=en`);
    expect(init).toMatchObject({ cache: 'no-store', redirect: 'error' });
    expect(new Headers(init?.headers).has('Authorization')).toBe(false); expect(new Headers(init?.headers).has('Cookie')).toBe(false);
  });

  it.each([[404, 'indeterminate'], [410, 'indeterminate'], [403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']])('preserves HTTP %s semantics', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Unavailable', { status: Number(status) }));
    await expect(new BringTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind }); expect(fetcher).toHaveBeenCalledOnce();
    await expect(new BringTracker({ fetcher }).fetch(NUMBER)).rejects.not.toMatchObject({ reason: 'portal_not_found' });
  });

  it('marks the portal\'s own not-found answer, which stays inconclusive', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: 'No shipments found', errorState: 'NOT_FOUND' }, { status: 404 }));
    await expect(new BringTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    // The same answer as plain text.
    fetcher.mockResolvedValue(new Response('NOT FOUND', { status: 404, headers: { 'Content-Type': 'text/plain;charset=UTF-8' } }));
    await expect(new BringTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  });

  it('asks about S10 mail from abroad and recognizes the numbers its lookup takes', async () => {
    // Mail from abroad is its own consignment, which counts no items.
    const value = payload(); parcel(value).packageNumber = 'RR000000005DE';
    Object.assign(value.consignmentWithDomainAsync, { consignmentId: 'RR000000005DE', numberOfConsignmentItems: 0 });
    const other = structuredClone(value); parcel(other).packageNumber = 'RR000000019DE';
    expect(() => parseBring(other, 'RR000000005DE')).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(value));
    const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    await expect(tracker.track({ number: 'RR000000005DE' }, {})).resolves.toMatchObject({ status: 'delivered' });
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://sporing.bring.no/sporing/json/RR000000005DE?lang=en');
    await expect(tracker.recognize!('RR000000005DE', {})).resolves.toMatchObject({ known: true, lastActivityAt: '2026-01-06T11:00:00.000Z' });
    fetcher.mockClear();
    await expect(tracker.recognize!('RR000000004DE', {})).resolves.toEqual({ known: false }); expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockImplementation(async () => Response.json({ error: 'No shipments found', errorState: 'NOT_FOUND' }, { status: 404 }));
    await expect(tracker.recognize!('370000000000000001', {})).rejects.toMatchObject({ reason: 'portal_not_found' });
  });

  it('validates inputs, response bytes, cancellation and malformed JSON', async () => {
    for (const number of ['123', 'RR000000006NO', 'RR000000004CN', `${NUMBER}&secret=value`]) expect(() => normalizeBringNumber(number)).toThrow(InvalidInputError);
    expect(normalizeBringNumber('rr 000000005 no')).toBe('RR000000005NO');
    const fetcher = vi.fn<typeof fetch>();
    await expect(new BringTracker({ fetcher }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
    const huge = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(1_000_001)));
    await expect(new BringTracker({ fetcher: huge }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
    const invalid = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>Unavailable</html>'));
    await expect(new BringTracker({ fetcher: invalid }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });
});
