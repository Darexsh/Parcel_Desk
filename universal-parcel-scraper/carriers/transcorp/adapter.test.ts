import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TRANSCORP_TRACK_URL, TranscorpTracker } from './adapter.js';
import { normalizeTranscorpNumber, parseTranscorp } from './parser.js';
import { statusMap, transcorpStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '1234067891';
const IN_TRANSIT = '0123456789';
const UNKNOWN = '0000000000';
const COMPONENT = 'text/x-component';
const NOT_FOUND = 'shipment with reference 0000000000 does not exist';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.rsc`, import.meta.url), 'utf8');
const bytes = (body: string) => new TextEncoder().encode(body);
const parse = (body: string, number: string, type = COMPONENT) => parseTranscorp(bytes(body), type, number);
const reply = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': COMPONENT, ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookupUrl = (number: string) => `${TRANSCORP_TRACK_URL}?references=${number}`;
/** A fixture with its answer, the last row, replaced. The stream's copy holds another row 41. */
const withAnswer = (body: string, replace: (row: string) => string) => {
  const at = body.lastIndexOf('\n41:') + 1;
  const end = body.indexOf('\n', at);
  return `${body.slice(0, at)}${replace(body.slice(at, end))}${body.slice(end)}`;
};
type Shipment = Record<string, unknown> & { shipmentTrackingEvents?: Record<string, unknown>[] };
/** The shipment of a fixture's answer, edited as JSON. */
const editShipment = (body: string, edit: (shipment: Shipment) => void) => withAnswer(body, (row) => {
  const element = JSON.parse(row.slice(3)) as [string, string, string, { shipment: Shipment }];
  edit(element[3].shipment);
  return `41:${JSON.stringify(element)}`;
});

describe('Transcorp HTTP adapter', () => {
  it('asks the tracking page for its server components once, with the whole airwaybill', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TranscorpTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 012 345 6789 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(lookupUrl(IN_TRANSIT));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { RSC: '1', Accept: COMPONENT, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'transcorp', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it("reads a legacy history newest first, with each clock read again in the shipment's country", () => {
    const result = parse(fixture('delivered'), DELIVERED);
    const event = (time: string, code: string, description: string, stage?: string, location?: string) => ({
      time, description, ...(location ? { location } : {}), provider_code: code, ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    });
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-01-15T13:20:00+03:00', delivered_at: '2026-01-15T13:20:00+03:00',
      expected_delivery: null, weight_kg: 1.25, service_name: 'Normal', destination_country: 'KW', timezone: 'Asia/Kuwait',
      events: [
        // The reply stamps 09:20Z: Kuwait's 13:20 read as Dubai time.
        event('2026-01-15T13:20:00+03:00', 'DELIVERED', 'Delivered', 'delivered', 'Sample Governorate, Kuwait'),
        event('2026-01-15T09:05:00+03:00', 'OUT_FOR_DELIVERY', 'Out For Delivery', 'out_for_delivery'),
        // Back at the hub after a run that did not deliver.
        event('2026-01-14T18:30:00+03:00', 'RETURNED_TO_FACILITY', 'Returned To Facility', 'in_transit'),
        event('2026-01-14T16:45:00+03:00', 'CONSIGNEE_UNREACHABLE', 'Consignee Unreachable', 'failed_attempt'),
        event('2026-01-14T12:00:00+03:00', 'CONSIGNEE_CONTACT_UPDATED', 'Consignee Contact Updated'),
        event('2026-01-14T09:10:00+03:00', 'OUT_FOR_DELIVERY', 'Out For Delivery', 'out_for_delivery'),
        event('2026-01-13T22:15:00+03:00', 'ARRIVED_AT_FACILITY', 'Arrived At Facility', 'in_transit'),
        // Picked up from customs: the parcel had already moved.
        event('2026-01-13T20:40:00+03:00', 'PICKED_UP', 'Picked Up', 'in_transit'),
        event('2026-01-13T15:00:00+03:00', 'CUSTOMS_CLEARANCE_COMPLETED', 'Customs Clearance Completed', 'in_transit'),
        event('2026-01-13T08:00:00+03:00', 'CUSTOMS_CLEARANCE_STATUS_UPDATED', 'Customs Clearance Status Updated', 'customs'),
        event('2026-01-12T23:30:00+03:00', 'ARRIVED_AT_CUSTOMS_CLEARANCE_FACILITY', 'Arrived At Customs Clearance Facility', 'customs'),
      ],
    });
    // Names, remarks, references, the courier, the area and the coordinates are dropped.
    expect(JSON.stringify(result)).not.toMatch(/Test (?:Driver|Recipient)|Synthetic|Block 0|EXAMPLE-HUB|0000000000|KWD|lat/);
  });

  it('reads a current history as instants, with the consignee country only', () => {
    const result = parse(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Notification Sent',
      last_update: '2026-02-03T06:00:00Z', expected_delivery: null, weight_kg: 0.5, service_name: 'Express', destination_country: 'SA',
      timezone: 'Asia/Dubai' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.location])).toEqual([
      ['2026-02-03T06:00:00Z', 'NOTIFICATION_SENT', undefined, undefined],
      // A subdivision code is not a place name.
      ['2026-02-03T05:30:00Z', 'DEPARTED_FACILITY', 'in_transit', 'United Arab Emirates'],
      ['2026-02-02T20:00:00Z', 'ARRIVED_AT_FACILITY', 'in_transit', undefined],
      // The first pickup accepts the parcel.
      ['2026-02-02T11:15:00Z', 'PICKED_UP', 'accepted', undefined],
      ['2026-02-01T09:00:00Z', 'PICKUP_SCHEDULED', 'registered', undefined],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Test Consignee|Example (?:Street|District|Shop|Area|Hub)|\+0|synthetic|DRIVER_APP/);
  });

  it('keeps a legacy clock as a wall clock when the country has no single zone', () => {
    const body = editShipment(fixture('delivered'), (shipment) => { shipment.operatingCountry = '$undefined'; });
    const result = parse(body, DELIVERED);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-01-15T13:20:00' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('timezone');
    expect(result.events![0]).toMatchObject({ local_time: '2026-01-15T13:20:00', provider_code: 'DELIVERED' });
    expect(result.events![0]).not.toHaveProperty('time');
  });

  it("reads the backend's message as not found only for the number asked", () => {
    expect(() => parse(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The answer is keyed with another reference.
    expect(() => parse(fixture('not-found'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Elite answered for another number' }));
    // The message names another reference.
    expect(() => parse(fixture('not-found').replace('reference 0000000000', 'reference 1234067891'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The shipment is another one.
    expect(() => parse(editShipment(fixture('delivered'), (shipment) => { shipment.houseWaybillNumber = UNKNOWN; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Elite answered for another number' }));
    // A failed backend lookup is no answer either way.
    expect(() => parse(fixture('not-found').replace(NOT_FOUND, 'failed to get shipment'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('ignores the copy of the page the stream repeats', () => {
    // The stream's copy holds an answer for another number; read as rows, it would be a second answer.
    const delivered = fixture('delivered');
    expect(delivered).toMatch(/2f:o[0-9a-f]+,0:\{"q":"\?references=0000000000"\}\n41:/);
    expect(parse(delivered, DELIVERED)).toMatchObject({ current_stage: 'delivered' });
  });

  it('rejects a changed page', () => {
    const delivered = fixture('delivered');
    for (const body of [
      // No answer component.
      withAnswer(delivered, () => ''),
      // Two answers.
      withAnswer(delivered, (row) => `${row}\n45${row.slice(2)}`),
      // The events moved elsewhere.
      editShipment(delivered, (shipment) => { delete shipment.shipmentTrackingEvents; }),
      // An event without its time or type.
      editShipment(delivered, (shipment) => { shipment.shipmentTrackingEvents![0]!.timestamp = '2026-01-15 09:20'; }),
      editShipment(delivered, (shipment) => { shipment.shipmentTrackingEvents![0]!.type = '$undefined'; }),
      // A stream chunk cut short.
      delivered.slice(0, delivered.indexOf('2f:o') + 30),
      // Lines that are not Flight rows.
      'not a flight reply\n',
    ]) {
      expect(() => parse(body, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // An unknown message.
    expect(() => parse(fixture('not-found').replace(NOT_FOUND, 'something else'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse('{"references":"1234067891"}', DELIVERED, 'application/json')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse('<!DOCTYPE html><html><body>Track Shipments</body></html>', DELIVERED, 'text/html'))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse('', DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads a shipment without events as no history yet', () => {
    const body = editShipment(fixture('delivered'), (shipment) => { shipment.shipmentTrackingEvents = []; });
    expect(() => parse(body, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads a failed render as inconclusive and Next’s redirect as a changed route', () => {
    const page = withAnswer(fixture('not-found'), () => '');
    expect(() => parse(`${page}41:E{"digest":"1234567890"}\n`, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse(`${page}41:E{"digest":"NEXT_REDIRECT;replace;/auth/login;307;"}\n`, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a moved page, a browser check and a limit apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // An unknown number is a 200 page naming it: a 404 or a redirect is a moved page.
    await expect(lookup('<html><body>404: This page could not be found.</body></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 307, headers: { Location: 'https://app.elite-co.com/auth/login' } })).rejects.toMatchObject({ kind: 'transport' });
    // Vercel's checkpoint, by its header or its page, even with HTTP 200.
    await expect(lookup('', { status: 429, headers: { 'x-vercel-mitigated': 'challenge' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Vercel Security Checkpoint</title></head></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('', { status: 429, headers: { 'Retry-After': '30' } })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known airwaybill with its last instant and the backend message, and asks nothing for another layout', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-01-15T10:20:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    // A reply about another number is no answer either way.
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(fetcher).recognize!('123456789')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers Elite does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['123456789', '12345678901', '123456789A', 'ABCDEFGHIJ', '1234567890,0123456789', `${'0'.repeat(70)}`, '']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTranscorpNumber('123-406-7891')).toBe(DELIVERED);
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a number filed under Transcorp to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'transcorp' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'transcorp', source: 'transcorp', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([lookupUrl(DELIVERED)]);
  });
});

describe('Transcorp status vocabulary', () => {
  it('stages every recorded event type by its code, a first pickup as accepted and a later one as in transit', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage?: string }[]) {
      expect(transcorpStage(entry.code, false)?.stage, entry.code).toBe(entry.stage);
      if (entry.code !== 'PICKED_UP') expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
    }
    expect(transcorpStage('PICKED_UP', true)).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(statusMapAnswer({ carrier: 'transcorp', providerCode: 'DELIVERED', description: 'Delivered' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'transcorp', providerCode: 'COURIER_ASSIGNED', description: 'Courier Assigned' }))
      .toEqual({ kind: 'intentional_gap', note: expect.any(String) });
    // A pickup's stage depends on the events before it.
    expect(statusMapAnswer({ carrier: 'transcorp', providerCode: 'PICKED_UP', description: 'Picked Up' })).toEqual({ kind: 'unknown' });
  });
});
