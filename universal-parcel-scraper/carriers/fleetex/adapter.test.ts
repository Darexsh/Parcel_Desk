import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, FleetexTracker, fleetexFeedUrl } from './adapter.js';
import { normalizeFleetexNumber, parseFleetex } from './parser.js';
import { fleetexStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'SR100000000001';
const MOVING = 'SR100000000002';
const UNKNOWN = 'SR100000000000';

type Row = Record<string, unknown>;
type Reply = Record<string, unknown> & { events: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookup = (fetcher: typeof fetch, number = DELIVERED) => carrier(fetcher).track({ number });
const answering = (...responses: Response[]) => {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  return fetcher;
};
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('FleetExpress HTTP adapter', () => {
  it('asks the tracking feed for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new FleetexTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' sr 1000-0000-0002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://api.fleetexpress.ca/api/v1/17track/${MOVING}`);
    expect(String(url)).toBe(fleetexFeedUrl(MOVING));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'fleetex', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery with its scans as instants in UTC, newest first, without the shipper or its reference', () => {
    const result = parseFleetex(fixture('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Your Parcel Has Been Delivered Successfully. Thank You!', last_update: '2026-09-17T00:15:09Z',
      delivered_at: '2026-09-17T00:15:09Z',
      events: [
        { time: '2026-09-17T00:15:09Z', description: 'Your Parcel Has Been Delivered Successfully. Thank You!', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2026-09-16T12:30:00Z', location: 'Exampleville Depot', description: 'Out For Delivery', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2026-09-15T14:12:40Z', location: 'Distribution Centre', description: 'Your Parcel Has Arrived Safely At Distribution Centre.',
          stage: 'accepted', stage_source: 'carrier_map' },
        { time: '2026-09-15T11:41:05Z', location: 'Distribution Centre', description: 'Your Parcel Has Been Collected And Arrived At Distribution Centre.',
          stage: 'accepted', stage_source: 'carrier_map' },
        { time: '2026-09-14T20:02:11Z', description: 'Your Shipment Information Has Been Submitted.', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/Synthetic Shop|SYNTH-ORDER/);
  });

  it('keeps the instant of a scan whose offset is the account’s zone, not the scan’s place', () => {
    const result = parseFleetex(fixture('in-transit'), MOVING);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Your Shipment Is In Transit.',
      last_update: '2026-11-23T23:05:00Z' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.location ?? null, event.stage])).toEqual([
      ['2026-11-23T23:05:00Z', 'Testbury Warehouse', 'in_transit'],
      ['2026-11-23T03:26:12Z', null, 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Synthetic Inc|123000|Canada/);
  });

  it('orders scans by their instants, keeps equal scans once, leaves out a scan without a message, and lets the newest staged scan decide', () => {
    const result = parseFleetex(changed('delivered', (body) => {
      // A later row at the same instant is the newer scan.
      body.events.push({ time: '2026-09-17T00:15:09Z', location: null, content: 'Synthetic note' });
      body.events.push({ ...body.events[1]!, content: 'YOUR PARCEL HAS BEEN COLLECTED AND ARRIVED AT DISTRIBUTION CENTRE.' });
      body.events.push({ time: '2026-09-18T10:00:00-04:00', location: null, content: '' });
    }), DELIVERED);
    expect(result.events!.map((event) => [event.time, event.description])).toEqual([
      ['2026-09-17T00:15:09Z', 'Synthetic note'],
      ['2026-09-17T00:15:09Z', 'Your Parcel Has Been Delivered Successfully. Thank You!'],
      ['2026-09-16T12:30:00Z', 'Out For Delivery'],
      ['2026-09-15T14:12:40Z', 'Your Parcel Has Arrived Safely At Distribution Centre.'],
      ['2026-09-15T11:41:05Z', 'Your Parcel Has Been Collected And Arrived At Distribution Centre.'],
      ['2026-09-14T20:02:11Z', 'Your Shipment Information Has Been Submitted.'],
    ]);
    // The unstaged newest scan is the last update; the delivery still sets the status.
    expect(result).toMatchObject({ status: 'delivered', last_status_text: 'Synthetic note', delivered_at: '2026-09-17T00:15:09Z' });
    // A parcel back at the depot after its delivery is no longer delivered.
    const back = parseFleetex(changed('delivered', (body) => {
      body.events.push({ time: '2026-09-18T09:00:00-04:00', location: 'Distribution Centre', content: 'Your Parcel Has Arrived Safely At Distribution Centre.' });
    }), DELIVERED);
    expect(back).toMatchObject({ current_stage: 'accepted' });
    expect(back).not.toHaveProperty('delivered_at');
    // Scans that all lack a message, or none at all, are no history.
    for (const events of [[], [{ time: '2026-09-14T16:02:11-04:00', location: null, content: null }]]) {
      expect(() => parseFleetex({ ...fixture('delivered'), events }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('reads the feed’s notice for a number it holds nothing under as not found', async () => {
    expect(() => parseFleetex(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(lookup(answering(reply(fixture('not-found'))), UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    // Another notice is no answer about the parcel.
    for (const error of ['Synthetic notice', 7, true]) {
      expect(() => parseFleetex({ ...fixture('not-found'), error }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('binds the answer to the whole number asked', async () => {
    expect(() => parseFleetex(fixture('delivered'), MOVING))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'FleetExpress answered for another parcel' }));
    await expect(lookup(answering(reply(fixture('delivered'))), 'SR100000000010')).rejects.toMatchObject({ kind: 'indeterminate' });
    // A not-found notice for another number says nothing about this one.
    expect(() => parseFleetex(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The shipper's reference is not the number asked.
    expect(() => parseFleetex(changed('delivered', (body) => { body.number = 'SR100000000099'; body.oriNumber = DELIVERED; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseFleetex(changed('delivered', (body) => { delete body.number; }), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseFleetex(changed('delivered', (body) => { body.number = ' sr100000000001 '; }), DELIVERED)).toMatchObject({ status: 'delivered' });
  });

  it('keeps a browser check, a moved route and a changed reply apart from a missing parcel', async () => {
    await expect(lookup(answering(reply(CHECK, { headers: { 'Content-Type': 'text/html' } })))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(answering(reply(CHECK, { status: 403, headers: { 'Content-Type': 'text/html' } })))).rejects.toMatchObject({ kind: 'challenge' });
    for (const moved of [reply({ message: 'The route api/v1/17track/SR100000000001 could not be found.' }, { status: 404 }), reply('', { status: 410 }),
      new Response(null, { status: 301, headers: { Location: 'https://tracking.fleetexpress.ca/' } })]) {
      await expect(lookup(answering(moved))).rejects.toMatchObject({ kind: 'transport' });
    }
    // The tracking page in place of the feed is a changed route, not a missing parcel.
    await expect(lookup(answering(reply('<html><title>Tracking | FleetExpress</title><h3>Package Not Found</h3></html>', { headers: { 'Content-Type': 'text/html' } }))))
      .rejects.toMatchObject({ kind: 'schema' });
    for (const change of [
      (body: Reply) => { body.events = 'none' as unknown as Row[]; },
      (body: Reply) => { delete (body as Partial<Reply>).events; },
      (body: Reply) => { body.events[0]!.time = '2026-09-14 16:02:11'; },
      (body: Reply) => { body.events[0]!.time = '2026-09-14T16:02:11'; },
      (body: Reply) => { body.events[0]!.time = '2026-09-31T16:02:11-04:00'; },
      (body: Reply) => { body.events[0]!.time = '2026-09-14T24:00:00-04:00'; },
      (body: Reply) => { body.events[0]!.time = '2026-09-14T16:02:11+99:00'; },
      (body: Reply) => { body.events[0]!.time = null; },
      (body: Reply) => { body.events[0]!.content = 12; },
      (body: Reply) => { body.events[0]!.location = { name: 'Depot' }; },
      (body: Reply) => { body.events[1] = 'scan' as unknown as Row; },
      (body: Reply) => { body.events = Array.from({ length: 201 }, () => body.events[0]!); },
    ]) {
      expect(() => parseFleetex(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of ['reply', null, [], {}, { number: 7 }]) {
      expect(() => parseFleetex(body, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply({ message: 'Synthetic failure' }, { status }));
      await expect(lookup(fetcher)).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the not-found notice, and asks nothing about a number FleetExpress does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')))
      .mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-09-17T00:15:09.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(MOVING)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(fetcher).recognize!('SR123456789')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('takes SR or DS and twelve digits, without a request otherwise', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['SR10000000001', 'SR1000000000011', 'SX100000000001', '100000000001', 'SR10000000000A', 'DS1000000000', `SR${'1'.repeat(70)}`]) {
      await expect(lookup(fetcher, number), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeFleetexNumber(' sr 1000 0000 0001 ')).toBe(DELIVERED);
    expect(normalizeFleetexNumber('ds100000000001')).toBe('DS100000000001');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(reply(fixture('delivered')));
    await expect(lookup(flaky)).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>();
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 })).rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    await expect(lookup(answering(new Response(new Uint8Array(300_000))))).rejects.toThrow('unexpectedly large');
  });

  it('routes a number the caller names FleetExpress’s to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'fleetex' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'fleetex', source: 'fleetex', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === fleetexFeedUrl(DELIVERED))).toBe(true);
  });
});

describe('FleetExpress numbers', () => {
  it('claims no number layout, and reads the number from either tracking page’s link', () => {
    for (const number of [DELIVERED, 'DS100000000001']) {
      expect(detectCarrierMatch(number).candidates ?? []).not.toContain('fleetex');
      expect(recognitionAskedCarriers(number)).not.toContain('fleetex');
    }
    for (const path of ['tracking/en', 'tracking/fr', 'oteptrack/en', 'oteptrack/chs']) {
      const link = `https://tracking.fleetexpress.ca/${path}/${DELIVERED}`;
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'fleetex', source: 'link' });
    }
  });
});

type Entry = { wording: string; stage?: string };

describe('FleetExpress status vocabulary', () => {
  it('maps every wording recorded to its stage, and every message the adapter writes is recorded', () => {
    for (const entry of statuses.entries as Entry[]) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'fleetex', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    const recorded = new Set((statuses.entries as Entry[]).map((entry) => normalizeStatusWording(entry.wording)));
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', MOVING]] as const) {
      for (const event of parseFleetex(fixture(name), number).events!) {
        expect(recorded.has(normalizeStatusWording(event.description!)), event.description).toBe(true);
      }
    }
    // The feed capitalizes every word; the map reads the tracking page's sentence case as well.
    expect(fleetexStage('Your parcel has been delivered successfully. Thank you!')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(fleetexStage('Synthetic status')).toBeNull();
    expect(statusMapAnswer({ carrier: 'fleetex', providerCode: null, description: 'Synthetic status' })).toEqual({ kind: 'unknown' });
  });
});
