import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CHRONODIALI_API, ChronodialiTracker } from './adapter.js';
import { normalizeChronodialiNumber, parseChronodiali } from './parser.js';
import { chronodialiStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'CHPU1234067890123456780';
const IN_TRANSIT = 'CD1234567890';
const UNKNOWN = 'CHPU0000000000000000000';

type Row = Record<string, unknown>;
type Shipment = Row & { events: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Shipment;
const changed = (name: string, change: (shipment: Shipment) => void) => {
  const shipment = fixture(name);
  change(shipment);
  return shipment;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const notFound = () => reply(fixture('not-found'), { status: 400 });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Chronodiali HTTP adapter', () => {
  it('asks the tracking page’s Shipsy lookup for the whole number once, with the page’s key, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ChronodialiTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' cd 1234-567-890 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${CHRONODIALI_API}?reference_number=${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'api-key': expect.stringMatching(/^[0-9a-f]{30}$/), 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'chronodiali', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps a delivery’s scans as instants, staged by their type, without the courier’s call or a repeated scan', () => {
    const result = parseChronodiali(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Le colis a été livré.', last_update: '2026-05-06T14:20:00Z', delivered_at: '2026-05-06T14:20:00Z',
      expected_delivery: null, destination_country: 'MA' });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.location])).toEqual([
      ['2026-05-06T14:20:00Z', 'delivered', 'delivered', 'Exampleville'],
      ['2026-05-06T09:40:00Z', 'accept', 'out_for_delivery', 'Exampleville'],
      ['2026-05-06T09:05:00Z', 'delivery_scheduled', 'in_transit', 'Exampleville'],
      ['2026-05-06T06:30:00Z', 'reachedathub', 'in_transit', 'Exampleville'],
      ['2026-05-05T20:15:00Z', 'intransittohub', 'in_transit', 'Sampletown'],
      ['2026-05-05T17:45:00Z', 'inscan_at_hub', 'in_transit', 'Sampletown'],
      ['2026-05-05T13:10:00Z', 'pickup_completed', 'accepted', 'Sampletown'],
      ['2026-05-04T10:00:00Z', 'softdata_upload', 'registered', 'Sampletown'],
    ]);
    // The page's own message where it has one, else the reply's label; never the delivery trip.
    expect(result.events!.slice(1, 3).map((event) => event.description)).toEqual(['Out For Delivery', 'Delivery Scheduled']);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.local_time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Sender|Recipient|Courier|Shop|goods)|\+0{12}|Sample Street|Example Avenue|SAMPLE-|SMPL|FLM Trip|example\.invalid|249|0\.5|Call Log/);
  });

  it('keeps a parcel from abroad waiting for customs, without the partner hub as a place', () => {
    const result = parseChronodiali(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map',
      last_status_text: 'dédouanement en cours', last_update: '2026-07-20T10:05:00Z', expected_delivery: null, destination_country: 'MA' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['pending_custom', 'customs', null],
      // Two scans at one clock keep the reply's order.
      ['arrived_in_country', 'in_transit', 'Sampletown'],
      ['inscan_at_hub', 'in_transit', null],
      ['pickup_awaited', 'registered', 'Sampletown'],
    ]);
  });

  it('takes the shipment’s own status over its newest scan, and reads a history listed oldest first', () => {
    const returned = parseChronodiali(changed('in-transit', (shipment) => { shipment.status = 'rto'; }), IN_TRANSIT);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'dédouanement en cours' });
    const unmapped = parseChronodiali(changed('in-transit', (shipment) => { shipment.status = 'synthetic_status'; }), IN_TRANSIT);
    expect(unmapped).toMatchObject({ current_stage: 'customs' });
    const reversed = parseChronodiali(changed('delivered', (shipment) => { shipment.events.reverse(); }), DELIVERED);
    expect(reversed).toMatchObject({ last_update: '2026-05-06T14:20:00Z', delivered_at: '2026-05-06T14:20:00Z' });
    expect(reversed.events!.at(-1)).toMatchObject({ provider_code: 'softdata_upload' });
  });

  it('keeps scans of one instant in the reply’s order, whichever way it lists them', () => {
    const codes = (shipment: Shipment) => parseChronodiali(shipment, IN_TRANSIT).events!.map((event) => event.provider_code);
    expect(codes(changed('in-transit', (shipment) => { shipment.events.reverse(); }))).toEqual(codes(fixture('in-transit')));
  });

  it('reads a shipment without scans from its own status, and one without either as no history', () => {
    const created = parseChronodiali(changed('in-transit', (shipment) => { shipment.events = []; shipment.status = 'softdata_upload'; }), IN_TRANSIT);
    expect(created).toMatchObject({ status: 'pending', current_stage: 'registered', summary_only: true, provider_code: 'softdata_upload',
      last_status_text: 'Les données du colis ont été intégrées dans nos systèmes.', last_update: null, events: [] });
    expect(() => parseChronodiali(changed('in-transit', (shipment) => { shipment.events = []; shipment.status = 'synthetic_status'; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads the tracker’s unknown-number answer as not found and its other errors as inconclusive', () => {
    expect(() => parseChronodiali(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseChronodiali({ error: { message: 'Synthetic failure', statusCode: 400, reason: 'WRONG_INPUT' } }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('counts a shipment only when it names the number asked', () => {
    expect(() => parseChronodiali(fixture('in-transit'), 'CD0000000000'))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Chronodiali answered for another shipment' }));
    expect(() => parseChronodiali(changed('delivered', (shipment) => { shipment.reference_number = `${DELIVERED}0`; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseChronodiali(changed('in-transit', (shipment) => { shipment.reference_number = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events)
      .toHaveLength(4);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (shipment: Shipment) => { delete shipment.reference_number; },
      (shipment: Shipment) => { shipment.reference_number = 7; },
      (shipment: Shipment) => { shipment.events = 'events' as never; },
      (shipment: Shipment) => { shipment.events = Array.from({ length: 501 }, () => shipment.events[0]!); },
      (shipment: Shipment) => { shipment.events[0] = 'scan' as never; },
      (shipment: Shipment) => { delete shipment.events[0]!.type; },
      (shipment: Shipment) => { shipment.events[0]!.type = ['delivered']; },
      (shipment: Shipment) => { shipment.events[0]!.event_time = '2026-05-06T14:20:00Z'; },
      (shipment: Shipment) => { shipment.events[0]!.event_time = 1_778_077_200; },
      (shipment: Shipment) => { shipment.events[0]!.hub_name = { name: 'Exampleville' }; },
      (shipment: Shipment) => { shipment.status = 7; },
      (shipment: Shipment) => { shipment.error = 'Synthetic failure'; },
    ]) {
      expect(() => parseChronodiali(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseChronodiali('shipment', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a moved route, a refused key, a browser check and a broken reply apart', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: UNKNOWN });
    await expect(lookup(notFound())).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(reply(fixture('not-found'), { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response('', { status: 301, headers: { Location: 'https://chronodiali.ma/' } }))).rejects.toMatchObject({ kind: 'transport' });
    // Shipsy's answer when the page's key is withdrawn.
    await expect(lookup(reply({ error: { reason: 'WRONG_API_KEY', message: 'Wrong API key', statusCode: 401 } }, { status: 401 })))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(reply('<html><head><title>Just a moment...</title></head></html>', { status: 403, headers: { 'Content-Type': 'text/html' } })))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(reply('<html><script>window._cf_chl_opt = {}</script></html>', { headers: { 'Content-Type': 'text/html' } })))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(reply('<html><title>Chronodiali</title></html>', { status: 400 }))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number with its last activity and the unknown-number answer, and asks nothing for a number Chronodiali does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered'))).mockResolvedValueOnce(notFound());
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-05-06T14:20:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('CHPU00')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Chronodiali does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['CHPU000000000000000000', 'CHPU00000000000000000000', 'CD000000000', 'CD00000000000', 'CX0000000000', 'CHPU']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeChronodialiNumber('chpu 1234-0678-9012-3456-780')).toBe(DELIVERED);
  });

  it('sends a read that fails to reach the service once more within the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 3000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('routes a number filed under Chronodiali, or detected as one of its numbers, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'chronodiali' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'chronodiali', source: 'chronodiali', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'chronodiali', source: 'chronodiali' });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(CHRONODIALI_API))).toBe(true);
  });
});

describe('Chronodiali numbers', () => {
  it('claims CHPU and 19 digits, and only suggests Chronodiali for CD references, which recognition asks it about', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'chronodiali', confidence: 'high' });
    expect(detectCarrierMatch(UNKNOWN)).toMatchObject({ carrier: 'chronodiali', confidence: 'high' });
    expect(detectCarrierMatch(IN_TRANSIT)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch(IN_TRANSIT).candidates).toContain('chronodiali');
    expect(recognitionAskedCarriers(IN_TRANSIT, { countryHint: 'MA' })).toContain('chronodiali');
    for (const number of ['CHPU123456789012345678', 'CD123456789', 'CD12345678901', 'CE1234567890']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('chronodiali');
    }
  });
});

describe('Chronodiali status vocabulary', () => {
  it('records every type and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBeUndefined();
        continue;
      }
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(chronodialiStage(entry.code, entry.wording)?.stage, entry.code).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'chronodiali', providerCode: 'accept', description: 'Out For Delivery' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'chronodiali', providerCode: 'synthetic_type', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A type the map does not know falls to the shared wording rules.
    expect(chronodialiStage('synthetic_type', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(chronodialiStage('synthetic_type', 'Synthetic note')).toBeNull();
    expect(chronodialiStage('Handover_to_third_party', 'Le colis a été confié à un partenaire tiers.'))
      .toEqual({ stage: 'in_transit', source: 'carrier_map' });
  });
});
