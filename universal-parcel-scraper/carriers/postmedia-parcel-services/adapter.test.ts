import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { activeRequirements, carrierDefinition } from '../../core/catalog/index.js';
import { normalizeCarrierInputs } from '../../core/catalog/inputs.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PostmediaTracker, postmediaQueryUrl } from './adapter.js';
import { normalizePostmediaNumber, normalizePostmediaPostcode, parsePostmedia } from './parser.js';
import { postmediaStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'BNI000000001';
const MOVING = 'BNI000000002';
const UNKNOWN = 'BNI000000000';
// Z starts no Canadian postal code.
const POSTCODE = 'Z9Z 9Z9';

type Row = Record<string, unknown>;
type Reply = Record<string, unknown> & { statuses: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookup = (fetcher: typeof fetch, number = DELIVERED, postcode: string | null = POSTCODE) => carrier(fetcher).track({ number, postcode });
const answering = (...responses: Response[]) => {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  return fetcher;
};
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Postmedia Parcel Services HTTP adapter', () => {
  it('asks the tracker’s API for the whole number and the postal code once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PostmediaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' bni 000-000-002 ', ' z9z9z9 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    // The page puts the space back into a six-character postal code.
    expect(String(url)).toBe(`https://pmparcelservicesapi.postmediaparcelservices.com/query/${MOVING}+Z9Z%209Z9`);
    expect(String(url)).toBe(postmediaQueryUrl(MOVING, POSTCODE));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'postmedia-parcel-services', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery with its scans as GMT instants, newest first, each with its town and province', () => {
    const result = parsePostmedia(fixture('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-09-16T15:23:56Z', expected_delivery: null, delivered_at: '2026-09-16T15:23:56Z',
      events: [
        { time: '2026-09-16T15:23:56Z', location: 'Exampleford, Nova Scotia', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2026-09-16T10:06:11Z', location: 'Testbury, Nova Scotia', description: 'Out for delivery', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2026-09-15T20:44:30Z', location: 'Testbury, Nova Scotia', description: 'Arrival Scan/Received Hub', stage: 'accepted', stage_source: 'carrier_map' },
        // The page writes the province's name for its code.
        { time: '2026-09-14T10:38:36Z', location: 'SAMPLETON, Ontario', description: 'Shipment has left seller facility and is in transit',
          stage: 'in_transit', stage_source: 'carrier_map' },
      ],
    });
    // The order date and the record ids are not read.
    expect(JSON.stringify(result)).not.toMatch(/a4[67]0{9}|2026-09-14"/);
  });

  it('reads a parcel out for delivery with its expected day, its scans across midnight in GMT in order', () => {
    const result = parsePostmedia(fixture('in-transit'), MOVING);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Out for delivery',
      last_update: '2026-11-24T20:20:50Z', expected_delivery: '2026-11-24' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.location, event.stage])).toEqual([
      ['2026-11-24T20:20:50Z', 'Fakeview, British Columbia', 'out_for_delivery'],
      ['2026-11-24T16:22:51Z', 'Fakeview, British Columbia', 'accepted'],
      ['2026-11-23T22:22:34Z', 'Mockridge, British Columbia', 'in_transit'],
    ]);
    // An estimate that names no day is left out.
    expect(parsePostmedia(changed('in-transit', (body) => { body.expected_delivery_date = '2026-13-01'; }), MOVING)).toMatchObject({ expected_delivery: null });
    expect(parsePostmedia(changed('in-transit', (body) => { delete body.expected_delivery_date; }), MOVING)).toMatchObject({ expected_delivery: null });
  });

  it('reads a parcel waiting for collection, and never the pickup point’s address', () => {
    const waiting = changed('in-transit', (body) => {
      body.statuses.push({ ...body.statuses[2], event_date_time: '2026-11-25 01:10:00', parcel_status_message: 'Available for pickup',
        parcel_status_message_french: 'Disponible pour ramassage', pickup_information: { shipping_street: '1 Synthetic Lane', shipping_city: 'Fakeview',
          shipping_state: 'BC', shipping_country: 'Canada', shipping_postal_code: POSTCODE, description: 'Synthetic Depot, open daily' } });
    });
    const result = parsePostmedia(waiting, MOVING);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', last_update: '2026-11-25T01:10:00Z' });
    expect(JSON.stringify(result)).not.toMatch(/Synthetic|Z9Z/);
  });

  it('falls back to the French message, leaves out a scan without either, and keeps equal scans once', () => {
    const result = parsePostmedia(changed('delivered', (body) => {
      body.statuses[3]!.parcel_status_message = 'null';
      body.statuses[2]!.parcel_status_message = null;
      body.statuses[2]!.parcel_status_message_french = 'null';
      body.statuses.push({ ...body.statuses[1] });
    }), DELIVERED);
    expect(result.events!.map((event) => [event.description, event.stage])).toEqual([
      ['Livré', 'delivered'], ['Arrival Scan/Received Hub', 'accepted'], ['Shipment has left seller facility and is in transit', 'in_transit'],
    ]);
    // A wording the map does not know falls to the shared rules.
    expect(parsePostmedia(changed('in-transit', (body) => { body.statuses[2]!.parcel_status_message = 'Synthetic note'; }), MOVING).events![0])
      .not.toHaveProperty('stage');
    // Scans that all lack a message, or none at all, are no history.
    for (const rows of [[], [{ ...fixture('delivered').statuses[0], parcel_status_message: '', parcel_status_message_french: null }]]) {
      expect(() => parsePostmedia({ ...fixture('delivered'), statuses: rows }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('reads the tracker’s notice for a number and postal code it holds nothing under as not found', async () => {
    expect(() => parsePostmedia(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(lookup(answering(reply(fixture('not-found'))), UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    // Another notice is no answer about the parcel.
    for (const notice of ['Synthetic notice', null, 7]) {
      expect(() => parsePostmedia({ missing_error: notice }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('binds the answer to the whole number asked', async () => {
    expect(() => parsePostmedia(fixture('delivered'), MOVING))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Postmedia Parcel Services answered for another parcel' }));
    await expect(lookup(answering(reply(fixture('delivered'))), 'BNI000000010')).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(() => parsePostmedia(changed('delivered', (body) => { delete body.tracking_id; }), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parsePostmedia(changed('delivered', (body) => { body.tracking_id = 'bni000000001'; }), DELIVERED)).toMatchObject({ status: 'delivered' });
  });

  it('keeps a browser check, a moved API and a changed reply apart from a missing parcel', async () => {
    await expect(lookup(answering(reply(CHECK, { headers: { 'Content-Type': 'text/html' } })))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(answering(reply(CHECK, { status: 403, headers: { 'Content-Type': 'text/html' } })))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(answering(reply({ message: 'Forbidden' }, { status: 403 })))).rejects.toMatchObject({ kind: 'challenge' });
    for (const moved of [reply({ message: 'Missing Authentication Token' }, { status: 403 }), reply('', { status: 404 }),
      new Response(null, { status: 301, headers: { Location: 'https://postmediaparcelservices.com/' } })]) {
      await expect(lookup(answering(moved))).rejects.toMatchObject({ kind: 'transport' });
    }
    await expect(lookup(answering(reply('<html><title>Postmedia</title></html>', { headers: { 'Content-Type': 'text/html' } }))))
      .rejects.toMatchObject({ kind: 'schema' });
    for (const change of [
      (body: Reply) => { body.statuses = 'none' as unknown as Row[]; },
      (body: Reply) => { delete (body as Partial<Reply>).statuses; },
      (body: Reply) => { body.statuses[0]!.event_date_time = '2026-09-14T10:38:36'; },
      (body: Reply) => { body.statuses[0]!.event_date_time = '2026-09-31 10:38:36'; },
      (body: Reply) => { body.statuses[0]!.event_date_time = '2026-09-14 24:00:00'; },
      (body: Reply) => { body.statuses[0]!.event_city = 12; },
      (body: Reply) => { body.statuses[1] = 'scan' as unknown as Row; },
      (body: Reply) => { body.statuses = Array.from({ length: 201 }, () => body.statuses[0]!); },
    ]) {
      expect(() => parsePostmedia(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parsePostmedia([], DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps a rate limit with its retry window, without a retry', async () => {
    const fetcher = answering(new Response('{"message":"Too Many Requests"}', { status: 429, headers: { 'Retry-After': '30' } }));
    await expect(lookup(fetcher)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('takes BNI and nine digits and the recipient’s postal code, without a request otherwise', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['BNI00000001', 'BNI0000000001', 'BNX000000001', '000000001', 'BNI00000000A']) {
      await expect(lookup(fetcher, number), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(lookup(fetcher, DELIVERED, null)).rejects.toMatchObject({ kind: 'input_required', field: 'postcode' });
    await expect(lookup(fetcher, DELIVERED, '  ')).rejects.toMatchObject({ kind: 'input_required', field: 'postcode' });
    for (const postcode of ['ZZZ', 'Z9', 'Z9Z 9Z9 Z9Z 9Z9', 'Z9Z_9Z9']) {
      await expect(lookup(fetcher, DELIVERED, postcode), postcode).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizePostmediaNumber('bni 000 000 001')).toBe(DELIVERED);
    for (const postcode of ['z9z9z9', ' Z9Z  9Z9 ', 'z9z-9z9']) expect(normalizePostmediaPostcode(postcode)).toBe(POSTCODE);
    // Another code goes as typed, in capitals; the tracker answers whether it holds a parcel under it.
    expect(normalizePostmediaPostcode('9z9 z9z')).toBe('9Z9 Z9Z');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(reply(fixture('delivered')));
    await expect(lookup(flaky)).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>();
    await expect(carrier(immediate).track({ number: DELIVERED, postcode: POSTCODE }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED, postcode: POSTCODE }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED, postcode: POSTCODE }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    await expect(lookup(answering(new Response(new Uint8Array(300_000))))).rejects.toThrow('unexpectedly large');
  });

  it('asks for the recipient’s postal code in the catalog, and routes a number filed with one to the adapter', async () => {
    expect(activeRequirements('postmedia-parcel-services', DELIVERED)).toHaveLength(1);
    const [requirement] = carrierDefinition('postmedia-parcel-services').tracking.requirements ?? [];
    expect(requirement).toMatchObject({ field: 'postcode', validator: 'internationalPostcode', maxLength: 7 });
    expect(requirement).not.toHaveProperty('optional');
    // The form takes a Canadian postal code with or without its space, in either case.
    const pattern = new RegExp(requirement!.pattern!);
    expect(['Z9Z 9Z9', 'z9z9z9'].filter((postcode) => pattern.test(postcode))).toHaveLength(2);
    expect(['Z9Z  9Z9', '99Z 9Z9', 'Z9Z-9Z9'].some((postcode) => pattern.test(postcode))).toBe(false);
    expect(normalizeCarrierInputs('postmedia-parcel-services', DELIVERED, '', ' z9z  9z9 ')).toEqual({ trackingUrl: null, postcode: POSTCODE });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: 'bni 000 000 001', carrier: 'postmedia-parcel-services', postcode: 'z9z9z9' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'postmedia-parcel-services', source: 'postmedia-parcel-services', result: { current_stage: 'delivered' } });
    expect(String(fetcher.mock.calls[0]![0])).toBe(postmediaQueryUrl(DELIVERED, POSTCODE));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'postmedia-parcel-services' }))
      .rejects.toThrow('Postmedia Parcel Services requires the delivery postcode');
  });

  it('reads only the number from a tracker link, and is never asked to recognize one', () => {
    for (const path of ['/', '/track-your-shipment', '/fr/track-your-shipment']) {
      expect(parseTrackingInput(`https://postmediaparcelservices.com${path}?bniTrackingID=${DELIVERED}&bniPostalCode=Z9Z+9Z9`))
        .toMatchObject({ trackingNumber: DELIVERED, carrier: 'postmedia-parcel-services', source: 'link' });
    }
    expect(detectCarrierMatch(DELIVERED).candidates ?? []).not.toContain('postmedia-parcel-services');
    expect(recognitionAskedCarriers(DELIVERED)).not.toContain('postmedia-parcel-services');
    expect(carrier(vi.fn<typeof fetch>())).not.toHaveProperty('recognize');
  });
});

type Entry = { code?: string; wording: string; stage?: string; confirmedBy: string };

describe('Postmedia Parcel Services status vocabulary', () => {
  it('maps every message seen to the stage recorded for it', () => {
    for (const entry of statuses.entries as Entry[]) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'postmedia-parcel-services', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    // Every message the adapter writes is recorded.
    const recorded = new Set((statuses.entries as Entry[]).map((entry) => normalizeStatusWording(entry.wording)));
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', MOVING]] as const) {
      for (const event of parsePostmedia(fixture(name), number).events!) {
        expect(recorded.has(normalizeStatusWording(event.description!)), event.description).toBe(true);
      }
    }
    expect(postmediaStage('Synthetic status')).toBeNull();
    expect(statusMapAnswer({ carrier: 'postmedia-parcel-services', providerCode: null, description: 'Synthetic status' })).toEqual({ kind: 'unknown' });
  });
});
