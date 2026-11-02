import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, INTERNET_EXPRESS_API, InternetExpressTracker } from './adapter.js';
import { normalizeInternetExpressNumber, parseInternetExpress } from './parser.js';
import { internetExpressStage, internetExpressWording, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '000000002';
const IN_TRANSIT = '000000001';
const UNKNOWN = '000000000';

type Row = Record<string, unknown>;
type Shipment = Row & { tracking_events: Row[] };
type Reply = Row & { shipments: Shipment[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const notFound = () => readFileSync(new URL('./fixtures/not-found.txt', import.meta.url), 'utf8');
const changed = (name: string, change: (shipment: Shipment, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.shipments[0]!, reply);
  return reply;
};
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Internet Express HTTP adapter', () => {
  it('asks the portal’s lookup once for the whole reference in capitals, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new InternetExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 0000 00001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${INTERNET_EXPRESS_API}?tracking_reference=${IN_TRANSIT}&provider_id=9`);
    expect(init).toMatchObject({ cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(new Headers(init?.headers).has('Cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'internet-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps the shipment’s own timeline as instants, without hidden events, pieces’ scans or messages', () => {
    const result = parseInternetExpress(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-05T11:02:40.401Z', delivered_at: '2026-03-05T11:02:40.401Z',
      expected_delivery: null, service_name: 'Synthetic Economy' });
    expect(result).not.toHaveProperty('provider_code');
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage ?? null, event.location ?? null])).toEqual([
      ['2026-03-05T11:02:40.401Z', 'delivered', 'delivered', 'IE EXB'],
      ['2026-03-05T10:58:12.750Z', 'out-for-delivery', 'out_for_delivery', null],
      ['2026-03-05T10:47:03.100Z', 'out-for-delivery', 'out_for_delivery', null],
      ['2026-03-05T05:15:44.204Z', 'out-for-delivery', 'out_for_delivery', 'IE EXB'],
      // Two scans with one clock keep the reply's order.
      ['2026-03-04T12:01:30.550Z', 'delivery-assigned', 'in_transit', 'IE EXB'],
      ['2026-03-04T12:01:30.550Z', 'at-destination-hub', 'in_transit', 'IE EXB'],
      ['2026-03-03T14:21:40.618Z', 'in-transit', 'in_transit', 'IE SPT'],
      ['2026-03-03T14:20:05.250Z', 'collected', 'accepted', 'Internet Express Sampleton'],
      // A failed collection leaves the parcel waiting for collection.
      ['2026-03-02T13:40:12.900Z', 'collection-failed-attempt', 'registered', 'Internet Express Sampleton'],
      ['2026-03-02T05:10:11.980Z', 'collection-assigned', 'registered', 'Internet Express Sampleton'],
      ['2026-03-02T05:10:11.950Z', 'submitted', 'registered', 'Internet Express Sampleton'],
    ]);
    expect(result.events!.map((event) => event.description)).toContain('Delivery assigned to driver');
    expect(JSON.stringify(result)).not.toMatch(/PIN|SMS|remark|Outbound|000000002\/1/);
  });

  it('takes the summary’s status, and for one the portal hides, the newest scan it shows', () => {
    const moving = parseInternetExpress(fixture('in-transit'), IN_TRANSIT);
    expect(moving).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'In transit',
      last_update: '2026-04-11T15:45:12.250Z' });
    expect(moving).not.toHaveProperty('delivered_at');
    // The piece's own hub scan is not the shipment's.
    expect(moving.events!.map((event) => event.provider_code)).toEqual(['in-transit', 'collected', 'collection-assigned', 'submitted']);
    const held = parseInternetExpress(changed('in-transit', (shipment) => { shipment.status = 'on-hold-internal'; }), IN_TRANSIT);
    expect(held).toMatchObject({ current_stage: 'in_transit', last_status_text: 'In transit' });
    const customs = parseInternetExpress(changed('in-transit', (shipment) => { shipment.status = 'inbound-customs-and-vat'; }), IN_TRANSIT);
    expect(customs).toMatchObject({ status: 'in_transit', current_stage: 'customs', last_status_text: 'Inbound customs and VAT',
      provider_code: 'inbound-customs-and-vat' });
    const unknown = parseInternetExpress(changed('in-transit', (shipment) => { shipment.status = 'synthetic-state'; }), IN_TRANSIT);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic state' });
    expect(unknown).not.toHaveProperty('current_stage');
  });

  it('counts a shipment only when it is Internet Express’s and carries the reference asked', () => {
    expect(parseInternetExpress(fixture('delivered'), 'zzzzz2').status).toBe('delivered');
    expect(parseInternetExpress(changed('delivered', (shipment) => { shipment.custom_tracking_reference = DELIVERED.toLowerCase(); }), DELIVERED).status)
      .toBe('delivered');
    expect(() => parseInternetExpress(fixture('delivered'), IN_TRANSIT)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseInternetExpress(fixture('delivered'), '0000000021')).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseInternetExpress(changed('delivered', (shipment) => { shipment.provider_id = 7; }), DELIVERED))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseInternetExpress(changed('delivered', (_, reply) => { reply.shipments.push(reply.shipments[0]!); }), DELIVERED))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseInternetExpress({ shipments: [] }, DELIVERED))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    expect(() => parseInternetExpress(changed('delivered', (shipment) => {
      shipment.tracking_events = shipment.tracking_events.filter((row) => row.parcel_id !== 0);
    }), DELIVERED)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    const changes: Array<(shipment: Shipment, reply: Reply) => void> = [
      (_, reply) => { delete (reply as Row).shipments; },
      (shipment) => { shipment.status = 'Delivered'; },
      (shipment) => { shipment.tracking_events = {} as never; },
      (shipment) => { shipment.tracking_events[0]!.date = '2026-03-05 11:02:40'; },
      (shipment) => { shipment.tracking_events[0]!.date = '2026-03-05T11:02:40'; },
      (shipment) => { shipment.tracking_events[0]!.status = { code: 'delivered' }; },
      (shipment) => { shipment.tracking_events[0]!.parcel_id = '0'; },
      (shipment) => { shipment.tracking_events[0]!.location = ['IE EXB']; },
      (shipment) => { shipment.tracking_events = Array.from({ length: 501 }, () => shipment.tracking_events[0]!); },
    ];
    for (const change of changes) {
      expect(() => parseInternetExpress(changed('delivered', change), DELIVERED), String(change)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads the service’s own answer for an unknown reference as not found, and other refusals apart', async () => {
    const cases: Array<[Response, string]> = [
      [new Response(notFound(), { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }), 'not_found'],
      [new Response(`could not find shipment or parcel with reference ${IN_TRANSIT}`, { status: 404 }), 'indeterminate'],
      [new Response('{"message":"Not Found"}', { status: 404 }), 'indeterminate'],
      [new Response(notFound(), { status: 410 }), 'indeterminate'],
      [new Response('{"message":"Forbidden"}', { status: 403 }), 'challenge'],
      [new Response('{"message":"Too Many Requests"}', { status: 429 }), 'rate_limited'],
      [new Response('<html><title>Just a moment...</title></html>', { status: 200 }), 'challenge'],
      [new Response('<html>Unavailable</html>', { status: 200 }), 'schema'],
      [new Response('{"message":"Internal server error"}', { status: 500 }), 'indeterminate'],
    ];
    for (const [response, kind] of cases) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(new InternetExpressTracker({ fetcher }).fetch(UNKNOWN), kind).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('rejects references Internet Express does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['0000', '000000001&provider_id=7', '0'.repeat(41), '000/00001']) {
      expect(() => normalizeInternetExpressNumber(number), number).toThrow(InvalidInputError);
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(new InternetExpressTracker({ fetcher }).fetch(IN_TRANSIT, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(carrier(fetcher).recognize).toBeUndefined();
  });

  it('routes a reference filed under Internet Express to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'internet-express' }, { budgetMs: 3000 })).resolves.toMatchObject({
      carrier: 'internet-express', source: 'internet-express', result: { current_stage: 'delivered', service_name: 'Synthetic Economy' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(INTERNET_EXPRESS_API))).toBe(true);
  });
});

describe('Internet Express status vocabulary', () => {
  it('records every code it saw with the stage the map gives it', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string }[]) {
      // The progress rail's first step is a label, not a scan code.
      if (entry.code === 'created') continue;
      expect(internetExpressStage(entry.code), entry.code).toBe(entry.stage);
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'internet-express', providerCode: 'out-for-delivery', description: 'Out for delivery' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'internet-express', providerCode: 'synthetic-state', description: 'Synthetic state' })).toEqual({ kind: 'unknown' });
    expect(internetExpressWording('collection-assigned')).toBe('Collection assigned to driver');
    expect(internetExpressWording('ready-for-pickup')).toBe('Ready for pickup');
  });
});
