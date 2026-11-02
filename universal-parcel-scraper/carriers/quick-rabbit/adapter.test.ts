import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, quickRabbitTrackingUrl, QuickRabbitTracker } from './adapter.js';
import { normalizeQuickRabbitCode, parseQuickRabbit } from './parser.js';
import { quickRabbitStage, quickRabbitWording, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const CODE = 'PKG00620260301000000017';
const REFERENCE = 'XX0000000000000017';
const UNKNOWN = 'PKG00620260301000000099';
// The layout a universal provider files under Quick Rabbit, with its tracker's status names.
const LONG = 'PKG006261001ES9900000000001A';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());

type Row = Record<string, unknown>;
type Reply = Record<string, unknown> & { timeline: Row[] };
const delivered = () => JSON.parse(text('delivered.json')) as Reply;
const edited = (change: (reply: Reply) => void) => {
  const reply = delivered();
  change(reply);
  return reply;
};

describe('Quick Rabbit numbers', () => {
  const offers = (number: string) => {
    const match = detectCarrierMatch(number);
    return [match.carrier, ...(match.candidates ?? [])];
  };

  it('names Quick Rabbit for PKG, three digits, a date and nine digits', () => {
    expect(detectCarrierMatch(CODE)).toMatchObject({ carrier: 'quick-rabbit', confidence: 'high' });
    for (const other of ['PKG0062026030100000001', 'PKG006202603010000000170', 'PKG00620261301000000017', 'PKG00620260332000000017',
      'PKG00619260301000000017', 'PKX00620260301000000017', 'PKG-2025-0737405']) {
      expect(offers(other), other).not.toContain('quick-rabbit');
    }
  });

  it('only suggests Quick Rabbit for PKG, a dated code, ES, thirteen digits and a letter', () => {
    expect(detectCarrierMatch(LONG)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['quick-rabbit'] });
    for (const other of ['PKG006261301ES9900000000001A', 'PKG006261001FR9900000000001A', 'PKG006261001ES990000000001A',
      'PKG006261001ES9900000000001', 'PKG006261001ES99000000000011']) {
      expect(offers(other), other).not.toContain('quick-rabbit');
    }
  });

  it('only suggests Quick Rabbit for WT and sixteen digits, the shipper’s reference its tracker answers for', () => {
    const reference = REFERENCE.replace(/^XX/, 'WT');
    expect(detectCarrierMatch(reference)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['quick-rabbit'] });
    expect(detectCarrierMatch(`wt ${reference.slice(2)}`)).toMatchObject({ confidence: 'low', candidates: ['quick-rabbit'] });
    for (const other of [REFERENCE, reference.slice(0, -1), `${reference}0`, reference.replace(/^WT/, 'WX')]) {
      expect(offers(other), other).not.toContain('quick-rabbit');
    }
  });
});

describe('Quick Rabbit HTTP adapter', () => {
  it('asks the tracking page’s lookup for the code', async () => {
    const fetcher = replying(() => json(text('delivered.json')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new QuickRabbitTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${CODE.toLowerCase()} `, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.tms.quickrabbit.es/api/v1/tracking/${CODE}/`);
    expect(url).toBe(quickRabbitTrackingUrl(CODE));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'quick-rabbit', step: 'direct', outcome: 'ok' }));
  });

  it('reads the timeline newest first, with the page’s labels and Madrid’s clock, without the courier’s position', () => {
    const result = parseQuickRabbit(delivered(), CODE);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered to Recipient', last_update: '2026-03-05T11:02:08+01:00', delivered_at: '2026-03-05T11:02:08+01:00',
      expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.description, event.stage])).toEqual([
      ['2026-03-05T11:02:08+01:00', 'DELIVERED_RECIPIENT', 'Delivered to Recipient', 'delivered'],
      ['2026-03-05T07:36:31+01:00', 'RECEIVED_DRIVER', 'Driver Has Package', 'out_for_delivery'],
      ['2026-03-04T19:24:32+01:00', 'READY_FOR_ROUTE', 'Ready for Route Assignment', 'in_transit'],
      ['2026-03-04T16:46:19+01:00', 'SORTING_ENTRY', 'Entered Sorting Center', 'in_transit'],
      ['2026-03-01T05:50:39+01:00', 'DOCUMENTED', 'Documented', 'registered'],
    ]);
    const serialized = JSON.stringify(result);
    // The estimate stays even after delivery or a return, so it is not read; nor are the city, the reference or the position.
    for (const value of ['2026-03-09', 'Synthetic City', REFERENCE, '40.0000001', '-3.0000001', 'latitude']) expect(serialized, value).not.toContain(value);
    expect(result.canonical_tracking_number).toBeUndefined();
  });

  it('reads the digits the page shows as Madrid’s wall clock, in summer and after the change', () => {
    // The page shows each status's digits in UTC: its "Z" labels the wall clock it shows.
    const reply = delivered();
    reply.timeline.at(-1)!.date = '2026-10-25T23:07:00.000Z';
    reply.timeline.at(-2)!.date = '2026-07-01T10:00:00.000Z';
    expect(parseQuickRabbit(reply, CODE).events!.slice(0, 2).map((event) => event.time))
      .toEqual(['2026-10-25T23:07:00+01:00', '2026-07-01T10:00:00+02:00']);
  });

  it('finds the parcel by the shipper’s reference too, and names its tracking code', () => {
    expect(parseQuickRabbit(delivered(), REFERENCE)).toMatchObject({ status: 'delivered', canonical_tracking_number: CODE });
  });

  it('takes a code without the spaces and dashes a user can type in it', () => {
    expect(normalizeQuickRabbitCode(' pkg-0062-0260301 000000017 ')).toBe(CODE);
    expect(() => normalizeQuickRabbitCode('PKG')).toThrow('6 to 40');
    expect(() => normalizeQuickRabbitCode('PKG/0000017')).toThrow('6 to 40');
  });

  it('keeps a return after a reactivation as returned, and orders statuses on one instant as listed', () => {
    const reply = edited((reply) => {
      reply.timeline = [
        ...reply.timeline.slice(0, 4),
        { status: 'RETURNED', status_category: 'RETURNED', date: '2026-03-05T08:45:38.000Z', completed: true },
        { status: 'REACTIVATED', status_category: 'WAREHOUSE', date: '2026-03-11T14:42:09.000Z', completed: false },
        { status: 'RETURNED', status_category: 'RETURNED', date: '2026-03-11T14:42:27.000Z', completed: true },
        { status: 'INFORMATIVE', status_category: 'INFORMATIVE', date: '2026-03-11T14:42:27.000Z', completed: false },
      ];
    });
    const result = parseQuickRabbit(reply, CODE);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Informational Update' });
    expect(result.events!.slice(0, 4).map((event) => [event.provider_code, event.stage ?? null])).toEqual([
      ['INFORMATIVE', null], ['RETURNED', 'returned'], ['REACTIVATED', null], ['RETURNED', 'returned'],
    ]);
    expect(result.delivered_at).toBeUndefined();
  });

  it('stages a status the page does not label by its category, and words it from its name', () => {
    expect(quickRabbitStage('SYNTHETIC_NEW_STATUS', 'IN_DELIVERY')).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
    expect(quickRabbitStage('SYNTHETIC_NEW_STATUS', 'INFORMATIVE')).toBeNull();
    // A labelled status without a stage keeps none, whatever its category.
    expect(quickRabbitStage('CUSTOMER_CHANGE_ADDRESS', 'IN_DELIVERY')).toBeNull();
    expect(quickRabbitWording('SYNTHETIC_NEW_STATUS')).toBe('Synthetic new status');
    const result = parseQuickRabbit(edited((reply) => {
      reply.timeline.push({ status: 'SYNTHETIC_NEW_STATUS', status_category: 'RETURNED', date: '2026-03-06T08:00:00Z' });
    }), CODE);
    expect(result).toMatchObject({ current_stage: 'returned', last_status_text: 'Synthetic new status' });
  });

  it('reads the tracker’s unknown-code answer as not found', async () => {
    const fetcher = replying(() => json(text('not-found.json'), { status: 404 }));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps any other 404, a redirect, a refusal and a rate limit apart from a missing parcel', async () => {
    const cases: [Response, string][] = [
      [json({ message: 'Cannot GET /api/v1/tracking/x/', error: 'Not Found', statusCode: 404 }, { status: 404 }), 'transport'],
      [new Response('', { status: 308, headers: { Location: 'https://web.quickrabbit.es/' } }), 'transport'],
      [new Response('<html><title>Just a moment...</title></html>', { status: 403 }), 'challenge'],
      [json({ message: 'ThrottlerException: Too Many Requests', statusCode: 429 }, { status: 429, headers: { 'X-RateLimit-Reset': '42' } }), 'rate_limited'],
      [new Response('<html><head><title>Just a moment...</title></head></html>', { headers: { 'Content-Type': 'text/html' } }), 'challenge'],
      [new Response('<html><body>maintenance</body></html>', { headers: { 'Content-Type': 'text/html' } }), 'schema'],
    ];
    for (const [response, kind] of cases) {
      await expect(carrier(replying(() => response.clone())).track({ number: CODE }), kind).rejects.toMatchObject({ kind });
    }
    await expect(carrier(replying(() => json({ statusCode: 429 }, { status: 429, headers: { 'X-RateLimit-Reset': '42' } })))
      .track({ number: CODE })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 42_000 });
  });

  it('leaves an answer for another parcel, an empty timeline and a changed reply open or failed, never found', () => {
    expect(() => parseQuickRabbit(edited((reply) => { reply.tracking_code = 'PKG00620260301000000018'; reply.reference_number = null; }), CODE))
      .toThrow('another parcel');
    expect(() => parseQuickRabbit(edited((reply) => { reply.timeline = []; }), CODE)).toThrow(NoHistoryError);
    expect(() => parseQuickRabbit(edited((reply) => { reply.timeline[0]!.date = '2026-03-01 05:50:39'; }), CODE)).toThrow('invalid status time');
    expect(() => parseQuickRabbit(edited((reply) => { reply.timeline[0]!.status = 'documented'; }), CODE)).toThrow('invalid status');
    expect(() => parseQuickRabbit(edited((reply) => { reply.timeline = Array.from({ length: 301 }, () => reply.timeline[0]!); }), CODE))
      .toThrow('invalid timeline');
  });

  it('reads a link to the tracking page', () => {
    expect(parseTrackingInput(`https://web.quickrabbit.es/es/tracking?ref=${CODE}`)).toMatchObject({ trackingNumber: CODE, carrier: 'quick-rabbit' });
    expect(parseTrackingInput(`https://web.quickrabbit.es/tracking?ref=${CODE}`)).toMatchObject({ trackingNumber: CODE, carrier: 'quick-rabbit' });
  });

  it('takes 17TRACK’s name for the carrier', () => {
    for (const name of ['QUICK RABBIT', 'Quick Rabbit', 'Quick Rabbit Logistic']) expect(carrierIdFromName(name), name).toBe('quick-rabbit');
  });
});

describe('Quick Rabbit status map', () => {
  it('lists every status the page labels once, stages the ones that move the parcel, and the app reads it', () => {
    const codes = statuses.entries.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording), entry.code).toBe('stage' in entry ? entry.stage : undefined);
    }
    expect(statusMap.gaps.map((gap) => gap.code)).toEqual(statuses.entries.filter((entry) => !('stage' in entry)).map((entry) => entry.code));
    expect(statusMapAnswer({ carrier: 'quick-rabbit', providerCode: 'SORTING_ENTRY', description: 'Entered Sorting Center' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
  });
});
