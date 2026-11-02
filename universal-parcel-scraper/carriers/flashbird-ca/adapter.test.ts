import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NoHistoryError, NotFoundError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, FlashbirdTracker, flashbirdTrackingUrl } from './adapter.js';
import { normalizeFlashbirdNumber, parseFlashbird } from './parser.js';
import { flashbirdStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '100000000017';
const IN_TRANSIT = '100000000025';
const UNKNOWN = '100000000033';
// Half an hour after the in-transit fixture's route started: 13:30 in Toronto.
const ON_ROUTE = Date.parse('2026-01-20T18:30:00Z');

type Row = Record<string, unknown>;
type Reply = Row & { logs: Row[] };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(`${name}.json`)) as Reply;
const edited = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());

describe('FlashBird numbers', () => {
  it('takes twelve digits and nothing else', () => {
    expect(normalizeFlashbirdNumber(' 1000 0000 0017 ')).toBe(DELIVERED);
    for (const other of ['10000000001', '1000000000170', 'FB0000000017', '']) {
      expect(() => normalizeFlashbirdNumber(other), other).toThrow('twelve digits');
    }
  });

  it('has no rule of its own, so recognition never asks it about a twelve-digit number', () => {
    expect(detectCarrierMatch(DELIVERED).candidates).not.toContain('flashbird-ca');
    expect(recognitionCandidates(DELIVERED).map(({ carrier: id }) => id)).not.toContain('flashbird-ca');
  });

  it('reads a link to the tracking page', () => {
    expect(parseTrackingInput(`https://flashbird.ca/tracking/${DELIVERED}`)).toMatchObject({ trackingNumber: DELIVERED, carrier: 'flashbird-ca' });
  });
});

describe('FlashBird tracking', () => {
  it('asks the tracking page’s service for the number', async () => {
    const fetcher = replying(() => json(text('delivered.json')));
    await carrier(fetcher).track({ number: DELIVERED });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(`https://flashbird.ca/ghost/api/v0.1/package_trackings/${DELIVERED}`);
    expect(flashbirdTrackingUrl(DELIVERED)).toBe(fetcher.mock.calls[0]![0]);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'GET' });
  });

  it('reads a delivered history newest first, on Toronto’s clock, without the photos or the driver', () => {
    const result = parseFlashbird(fixture('delivered'), DELIVERED, ON_ROUTE);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Parcel delivered', last_update: '2026-06-15T17:00:09-04:00',
      delivered_at: '2026-06-15T17:00:09-04:00', expected_delivery: null,
    });
    expect(result.events!.map(({ time, description, stage }) => [time, description, stage])).toEqual([
      ['2026-06-15T17:00:09-04:00', 'Parcel delivered', 'delivered'],
      ['2026-06-15T12:35:29-04:00', 'Out for delivery', 'out_for_delivery'],
      ['2026-06-15T12:17:50-04:00', 'Out for delivery', 'out_for_delivery'],
      ['2026-06-15T11:08:30-04:00', 'Picked up by FlashBird', 'accepted'],
      ['2026-06-15T09:05:06-04:00', 'Shipment created', 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-photo|0{23}1|driver|images|"key"/);
  });

  it('reads a parcel out for delivery with the driver’s estimate, to the minute, and nothing of the driver’s position', () => {
    const result = parseFlashbird(fixture('in-transit'), IN_TRANSIT, ON_ROUTE);
    expect(result).toMatchObject({
      status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Out for delivery',
      last_update: '2026-01-20T13:02:44-05:00', expected_delivery: '2026-01-20T15:00:00-05:00',
    });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events).toHaveLength(3);
    expect(JSON.stringify(result)).not.toMatch(/43\.6|79\.5|stops|latitude/i);
  });

  it('shows the estimate only where the tracking page does', () => {
    const estimate = (change: (reply: Reply) => void, readAt = ON_ROUTE) =>
      parseFlashbird(edited('in-transit', change), IN_TRANSIT, readAt).expected_delivery;
    // More than four hours ahead, unless the driver's route ends by 23:00.
    expect(estimate((reply) => { reply.eta = 5 * 3600; })).toBeNull();
    expect(estimate((reply) => { reply.eta = 5 * 3600; reply.route_end_eta = 6 * 3600; })).toBe('2026-01-20T18:30:00-05:00');
    expect(estimate((reply) => { reply.eta = 5 * 3600; reply.route_end_eta = 10 * 3600; })).toBeNull();
    // After 23:00, or on the next day.
    expect(estimate((reply) => { reply.eta = 3600; }, Date.parse('2026-01-21T03:30:00Z'))).toBeNull();
    expect(estimate((reply) => { reply.eta = 'Not available'; })).toBeNull();
    expect(estimate((reply) => { reply.eta = -60; })).toBeNull();
    // A delivery the recipient moved to a later day hides the driver's estimate.
    expect(estimate((reply) => { reply.scheduled_delivery_date = '2026-01-22'; })).toBe('2026-01-22');
    expect(estimate((reply) => { delete reply.eta; reply.scheduled_delivery_date = '2026-01-20'; })).toBe('2026-01-20');
    expect(estimate((reply) => { reply.scheduled_delivery_date = '2026-01-20'; })).toBe('2026-01-20T15:00:00-05:00');
    expect(estimate((reply) => { delete reply.eta; reply.scheduled_delivery_date = '2026-01-19'; })).toBeNull();
    expect(estimate((reply) => { delete reply.eta; reply.scheduled_delivery_date = '2026-02-30'; })).toBeNull();
    // None once the parcel is delivered.
    expect(parseFlashbird(edited('delivered', (reply) => { reply.eta = 600; }), DELIVERED, ON_ROUTE).expected_delivery).toBeNull();
  });

  it('keeps rows of one instant in the reply’s order, reversed, and drops an exact repeat', () => {
    const result = parseFlashbird(edited('delivered', (reply) => {
      reply.logs[3]!.time = reply.logs[2]!.time;
      reply.logs[3]!.message = 'Synthetic second row';
      reply.logs.push({ ...reply.logs[4]! });
    }), DELIVERED);
    expect(result.events!.map(({ description }) => description)).toEqual([
      'Parcel delivered', 'Synthetic second row', 'Out for delivery', 'Picked up by FlashBird', 'Shipment created',
    ]);
  });

  it('stages wording its map does not know by the shared rules, or leaves it without a stage', () => {
    expect(flashbirdStage('Delivery attempt failed')).toMatchObject({ stage: 'failed_attempt' });
    const result = parseFlashbird(edited('in-transit', (reply) => {
      reply.logs.push({ message: 'Synthetic note', time: 1768933000000, visable: 1 });
    }), IN_TRANSIT, ON_ROUTE);
    expect(result.events![0]).toEqual({ time: '2026-01-20T13:16:40-05:00', description: 'Synthetic note' });
    expect(result).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Synthetic note' });
  });

  it('reads the empty reply as not found, as the tracking page does', async () => {
    const fetcher = replying(() => json(text('not-found.json')));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(() => parseFlashbird({}, UNKNOWN)).toThrow(NotFoundError);
  });

  it('keeps a moved route, a block page, a rate limit and an outage apart from a missing parcel', async () => {
    const ghost = '<!doctype html><html><head><title>Ghost Admin</title></head><body></body></html>';
    const cases: [Response, string][] = [
      [new Response(ghost, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }), 'schema'],
      [new Response('<html><head><title>Just a moment...</title></head></html>', { headers: { 'Content-Type': 'text/html' } }), 'challenge'],
      [new Response('<html><title>Access Denied</title></html>', { status: 403 }), 'challenge'],
      [new Response('Too many requests, please try again later.', { status: 429, headers: { 'Retry-After': '60' } }), 'rate_limited'],
      [new Response('', { status: 404 }), 'transport'],
      [new Response('', { status: 301, headers: { Location: 'https://flashbird.ca/' } }), 'transport'],
      [new Response('', { status: 500 }), 'indeterminate'],
      [new Response('', { status: 503 }), 'maintenance'],
      [json([]), 'schema'],
      [json({ message: 'Synthetic' }), 'schema'],
      [json({ number: UNKNOWN }), 'schema'],
    ];
    for (const [response, kind] of cases) {
      await expect(carrier(replying(() => response.clone())).track({ number: UNKNOWN }), kind).rejects.toMatchObject({ kind });
    }
  });

  it('sends a read that did not reach FlashBird once more', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json(text('in-transit.json')));
    const tracker = new FlashbirdTracker({ fetcher, now: () => ON_ROUTE });
    await expect(tracker.fetch(IN_TRANSIT)).resolves.toMatchObject({ expected_delivery: '2026-01-20T15:00:00-05:00' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('leaves an answer for another parcel, an empty history and a changed reply open or failed, never found', () => {
    expect(() => parseFlashbird(edited('delivered', (reply) => { reply.number = UNKNOWN; }), DELIVERED)).toThrow('another shipment');
    expect(() => parseFlashbird(edited('delivered', (reply) => { reply.number = `${DELIVERED}1`; }), DELIVERED)).toThrow('another shipment');
    expect(() => parseFlashbird(edited('delivered', (reply) => { reply.logs = []; }), DELIVERED)).toThrow(NoHistoryError);
    for (const time of [null, '2026-06-15T13:05:06Z', 1781528706, 1781528706861.5, -1]) {
      expect(() => parseFlashbird(edited('delivered', (reply) => { reply.logs[0]!.time = time; }), DELIVERED), String(time)).toThrow('invalid scan time');
    }
    expect(() => parseFlashbird(edited('delivered', (reply) => { reply.logs[0]!.message = ' '; }), DELIVERED)).toThrow('without wording');
    expect(() => parseFlashbird(edited('delivered', (reply) => { reply.logs[0] = 'Shipment created' as unknown as Row; }), DELIVERED)).toThrow('invalid scan');
    expect(() => parseFlashbird(edited('delivered', (reply) => { delete (reply as Row).logs; }), DELIVERED)).toThrow('unexpected reply');
    expect(() => parseFlashbird(edited('delivered', (reply) => { delete (reply as Row).number; }), DELIVERED)).toThrow('unexpected reply');
  });

  it('recognizes a number its tracker knows, and not one it does not', async () => {
    await expect(carrier(replying(() => json(text('delivered.json')))).recognize!(DELIVERED))
      .resolves.toMatchObject({ known: true, lastActivityAt: '2026-06-15T21:00:09.000Z' });
    await expect(carrier(replying(() => json(text('not-found.json')))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const fetcher = replying(() => json(text('delivered.json')));
    await expect(carrier(fetcher).recognize!('FB0000000017')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('FlashBird status map', () => {
  it('stages every wording seen, and the app reads it', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
    expect(statusMap.gaps).toEqual([]);
    expect(statusMapAnswer({ carrier: 'flashbird-ca', providerCode: null, description: 'Picked up by FlashBird' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'flashbird-ca', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
