import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, whizTrackingUrl } from './adapter.js';
import { normalizeWhizNumber, parseWhiz } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'SW0000000A1B';
const UNKNOWN = 'SW0000000000';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());

type Reply = Record<string, unknown> & { events: Record<string, unknown>[] };
const delivered = () => JSON.parse(text('delivered.json')) as Reply;
const edited = (change: (reply: Reply) => void) => {
  const reply = delivered();
  change(reply);
  return reply;
};

describe('Whiz Delivery numbers', () => {
  it('offers Whiz Delivery for SW and ten hexadecimal characters, and asks its tracker', () => {
    expect(detectCarrierMatch(NUMBER).candidates).toContain('whiz-delivery');
    expect(recognitionCandidates(NUMBER).map(({ carrier: id }) => id)).toContain('whiz-delivery');
    expect(normalizeWhizNumber(' sw0000000a1b ')).toBe(NUMBER);
    expect(normalizeWhizNumber('WHZ00000001')).toBe('WHZ00000001');
    for (const other of ['SW12', '0000000A1B', 'XW0000000A1B']) expect(() => normalizeWhizNumber(other), other).toThrow('SW or WHZ');
  });

  it('reads a link to the tracking page', () => {
    expect(parseTrackingInput(`https://track.whizdelivery.ca/track/${NUMBER}`)).toMatchObject({ trackingNumber: NUMBER, carrier: 'whiz-delivery' });
  });
});

describe('Whiz Delivery tracking', () => {
  it('asks the public tracking API for the number', async () => {
    const fetcher = replying(() => json(text('delivered.json')));
    await carrier(fetcher).track({ number: NUMBER });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(`https://api.whizdelivery.ca/v1/track-public/${NUMBER}`);
    expect(whizTrackingUrl(NUMBER)).toBe(fetcher.mock.calls[0]![0]);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'GET' });
  });

  it('reads the history newest first, on UTC instants, each event under its status id', () => {
    const result = parseWhiz(delivered(), NUMBER);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Your order is delivered', last_update: '2026-03-10T20:14:05Z',
      delivered_at: '2026-03-10T20:14:05Z', destination_country: 'CA',
    });
    expect(result.events!.map(({ time, provider_code, stage }) => [time, provider_code, stage])).toEqual([
      ['2026-03-10T20:14:05Z', '50', 'delivered'],
      ['2026-03-10T20:11:40Z', '40', 'out_for_delivery'],
      ['2026-03-10T20:11:38Z', '30', 'out_for_delivery'],
      ['2026-03-10T16:02:10Z', '28', 'out_for_delivery'],
      ['2026-03-10T13:45:00Z', '20', 'in_transit'],
      ['2026-03-10T11:30:21Z', '25', 'accepted'],
      ['2026-03-05T15:20:44Z', '10', 'registered'],
    ]);
    // The towns and the shop stay out.
    expect(JSON.stringify(result)).not.toMatch(/Synthetic (?:Town|Origin|Shop)/);
  });

  it('reads an instant without an offset as UTC, as the tracking page does, and sorts events out of order', () => {
    const result = parseWhiz(edited((reply) => {
      reply.events.reverse();
      reply.events[0]!.timestamp = '2026-03-05T15:20:44.123';
    }), NUMBER);
    expect(result.events!.at(-1)).toMatchObject({ time: '2026-03-05T15:20:44Z', provider_code: '10' });
    expect(result.events![0]).toMatchObject({ provider_code: '50' });
  });

  it('keeps events of one instant in the reply’s order, reversed when it lists them oldest first', () => {
    const result = parseWhiz(edited((reply) => {
      reply.events[2]!.timestamp = reply.events[1]!.timestamp;
      reply.events.reverse();
    }), NUMBER);
    expect(result.events!.slice(0, 3).map((event) => event.provider_code)).toEqual(['50', '40', '30']);
  });

  it('reads a missed delivery awaiting another attempt as a failed attempt', () => {
    const result = parseWhiz(edited((reply) => {
      reply.events.splice(0, 1, { timestamp: '2026-03-10T20:20:00Z', status_id: 53, description: 'Synthetic missed delivery' });
      reply.delivered_at = null;
    }), NUMBER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: 'Synthetic missed delivery' });
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('keeps an event without a status id, or with one it does not list, without a stage, under the stage before it', () => {
    const result = parseWhiz(edited((reply) => {
      reply.events.splice(0, 1, { timestamp: '2026-03-10T20:20:00Z', status_id: null, description: 'Synthetic note' },
        { timestamp: '2026-03-10T20:19:00Z', status_id: 15, description: 'Synthetic assignment' });
    }), NUMBER);
    expect(result.events!.slice(0, 2).map((event) => [event.provider_code, event.stage])).toEqual([[undefined, undefined], ['15', undefined]]);
    expect(result).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Synthetic note' });
  });

  it('reads the API’s 404 for the shipment asked as not found', async () => {
    const fetcher = replying(() => json(text('not-found.json'), { status: 404 }));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps a missing route, a refusal, a firewall page, a rate limit and an outage apart from a missing shipment', async () => {
    const cases: [Response, string][] = [
      [json({ detail: 'Not Found' }, { status: 404 }), 'transport'],
      [json({ detail: `Shipment ${NUMBER} not found` }, { status: 404 }), 'transport'],
      [new Response('', { status: 404 }), 'transport'],
      [new Response('', { status: 308, headers: { Location: 'https://whizdelivery.ca/' } }), 'transport'],
      [new Response('<html><title>Just a moment...</title></html>', { status: 403 }), 'challenge'],
      [json({ detail: 'Too Many Requests' }, { status: 429, headers: { 'Retry-After': '42' } }), 'rate_limited'],
      [new Response('', { status: 500 }), 'indeterminate'],
      [new Response('', { status: 503 }), 'maintenance'],
      [new Response('<html><head><title>Just a moment...</title></head></html>', { headers: { 'Content-Type': 'text/html' } }), 'challenge'],
      [new Response('<html><body>maintenance</body></html>', { headers: { 'Content-Type': 'text/html' } }), 'schema'],
      [json({ message: 'Synthetic' }), 'schema'],
    ];
    for (const [response, kind] of cases) {
      await expect(carrier(replying(() => response.clone())).track({ number: UNKNOWN }), kind).rejects.toMatchObject({ kind });
    }
  });

  it('leaves an answer for another shipment, an empty history and a changed reply open or failed, never found', () => {
    expect(() => parseWhiz(edited((reply) => { reply.tracking_id = UNKNOWN; }), NUMBER)).toThrow('another shipment');
    expect(() => parseWhiz(edited((reply) => { reply.tracking_id = `${NUMBER}1`; }), NUMBER)).toThrow('another shipment');
    expect(() => parseWhiz(edited((reply) => { reply.events = []; }), NUMBER)).toThrow(NoHistoryError);
    for (const timestamp of ['2026-03-10', '10/03/2026 20:14', '2026-02-30T10:00:00Z', null]) {
      expect(() => parseWhiz(edited((reply) => { reply.events[0]!.timestamp = timestamp; }), NUMBER), String(timestamp)).toThrow('invalid event time');
    }
    expect(() => parseWhiz(edited((reply) => { reply.events[0]!.description = ' '; }), NUMBER)).toThrow('without a description');
    expect(() => parseWhiz(edited((reply) => { delete (reply as Record<string, unknown>).events; }), NUMBER)).toThrow('unexpected reply');
  });

  it('recognizes a number its tracker knows, and not one it does not', async () => {
    await expect(carrier(replying(() => json(text('delivered.json')))).recognize!(NUMBER))
      .resolves.toMatchObject({ known: true, lastActivityAt: '2026-03-10T20:14:05.000Z' });
    await expect(carrier(replying(() => json(text('not-found.json'), { status: 404 }))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const fetcher = replying(() => json(text('delivered.json')));
    await expect(carrier(fetcher).recognize!('SW12')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Whiz Delivery status map', () => {
  it('lists every status id once with a stage, and the app reads it', () => {
    const codes = statuses.entries.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const entry of statuses.entries) expect(statusMap.stage(entry.code, entry.wording), entry.code).toBe(entry.stage);
    expect(statusMap.gaps).toEqual([]);
    expect(statusMapAnswer({ carrier: 'whiz-delivery', providerCode: '25', description: 'We received your package at the warehouse' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'whiz-delivery', providerCode: '15', description: 'Synthetic assignment' })).toEqual({ kind: 'unknown' });
  });
});
