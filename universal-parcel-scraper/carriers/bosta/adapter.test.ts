import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, BOSTA_API, BostaTracker } from './adapter.js';
import { normalizeBostaNumber, parseBosta } from './parser.js';
import { bostaStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const IN_TRANSIT = '81000001';
const DELIVERED = '81000002';
const RETURNED = '81000003';
const DRAFT = '810004';
const UNKNOWN = '81000000';

type Row = Record<string, unknown>;
type Reply = Row & { CurrentStatus: Row; TransitEvents: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (body: Reply) => void) => {
  const body = fixture(name);
  change(body);
  return body;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The service's answer once an address has asked too often.
const TOO_MANY = { success: false, message: 'Too many requests', errorCode: 429, retryAfter: 300 };

describe('Bosta HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number in English once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new BostaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 8100 0001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${BOSTA_API}${IN_TRANSIT}?lang=en`);
    expect(String(url)).toBe('https://tracking.bosta.co/shipments/track/81000001?lang=en');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'X-Requested-By': 'Bosta', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'bosta', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history newest first at the reply’s instants and stages each scan by its code', () => {
    const result = parseBosta(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Order is delivered', last_update: '2026-05-12T12:05:47.733Z', expected_delivery: null,
      delivered_at: '2026-05-12T12:05:47.733Z', destination_country: 'EG' });
    expect(result.events!.map((event) => [event.time, event.provider_code ?? null, event.stage ?? null])).toEqual([
      ['2026-05-12T12:05:47.733Z', '45', 'delivered'],
      ['2026-05-12T08:30:00Z', '41', 'out_for_delivery'],
      ['2026-05-12T07:48:59.250Z', '20', 'in_transit'],
      ['2026-05-12T04:02:11.517Z', '24', 'in_transit'],
      ['2026-05-11T21:15:30.004Z', '30', 'in_transit'],
      // The repeated warehouse scan is kept once.
      ['2026-05-11T13:40:05.902Z', '24', 'in_transit'],
      // The merchant's pickup request has no code.
      ['2026-05-10T09:12:44.381Z', null, 'registered'],
      ['2026-05-10T09:12:44.120Z', '10', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.location === undefined
      && event.local_time === undefined)).toBe(true);
    expect(result.events![1]!.description).toBe('Order is out for delivery');
    expect(JSON.stringify(result)).not.toMatch(/SyntheticBusiness|Deliverd|10 AM/);
    expect(result).not.toHaveProperty('summary_only');
  });

  it('keeps a Saudi shipment back at the warehouse after a missed call, with the promised day in Riyadh', () => {
    const result = parseBosta(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Order is received at Bosta warehouses and being processed.', last_update: '2026-05-06T15:02:33.100Z',
      expected_delivery: '2026-05-07', destination_country: 'SA' });
    expect(result.events!.map((event) => [event.provider_code, event.stage])).toEqual([
      ['24', 'in_transit'], ['47', 'failed_attempt'], ['41', 'out_for_delivery'], ['20', 'in_transit'], ['24', 'in_transit'], ['10', 'registered'],
    ]);
    expect(result.events![1]!.description).toBe('Order is rescheduled as you were not reachable on the phone');
    expect(result).not.toHaveProperty('delivered_at');
    // The page sorts the scans by their instants, whatever order the reply has.
    expect(parseBosta(changed('in-transit', (body) => { body.TransitEvents.reverse(); }), IN_TRANSIT)).toEqual(result);
  });

  it('keeps scans of one instant in the reply’s order', () => {
    const result = parseBosta(changed('in-transit', (body) => {
      const [out, missed] = body.TransitEvents.slice(3, 5);
      body.TransitEvents.push({ ...out, timestamp: '2026-05-07T07:30:12.000Z' }, { ...missed, timestamp: '2026-05-07T07:30:12.000Z' });
    }), IN_TRANSIT);
    expect(result.events!.slice(0, 2).map((event) => event.provider_code)).toEqual(['47', '41']);
  });

  it('stages the scans of a return by their wording, whatever leg their code belongs to', () => {
    const result = parseBosta(fixture('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'Order is returned back to the shipper', expected_delivery: null, destination_country: 'EG' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.provider_code ?? null, event.stage])).toEqual([
      ['46', 'returned'], ['41', 'returned'], ['20', 'returned'], ['24', 'returned'], ['30', 'returned'], [null, 'returned'],
      ['24', 'in_transit'], ['47', 'failed_attempt'], ['41', 'out_for_delivery'], ['24', 'in_transit'], ['30', 'in_transit'],
      ['24', 'in_transit'], [null, 'registered'], ['10', 'registered'],
    ]);
    // An order turned into a return is on its way back before its scans say so, as the page shows it.
    const turned = parseBosta(changed('returned', (body) => {
      body.TransitEvents = body.TransitEvents.slice(0, 8);
      body.CurrentStatus = { state: 'Received at warehouse', code: 24, timestamp: '2026-02-07T17:12:00.300Z' };
    }), RETURNED);
    expect(turned).toMatchObject({ current_stage: 'returned', current_stage_source: 'carrier_map', expected_delivery: null });
    expect(turned.events![0]).toMatchObject({ stage: 'in_transit' });
  });

  it('promises a day only once the merchant has handed the order over, and today while it is out', () => {
    const estimate = (state: Row, change: (body: Reply) => void = () => {}) => {
      const result = parseBosta(changed('in-transit', (body) => { body.CurrentStatus = state; change(body); }), IN_TRANSIT);
      return [result.expected_delivery_from ?? null, result.expected_delivery];
    };
    const received = { state: 'Received at warehouse', code: 24, timestamp: '2026-05-06T15:02:33.100Z' };
    expect(estimate({ state: 'Preparing for shipment', code: 10, timestamp: '2026-05-05T10:00:01.000Z' })).toEqual([null, null]);
    // Out at 01:30 in Riyadh on the 7th, which is the 6th in UTC.
    expect(estimate({ state: 'Out for delivery', code: 41, timestamp: '2026-05-06T22:30:00.000Z' })).toEqual([null, '2026-05-07']);
    expect(estimate(received, (body) => { body.nextWorkingDayAfterScheduledAt = '2026-05-09T00:00:00.000Z'; }))
      .toEqual(['2026-05-07', '2026-05-09']);
    expect(estimate(received, (body) => { body.nextWorkingDayAfterScheduledAt = '2026-05-10'; })).toEqual(['2026-05-07', '2026-05-10']);
    expect(estimate(received, (body) => { body.nextWorkingDayAfterScheduledAt = 'Saturday'; })).toEqual([null, '2026-05-07']);
    expect(estimate(received, (body) => { body.PromisedDate = null; })).toEqual([null, null]);
    expect(estimate(received, (body) => { body.PromisedDate = '07-05-2026'; })).toEqual([null, null]);
    // The end of the promised day in Cairo, in summer time, and the zone of the carrier for a reply without a country.
    expect(estimate(received, (body) => { body.PromisedDate = '2026-05-07T20:59:59.999Z'; body.deliveryCountryCode = 'EG'; }))
      .toEqual([null, '2026-05-07']);
    expect(estimate(received, (body) => { body.PromisedDate = '2026-01-07T22:30:00.000Z'; delete body.deliveryCountryCode; }))
      .toEqual([null, '2026-01-08']);
  });

  it('keeps an older shipment the tracker shows only by its current state as a summary', () => {
    const summary = (state: Row, name = 'delivered') => parseBosta(changed(name, (body) => {
      delete (body as Row).TransitEvents;
      body.CurrentStatus = state;
    }), name === 'delivered' ? DELIVERED : RETURNED);
    expect(summary({ state: 'Delivered', code: 45, timestamp: '2026-05-12T12:05:47.733Z' })).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered', provider_code: '45',
      last_update: '2026-05-12T12:05:47.733Z', expected_delivery: null, delivered_at: '2026-05-12T12:05:47.733Z', destination_country: 'EG',
      summary_only: true, events: [],
    });
    expect(summary({ state: 'Deleted', code: 48, timestamp: '2026-05-10T09:30:00.000Z' }))
      .toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Deleted', provider_code: '48', expected_delivery: null });
    expect(summary({ state: 'Received at warehouse', code: 24, timestamp: '2026-05-11T13:40:05.902Z' }))
      .toMatchObject({ status: 'in_transit', current_stage: 'in_transit', expected_delivery: '2026-05-12' });
    expect(summary({ state: 'Received at warehouse', code: 24, timestamp: '2026-02-07T17:12:00.300Z' }, 'returned'))
      .toMatchObject({ current_stage: 'returned', expected_delivery: null });
    expect(() => summary({ state: '', code: 45, timestamp: '2026-05-12T12:05:47.733Z' }))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => summary({ state: 'Synthetic state', timestamp: '2026-05-12T12:05:47.733Z' }))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('reads a draft order as no history, not a shipment', () => {
    expect(() => parseBosta(fixture('draft'), DRAFT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError', reason: 'no_history' }));
    expect(() => parseBosta(fixture('draft'), '810005')).toThrow(expect.objectContaining({ message: 'Bosta answered for another shipment' }));
  });

  it('counts a reply only when it names the number asked', () => {
    // The service answers some numbers with another shipment.
    expect(() => parseBosta(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Bosta answered for another shipment' }));
    expect(() => parseBosta(changed('in-transit', (body) => { body.TrackingNumber = '8100000100'; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseBosta(changed('in-transit', (body) => { body.TrackingNumber = Number(IN_TRANSIT); }), IN_TRANSIT).events).toHaveLength(6);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete (body as Row).CurrentStatus; },
      (body: Reply) => { body.CurrentStatus = 'Delivered' as never; },
      (body: Reply) => { delete body.TrackingNumber; },
      (body: Reply) => { body.TrackingNumber = { number: DELIVERED }; },
      (body: Reply) => { body.TrackingNumber = -1; },
      (body: Reply) => { body.TransitEvents = 'scans' as never; },
      (body: Reply) => { body.TransitEvents = Array.from({ length: 501 }, () => body.TransitEvents[0]!); },
      (body: Reply) => { body.TransitEvents[0] = 'scan' as never; },
      (body: Reply) => { body.TransitEvents[0]!.state = ['Order is delivered']; },
      (body: Reply) => { body.TransitEvents[0]!.state = ''; },
      (body: Reply) => { body.TransitEvents[0]!.code = '45'; },
      (body: Reply) => { body.TransitEvents[0]!.code = 4.5; },
      (body: Reply) => { delete body.TransitEvents[0]!.timestamp; },
      (body: Reply) => { body.TransitEvents[0]!.timestamp = '2026-05-10 09:12:44'; },
      (body: Reply) => { body.TransitEvents[0]!.timestamp = '2026-05-10T09:12:44.120+02:00'; },
      (body: Reply) => { body.TransitEvents[0]!.timestamp = '2026-02-30T09:12:44.120Z'; },
      (body: Reply) => { body.CurrentStatus.code = 'delivered'; },
      (body: Reply) => { body.deliveryCountryCode = 20; },
      (body: Reply) => { body.Type = ['SEND']; },
    ]) {
      expect(() => parseBosta(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    // The service answers a number it does not know with HTTP 404 and its own message.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('<html><title>404 Not Found</title></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ error: 'Not found' }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://bosta.co/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      { status: 404, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><head><title>Attention Required! | Cloudflare</title></head></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Bosta</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    // A not-found message on HTTP 200 is not the service's answer for an unknown number.
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('reads the service’s refusal after too many lookups as a rate limit with its wait', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(TOO_MANY, { status: 429, headers: { 'Retry-After': '300' } }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 300_000 });
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, leaves a draft open and asks nothing for a number Bosta does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found'), { status: 404 }))
      .mockResolvedValueOnce(reply(fixture('draft')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-05-12T12:05:47.733Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(DRAFT)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(fetcher).recognize!('BOSTA0001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers Bosta does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['810', '01234567', '81000000001', 'BOSTA81000001', '8100000A', `8${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeBostaNumber('81 000-002')).toBe(DELIVERED);
    expect(normalizeBostaNumber('9100000001')).toBe('9100000001');
    expect(normalizeBostaNumber(DRAFT)).toBe(DRAFT);
  });

  it('sends a read that failed to reach the service once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a number filed under Bosta to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'bosta' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'bosta', source: 'bosta', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(BOSTA_API))).toBe(true);
  });
});

describe('Bosta numbers', () => {
  it('leaves its bare digit runs to no rule', () => {
    for (const number of [IN_TRANSIT, DELIVERED, '1000001', '9100000001']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('bosta');
    }
  });
});

describe('Bosta status vocabulary', () => {
  it('records every code and wording with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean; confirmedBy: string }[]) {
      // The timeline labels in the page's script are not what the lookup returns.
      if (!entry.code && !entry.unmapped && entry.confirmedBy === 'official-doc') continue;
      const wording = entry.wording.toLowerCase();
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code ?? null, wording), entry.wording).toBeUndefined();
        expect(bostaStage(entry.code ? Number(entry.code) : undefined, entry.wording), entry.wording).toBeNull();
        expect(statusMapAnswer({ carrier: 'bosta', providerCode: entry.code ?? null, description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code ?? null, wording), entry.wording).toBe(entry.stage);
      expect(bostaStage(entry.code ? Number(entry.code) : undefined, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'bosta', providerCode: '41', description: 'Order is out for return to the shipper' }))
      .toEqual({ kind: 'mapped', stage: 'returned' });
    expect(statusMapAnswer({ carrier: 'bosta', providerCode: '41', description: 'Order is out for delivery' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'bosta', providerCode: '999', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to the shared wording rules.
    expect(bostaStage(999, 'Order is delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(bostaStage(999, 'Synthetic note')).toBeNull();
    expect(bostaStage(22, 'Order is delivered')).toBeNull();
  });
});
