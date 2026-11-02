import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, CanparTracker, canparRequest } from './adapter.js';
import { canparNumber, parseCanpar } from './parser.js';
import { canparStatus } from './status.js';
import { InvalidInputError } from '../../core/errors/index.js';

const NUMBER = 'C000000000000000000001';
const OTHER = 'C000000000000000000002';
const SHORT = 'D0000000000001';
// The short barcode whole: the sender's shipper number after its letter.
const WHOLE = 'D000000010000000000001';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));

describe('Canpar parcel history', () => {
  it('retains native local scans, trims codes and excludes private detail and stale estimates', () => {
    const result = normalizeCarrierResult(parseCanpar(fixture(), NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null,
      last_update_local: '2026-01-05T10:00:00', expected_delivery: null, service_name: 'GROUND' });
    expect(result.events).toHaveLength(6);
    expect(result.events?.[0]).toMatchObject({ provider_code: 'DEL', stage: 'delivered', location: 'Example City, EX' });
    expect(result.events?.[1]).toMatchObject({ provider_code: 'WC', stage: 'out_for_delivery' });
    expect(result.events?.[3]).toMatchObject({ stage: 'returned' });
    expect(result.events?.at(-1)).toMatchObject({ stage: 'accepted' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|time_shift|signed_by|reference_num|signature|estimated_delivery|web_description/);
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(metadata.capabilities).toEqual(['history', 'location', 'eta', 'service_name']);
    const unnamed = fixture(); unnamed.result[0].service_description_en = null;
    expect(parseCanpar(unnamed, NUMBER)).not.toHaveProperty('service_name');
  });

  it('keeps the expected delivery day only while the parcel is on its way', () => {
    const value = fixture(); value.result[0].events.splice(0, 2);
    expect(parseCanpar(value, NUMBER)).toMatchObject({ status: 'in_transit', expected_delivery: '2026-01-05' });
    value.result[0].estimated_delivery_date = '20260104';
    expect(parseCanpar(value, NUMBER).expected_delivery).toBe('2026-01-04');
    for (const day of ['20260102', '20260230', '2026-01-05', null]) {
      value.result[0].estimated_delivery_date = day;
      expect(parseCanpar(value, NUMBER).expected_delivery).toBeNull();
    }
    const pickup = fixture(); pickup.result[0].events.splice(0, 2);
    pickup.result[0].events.unshift({ ...pickup.result[0].events[0], code: 'DRP', code_description_en: 'Ready for Pickup at Your Local SMARTSpot', local_date_time: '20260105 090000' });
    expect(parseCanpar(pickup, NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'ready_for_pickup', expected_delivery: null });
  });

  it('reads holds, handoffs, handling, weather delays and missed deliveries', () => {
    for (const [code, description, status, stage] of [
      ['HLD', 'Delayed at Facility', 'exception', 'exception'],
      ['NH ', 'Consignee Not Home', 'exception', 'failed_attempt'],
      ['INO', 'Handed Off to a Local Delivery Partner', 'in_transit', 'in_transit'],
      ['XC ', 'Additional Handling Required', 'in_transit', 'in_transit'],
      ['WXX', "Weather's Slowing Us Down, But We're on It!", 'in_transit', 'in_transit'],
    ] as const) {
      const value = fixture();
      value.result[0].events.unshift({ ...value.result[0].events[2], code, code_description_en: description, local_date_time: '20260106 090000' });
      expect(parseCanpar(value, NUMBER)).toMatchObject({ status, current_stage: stage });
    }
  });

  it('accepts the public client package envelope without retaining pickup address data', () => {
    const value = fixture(); value.result = { packages: value.result, pickup_location: { address: 'PRIVATE' } };
    expect(parseCanpar(value, NUMBER).events).toHaveLength(6);
    expect(JSON.stringify(parseCanpar(value, NUMBER))).not.toContain('PRIVATE');
  });

  it('requires exactly one matching parcel and never merges a shipment or duplicate match', () => {
    const wrong = fixture(); wrong.result[0].barcode = OTHER;
    const duplicate = fixture(); duplicate.result.push(duplicate.result[0]);
    const shipment = fixture(); shipment.result.push({ ...shipment.result[0], barcode: OTHER });
    for (const value of [null, {}, { result: {} }, wrong, duplicate, shipment, { result: Array(26).fill({}) }]) {
      expect(() => parseCanpar(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps empty identity-shaped placeholders and upstream errors inconclusive', () => {
    const value = fixture(); value.result[0].events = []; value.result[0].shipping_date = null;
    value.result[0].status = 0; value.result[0].delivered = false;
    for (const input of [value, { error: null, result: [] }]) {
      expect(() => parseCanpar(input, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    }
    expect(() => parseCanpar({ error: 'Unavailable', result: fixture().result }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: undefined }));
  });

  it('uses the newest actual scan over the package summary or a prior completed return', () => {
    const value = fixture(); value.result[0].events.shift();
    expect(parseCanpar(value, NUMBER)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    value.result[0].events[0].code = 'NEW'; value.result[0].events[0].code_description_en = 'Awaiting review';
    const unknown = parseCanpar(value, NUMBER);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Awaiting review' });
    expect(unknown.events?.[0]).not.toHaveProperty('stage');
    expect(canparStatus('toString')).toBeUndefined();
    expect(canparStatus('COA')).toMatchObject({ status: 'in_transit' });
    expect(canparStatus('NL')).toMatchObject({ stage: 'failed_attempt' });
  });

  it.each([3, 6, 7, null, 'unknown'])('does not treat shift %s as an offset', time_shift => {
    const value = fixture(); value.result[0].events[0].time_shift = time_shift;
    expect(parseCanpar(value, NUMBER).events?.[0]).toMatchObject({ local_time: '2026-01-05T10:00:00' });
    expect(parseCanpar(value, NUMBER).events?.[0]).not.toHaveProperty('time');
  });

  it('preserves unresolved or malformed newest clocks without borrowing an older time', () => {
    const value = fixture(); value.result[0].events[0].local_date_time = '20260230 100000';
    expect(parseCanpar(value, NUMBER)).toMatchObject({ last_update: null, last_update_local: null });
    expect(parseCanpar(value, NUMBER).events?.[0]).toMatchObject({ provider_time_text: '20260230 100000' });
    delete value.result[0].events[0].local_date_time;
    expect(parseCanpar(value, NUMBER).events?.[0]).not.toHaveProperty('local_time');
  });

  it.each([123, true, {}, []])('rejects a non-text clock field %j', local_date_time => {
    const value = fixture(); value.result[0].events[0].local_date_time = local_date_time;
    expect(() => parseCanpar(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each(['20260105 240000', '20260105 126000'])('preserves invalid clock digits %s without rolling to another day', local_date_time => {
    const value = fixture(); value.result[0].events[0].local_date_time = local_date_time;
    const result = parseCanpar(value, NUMBER);
    expect(result.events?.[0]).toMatchObject({ provider_time_text: local_date_time });
    expect(result.events?.[0]).not.toHaveProperty('local_time');
    expect(result.last_update_local).toBeNull();
  });

  it('bounds and validates histories while preserving source order on equal clocks', () => {
    for (const row of [null, {}, { ...fixture().result[0].events[0], code: '' }, { ...fixture().result[0].events[0], code_description_en: '' }]) {
      const value = fixture(); value.result[0].events[0] = row;
      expect(() => parseCanpar(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const value = fixture(); value.result[0].events.splice(1, 0, value.result[0].events[0]);
    expect(parseCanpar(value, NUMBER).events).toHaveLength(6);
    for (let i = 0; i < 110; i++) value.result[0].events.push({ ...value.result[0].events[0], code_description_en: `Public scan ${i}` });
    expect(parseCanpar(value, NUMBER).events).toHaveLength(100);
    value.result[0].events = Array(501).fill(value.result[0].events[0]);
    expect(() => parseCanpar(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('Canpar numbers other than full barcodes', () => {
  const answer = (barcode: string) => { const value = fixture(); value.result[0].barcode = barcode; return value; };

  it('tells each kind of number by its shape and asks for it as the page does', () => {
    expect(['C000000000000000000001', 'D00000001', SHORT, 'P000000001', 'R00000001', 'W00000001', 'W000000001']
      .map(number => canparNumber(number).kind)).toEqual(['barcode', 'short', 'short', 'tag', 'tag', 'notice', 'notice']);
    for (const number of ['D0000001', 'P00000001', 'R000000001', 'W0000001', 'W0000000001', 'A000000000000000000001']) {
      expect(() => canparNumber(number)).toThrow(InvalidInputError);
    }
    const api = 'https://canship.canpar.com/api/CanparAddons';
    expect(canparRequest(canparNumber('W00000001'), 'A1A1A1')).toEqual({ url: `${api}/trackByDeliveryNotice`, body: { delivery_notice: 'W00000001' } });
    expect(canparRequest(canparNumber(SHORT), 'A1A1A1')).toEqual({ url: `${api}/trackByShortBarcodeAndPostalCode`, body: { barcode: SHORT, postal_code: 'A1A1A1' } });
    for (const number of [SHORT, 'P000000001', 'R00000001', NUMBER]) {
      expect(canparRequest(canparNumber(number))).toEqual({ url: `${api}/trackByBarcodeV2`, body: { barcode: number, track_shipment: false } });
    }
  });

  it('sends the postal code with a short barcode only', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(answer(SHORT)));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    await instance.track({ number: SHORT, postcode: 'a1a 1a1' });
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ barcode: SHORT, postal_code: 'A1A1A1' });
    fetcher.mockImplementation(async () => Response.json(answer('P000000001')));
    await instance.track({ number: 'P000000001', postcode: 'A1A 1A1' });
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toEqual({ barcode: 'P000000001', track_shipment: false });
  });

  it("takes a short barcode answered whole, and a notice's one parcel, under their own barcode", () => {
    expect(parseCanpar(answer(SHORT), SHORT)).not.toHaveProperty('canonical_tracking_number');
    expect(parseCanpar(answer(WHOLE), SHORT)).toMatchObject({ status: 'delivered', canonical_tracking_number: WHOLE });
    expect(parseCanpar(answer(NUMBER), 'W00000001')).toMatchObject({ status: 'delivered', canonical_tracking_number: NUMBER });
    expect(parseCanpar(answer('P000000001'), 'P000000001')).not.toHaveProperty('canonical_tracking_number');
    for (const [barcode, number] of [['D000000010000000000002', SHORT], ['C000000010000000000001', SHORT], [NUMBER, SHORT],
      [NUMBER, 'P000000001'], ['P000000001', 'W00000001'], [NUMBER, 'R00000001']]) {
      expect(() => parseCanpar(answer(barcode!), number!)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps a notice left for several parcels inconclusive', () => {
    const value = answer(NUMBER); value.result.push({ ...value.result[0], barcode: OTHER });
    expect(() => parseCanpar(value, 'W00000001')).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'several_parcels' }));
    expect(() => parseCanpar(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('asks for the postal code when Canpar needs the shipper of a short barcode', () => {
    const error = { result: null, error: 'Shipper num required|Numéro d\'expéditeur requis' };
    expect(() => parseCanpar(error, SHORT)).toThrow(expect.objectContaining({ kind: 'input_required', field: 'postcode' }));
    expect(() => parseCanpar(error, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: undefined }));
    const unknown = { result: null, error: 'Please contact Customer Service.|Please contact Customer Service.' };
    expect(() => parseCanpar(unknown, 'W00000001')).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: undefined }));
  });
});

describe('Canpar retrieval', () => {
  it('uses one anonymous parcel-only request and recognizes unresolved history', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(fixture()));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    await expect(instance.recognize!('123')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(instance.recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-01-05T10:00:00' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://canship.canpar.com/api/CanparAddons/trackByBarcodeV2');
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store', redirect: 'error' });
    expect(JSON.parse(String(init?.body))).toEqual({ barcode: NUMBER, track_shipment: false });
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    expect(new Headers(init?.headers).has('Cookie')).toBe(false);
    const empty = fixture(); empty.result[0].events = [];
    fetcher.mockResolvedValueOnce(Response.json(empty));
    await expect(instance.recognize!(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  });

  it.each([[404, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']])('keeps HTTP %s distinct from absence', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Unavailable', { status: Number(status) }));
    await expect(new CanparTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects invalid inputs before I/O and bounds cancellation, elapsed time and response size', async () => {
    const unused = vi.fn<typeof fetch>();
    for (const number of ['123', `${NUMBER}&barcode=OTHER`, 'W000000000001']) {
      await expect(new CanparTracker({ fetcher: unused }).fetch(number)).rejects.toThrow(InvalidInputError);
    }
    await expect(new CanparTracker({ fetcher: unused }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(unused).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      await new Promise<void>(resolve => init?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      init?.signal?.throwIfAborted(); return new Response('{}');
    });
    await expect(new CanparTracker({ fetcher: slow }).fetch(NUMBER, { budgetMs: 20.5 })).rejects.toThrow();
    const huge = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(1_000_001)));
    await expect(new CanparTracker({ fetcher: huge }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>Unavailable</html>'));
    await expect(new CanparTracker({ fetcher: malformed }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });
});
