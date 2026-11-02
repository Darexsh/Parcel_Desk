import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, NovaPoshtaTracker } from './adapter.js';
import { parseNovaPoshta, parseNovaPoshtaHistory } from './parser.js';
const NUMBER = '59000000000001';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const history = () => JSON.parse(readFileSync(new URL('./fixtures/history-delivered.json', import.meta.url), 'utf8'));

describe('Nova Poshta summary parser', () => {
  it('retains a receipt summary without inventing movement history', () => {
    const result = parseNovaPoshta(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', summary_only: true,
      delivered_at: '2026-01-03T12:00:00+02:00', last_update: '2026-01-03T12:00:00+02:00', events: [] });
    expect(JSON.stringify(result)).not.toContain('PRIVATE-SYNTHETIC');
  });
  it('does not date transit from booking or metadata refresh', () => {
    const value = fixture(); value.data[0].StatusCode = '5'; value.data[0].Status = 'In transit';
    expect(parseNovaPoshta(value, NUMBER)).toMatchObject({ status: 'in_transit', last_update: null, events: [] });
    expect(parseNovaPoshta(value, NUMBER).delivered_at).toBeUndefined();
  });
  it('preserves unknown codes and invalid receipt clocks', () => {
    const value = fixture(); value.data[0].StatusCode = 'NEW';
    const result = parseNovaPoshta(value, NUMBER); expect(result.status).toBe('unknown'); expect(result.current_stage).toBeUndefined();
    value.data[0].StatusCode = '9'; value.data[0].RecipientDateTime = '30-02-2026 12:00:00';
    expect(parseNovaPoshta(value, NUMBER).delivered_at).toBeUndefined();
  });
  it('accepts only the identity-bound official not-found code', () => {
    const value = fixture(); value.data[0].StatusCode = '3';
    expect(() => parseNovaPoshta(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    value.data[0].Number = '59000000000002';
    expect(() => parseNovaPoshta(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('rejects ambiguous identities, malformed status and API failures', () => {
    const duplicate = fixture(); duplicate.data.push(duplicate.data[0]);
    expect(() => parseNovaPoshta(duplicate, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const missing = fixture(); missing.data[0].Status = {};
    expect(() => parseNovaPoshta(missing, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const error = fixture(); error.errors = ['Service error'];
    expect(() => parseNovaPoshta(error, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });
});
describe('Nova Poshta movement parser', () => {
  it('projects only actual dated movements and keeps the carrier current point', () => {
    const result = parseNovaPoshtaHistory(history(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-01-03T10:00:00Z',
      last_update: '2026-01-03T10:00:00Z', weight_kg: 2.5, destination_country: 'UA' });
    expect(result.expected_delivery).toBeUndefined();
    expect(result.events).toHaveLength(3); expect(result.summary_only).toBeUndefined();
    expect(result.events?.map(row => row.stage)).toEqual(['delivered', 'ready_for_pickup', 'accepted']);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE-SYNTHETIC|Future delivery/);
  });
  it('keeps the schedule only while the parcel is on its way', () => {
    const value = history(); value.tracking = value.tracking.slice(0, 1); value.tracking[0].event_status = 'now';
    expect(parseNovaPoshtaHistory(value, NUMBER)).toMatchObject({ status: 'in_transit', expected_delivery: '2026-01-03T12:00:00Z' });
    const waiting = history(); waiting.tracking = waiting.tracking.slice(0, 2); waiting.tracking[1].event_status = 'now';
    expect(parseNovaPoshtaHistory(waiting, NUMBER).expected_delivery).toBeUndefined();
  });
  it('names the branch or locker the parcel waits at or was collected from', () => {
    const value = history();
    for (const row of value.tracking) row.division_name = 'parcel locker 2';
    expect(parseNovaPoshtaHistory(value, NUMBER).pickup_point).toBe('parcel locker 2\nSample City');
    value.tracking = value.tracking.slice(0, 2); value.tracking[1].event_status = 'now'; delete value.tracking[1].settlement_name;
    expect(parseNovaPoshtaHistory(value, NUMBER)).toMatchObject({ current_stage: 'ready_for_pickup', pickup_point: 'parcel locker 2' });
    const door = history(); door.tracking[2].event = 'ReceivedDoors'; door.tracking[2].event_name = 'Delivered at the address';
    door.tracking[2].division_name = 'depot 1';
    expect(parseNovaPoshtaHistory(door, NUMBER)).toMatchObject({ status: 'delivered' });
    expect(parseNovaPoshtaHistory(door, NUMBER).pickup_point).toBeUndefined();
  });
  it('reads a return to the sending branch as returned, not delivered', () => {
    const value = history();
    value.tracking[1] = { ...value.tracking[1], code: '102', event: 'OrderCargoReturn', event_name: 'Return', division_name: 'customs terminal' };
    value.tracking[2] = { ...value.tracking[2], event: 'ShipmentReturnReceived', event_name: 'Returned', division_name: 'branch 1' };
    const result = parseNovaPoshtaHistory(value, NUMBER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map' });
    expect(result.events?.slice(0, 2).map(row => row.stage)).toEqual(['returned', 'returned']);
    expect(result.delivered_at).toBeUndefined(); expect(result.pickup_point).toBeUndefined();
    expect(result.expected_delivery).toBeUndefined(); expect(result.destination_country).toBeUndefined();
  });
  it('maps customs clearance in progress and a changed delivery time', () => {
    const value = history();
    value.tracking[0] = { ...value.tracking[0], code: '119', event: 'DeclarationCustomsClearanceInitiated', event_name: 'Customs clearance in progress' };
    value.tracking[1] = { ...value.tracking[1], code: '112', event: 'ChangingTheDateWithTimeInterval', event_name: 'The recipient has changed the delivery time' };
    const events = parseNovaPoshtaHistory(value, NUMBER).events!;
    expect(events[1]).toMatchObject({ stage: 'in_transit', stage_source: 'carrier_map', provider_code: '112' });
    expect(events[2]).toMatchObject({ stage: 'customs', stage_source: 'carrier_map', provider_code: '119' });
  });
  it('reads one parcel\'s size, the destination country and a partner abroad', () => {
    const value = history();
    value.parcels[0] = { ...value.parcels[0], length: 40, width: 30, height: 20.5 };
    value.recipient.country_code = 'de';
    value.alternativeNumbersGWNew.push({ name: 'ClientOrder', number: 'ORDER-1' }, { name: 'UPS', number: '1z999aa10123456784' });
    expect(parseNovaPoshtaHistory(value, NUMBER)).toMatchObject({ dimensions_text: '40 × 30 × 20.5 cm', destination_country: 'DE',
      delivery_carrier: 'ups', delivery_tracking_number: '1Z999AA10123456784' });
    value.parcels.push({ number: '59000000000001', length: 10, width: 10, height: 10 });
    value.alternativeNumbersGWNew = value.alternativeNumbersGWNew.filter((reference: { name: string }) => reference.name !== 'UPS');
    value.alternativeNumbersGWNew.push({ name: 'constructor', number: 'ABCDEFGH1234' });
    const result = parseNovaPoshtaHistory(value, NUMBER);
    expect(result.dimensions_text).toBeUndefined(); expect(result.delivery_carrier).toBeUndefined();
    value.alternativeNumbersGWNew.push({ name: 'PylonLogisticsUPS', number: '1Z999AA10123456784' });
    expect(parseNovaPoshtaHistory(value, NUMBER)).toMatchObject({ delivery_carrier: 'ups', delivery_tracking_number: '1Z999AA10123456784' });
  });
  it('binds rerouted movements only to returned delivery references', () => {
    const value = history(); value.alternativeNumbersGWNew.push({ name: 'NPU_Redirecting', number: '59000000000002' });
    value.tracking[2].parcel_number = '59000000000002'; value.tracking[2].number = '59000000000002';
    expect(parseNovaPoshtaHistory(value, NUMBER).status).toBe('delivered');
    value.alternativeNumbersGWNew[1].name = 'LightReturnNumber';
    expect(() => parseNovaPoshtaHistory(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    value.alternativeNumbersGWNew[1].name = 'UnknownReference';
    expect(() => parseNovaPoshtaHistory(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    value.alternativeNumbersGWNew.pop();
    expect(() => parseNovaPoshtaHistory(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('allows administrative references when the actual parcel identity is bound', () => {
    const value = history(); value.tracking[1].number = '104-SYNTHETIC'; value.tracking[1].code = '104';
    value.tracking[1].event = 'OrderRedirecting'; value.tracking[1].event_name = 'Delivery location has been changed';
    expect(parseNovaPoshtaHistory(value, NUMBER).events?.[1]?.stage).toBe('in_transit');
  });
  it('retains malformed clock uncertainty and unmapped new codes', () => {
    const value = history(); value.tracking[2].date = '2026-02-30T10:00:00Z'; value.tracking[2].code = 'NEW';
    const result = parseNovaPoshtaHistory(value, NUMBER);
    expect(result).toMatchObject({ status: 'unknown', last_update: null });
    expect(result.events?.[0]).toMatchObject({ provider_time_text: '2026-02-30T10:00:00Z' });
    expect(result.current_stage).toBeUndefined(); expect(result.delivered_at).toBeUndefined();
  });
  it('keeps empty and future-only paths inconclusive', () => {
    const value = history(); value.tracking = value.tracking.filter((row: { event_status: string }) => row.event_status === 'future');
    expect(() => parseNovaPoshtaHistory(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    value.tracking = [];
    expect(() => parseNovaPoshtaHistory(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });
  it.each(['+99:00', '+02:99', '+14:01'])('keeps impossible offset %s unresolved', offset => {
    const value = history(); value.tracking[2].date = `2026-01-03T10:00:00${offset}`;
    value.scheduled_delivery_date = value.tracking[2].date;
    const result = parseNovaPoshtaHistory(value, NUMBER);
    expect(result.last_update).toBeNull(); expect(result.delivered_at).toBeUndefined();
    expect(result.expected_delivery).toBeUndefined(); expect(result.events?.[0]?.time).toBeUndefined();
  });
  it('rejects wrong identities and malformed, oversized or ambiguous movements', () => {
    const wrong = history(); wrong.number = '59000000000002';
    expect(() => parseNovaPoshtaHistory(wrong, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const missing = history(); delete missing.tracking[0].parcel_number;
    expect(() => parseNovaPoshtaHistory(missing, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const state = history(); state.tracking[0].event_status = 'NEW';
    expect(() => parseNovaPoshtaHistory(state, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const ambiguous = history(); ambiguous.tracking[1].event_status = 'now';
    expect(() => parseNovaPoshtaHistory(ambiguous, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const huge = history(); huge.tracking = Array.from({ length: 1001 }, () => huge.tracking[0]);
    expect(() => parseNovaPoshtaHistory(huge, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});
describe('Nova Poshta retrieval', () => {
  it('requests anonymous movement history from the current public site', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(history())));
    await new NovaPoshtaTracker({ fetcher }).fetch(NUMBER);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://api.novapost.com/site/v.1.0/shipments/tracking/${NUMBER}`);
    expect(new Headers(init?.headers).get('Accept-Language')).toBe('en');
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    expect(init?.body).toBeUndefined(); expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('falls back to anonymous status after an inconclusive history reply', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ errors: { errorMessage: 'shipment_received' } }), { status: 422 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(fixture())));
    const result = await new NovaPoshtaTracker({ fetcher }).fetch(NUMBER);
    expect(result.summary_only).toBe(true); expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[1]!;
    expect(url).toBe('https://api.novaposhta.ua/v2.0/json/');
    expect(JSON.parse(init!.body as string)).toEqual({ modelName: 'TrackingDocument', calledMethod: 'getStatusDocuments',
      methodProperties: { Documents: [{ DocumentNumber: NUMBER, Phone: '' }], Language: 'EN' }, system: 'Tracking' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
  it('accepts only the official JSON absence response and never hides a wrong identity', async () => {
    const absent = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ errors: { errorMessage: 'not_found' } }), { status: 404 }));
    await expect(new NovaPoshtaTracker({ fetcher: absent }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    expect(absent).toHaveBeenCalledTimes(1);
    const wrong = history(); wrong.number = '59000000000002';
    const mixed = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(wrong)));
    await expect(new NovaPoshtaTracker({ fetcher: mixed }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    expect(mixed).toHaveBeenCalledTimes(1);
  });
  it('recognizes a waybill with movements and the official absence, and asks nothing for a number it does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(history())))
      .mockResolvedValueOnce(new Response(JSON.stringify({ errors: { errorMessage: 'not_found' } }), { status: 404 }));
    const carrier = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    await expect(carrier.recognize!(NUMBER)).resolves.toMatchObject({ known: true });
    await expect(carrier.recognize!(NUMBER)).resolves.toEqual({ known: false });
    await expect(carrier.recognize!('NP00000000000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  // Synthetic numbers in the layouts novapost.com's tracker routes to the same movement feed; none is a real parcel.
  const INTERNATIONAL = 'SHPL0000000001';
  const international = () => JSON.parse(JSON.stringify(history()).replaceAll(NUMBER, INTERNATIONAL));
  it('reads a Nova Post international number from the movement feed alone', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(international())));
    await expect(new NovaPoshtaTracker({ fetcher }).fetch(' shpl 0000000001 ')).resolves.toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(fetcher.mock.calls[0]![0]).toBe(`https://api.novapost.com/site/v.1.0/shipments/tracking/${INTERNATIONAL}`);
    for (const number of ['SHUA0000000001', 'TNUA0000000001', 'RSSHUA0000000001']) {
      await expect(new NovaPoshtaTracker({ fetcher }).fetch(number), number).rejects.toMatchObject({ kind: 'schema' });
    }
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('reads novapost.com links to the numbers it takes', () => {
    for (const [link, number] of [[`https://novapost.com/en-pl/tracking/${INTERNATIONAL}`, INTERNATIONAL],
      [`https://www.novapost.com/de-de/tracking/${NUMBER}/`, NUMBER]]) {
      expect(parseTrackingInput(link!), link).toMatchObject({ trackingNumber: number, carrier: 'nova-poshta' });
    }
    expect(parseTrackingInput('https://novapost.com/en-pl/tracking/NP00000000000001').carrier).not.toBe('nova-poshta');
  });
  it('never asks the older status API about an international number, which it reads as unknown', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ errors: { errorMessage: 'shipment_received' } }), { status: 422 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ errors: { errorMessage: 'not_found' } }), { status: 404 }));
    await expect(new NovaPoshtaTracker({ fetcher }).fetch(INTERNATIONAL)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(new NovaPoshtaTracker({ fetcher }).fetch(INTERNATIONAL)).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(Array(2).fill(`https://api.novapost.com/site/v.1.0/shipments/tracking/${INTERNATIONAL}`));
    const unknown = fixture(); unknown.data[0].Number = INTERNATIONAL; unknown.data[0].StatusCode = '3';
    expect(() => parseNovaPoshta(unknown, INTERNATIONAL)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });
  it('rejects cross-border input and cancellation before any request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['NP00000000000001', 'SHUA000000001', 'SH1A0000000001', 'XSHUA0000000001']) {
      await expect(new NovaPoshtaTracker({ fetcher }).fetch(number), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(new NovaPoshtaTracker({ fetcher }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
