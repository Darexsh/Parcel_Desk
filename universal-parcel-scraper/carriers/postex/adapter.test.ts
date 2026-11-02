import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, POSTEX_API, PostexTracker } from './adapter.js';
import { normalizePostexNumber, parsePostex, postexWording } from './parser.js';
import { postexStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '00000000000001';
const IN_TRANSIT = '00000000000002';
const NO_HISTORY = '00000000000003';
const UNKNOWN = '00000000000009';

type Row = Record<string, unknown>;
type Shipment = Row & { transactionStatusHistory: Row[] };
type Reply = Row & { dist: Shipment };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (shipment: Shipment, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.dist, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('PostEx HTTP adapter', () => {
  it('posts the whole number to the tracking page’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PostexTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 0000 0000 0000 02 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(POSTEX_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ trackingNumber: IN_TRANSIT });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'postex', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each scan’s instant with PostEx’s offset and stages it by its code', () => {
    const result = parsePostex(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Waiting for Delivery', last_update: '2026-04-12T08:21:30+05:00', expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['2026-04-12T08:21:30+05:00', '0038', 'in_transit', null],
      ['2026-04-12T08:19:05+05:00', '0035', 'in_transit', 'DST'],
      ['2026-04-11T22:40:10+05:00', '0033', 'in_transit', null],
      ['2026-04-10T21:02:57+05:00', '0003', 'in_transit', 'ORG'],
      ['2026-04-10T17:48:03+05:00', '0031', 'accepted', null],
      ['2026-04-10T09:12:44+05:00', '0001', 'registered', null],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.stage_source === 'carrier_map')).toBe(true);
  });

  it('keeps the delivery without the customer, the merchant, the repeated scan or a code the page leaves out', () => {
    const result = parsePostex(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered to Customer', last_update: '2026-03-05T17:42:09+05:00', delivered_at: '2026-03-05T17:42:09+05:00' });
    expect(result.events!.map((event) => [event.provider_code, event.stage, event.description])).toEqual([
      ['0005', 'delivered', 'Delivered to Customer'],
      ['0004', 'out_for_delivery', 'Enroute for Delivery'],
      ['0013', 'failed_attempt', 'Attempt Made: CNA(CUSTOMER NOT AVAILABLE)'],
      ['0004', 'out_for_delivery', 'Enroute for Delivery'],
      ['0038', 'in_transit', 'Waiting for Delivery'],
      ['0035', 'in_transit', 'Arrived at Transit Hub SMP'],
      ['0033', 'in_transit', 'Departed to SAMPLE CITY'],
      // Logged in the same second, listed as the reply lists them.
      ['0003', 'in_transit', 'Received at ORG Warehouse'],
      ['0031', 'accepted', 'Departed to PostEx. Warehouse'],
      ['0001', 'registered', 'At Merchant\'s Warehouse'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Customer|Store)|SAMPLE STORE|feedback|0099|2026-03-02T10:05:11\.000/);
  });

  it('reads a history listed oldest first newest first', () => {
    const result = parsePostex(changed('in-transit', (shipment) => { shipment.transactionStatusHistory.reverse(); }), IN_TRANSIT);
    expect(result).toMatchObject({ last_update: '2026-04-12T08:21:30+05:00', last_status_text: 'Waiting for Delivery' });
    expect(result.events!.at(-1)).toMatchObject({ provider_code: '0001' });
  });

  it('keeps scans of one instant in the carrier’s order', () => {
    const result = parsePostex(changed('in-transit', (shipment) => {
      const rows = shipment.transactionStatusHistory.reverse();
      rows[2]!.modifiedDatetime = rows[1]!.modifiedDatetime;
    }), IN_TRANSIT);
    expect(result.events!.map((event) => event.provider_code)).toEqual(['0038', '0035', '0033', '0003', '0031', '0001']);
  });

  it('stages a code the map does not know by its wording, and leaves wording no rule knows without a stage', () => {
    const result = parsePostex(changed('delivered', (shipment) => {
      shipment.transactionStatusHistory.unshift(
        { transactionStatusMessage: 'Returned to Shipper', transactionStatusMessageCode: '0007', modifiedDatetime: '2026-03-08T12:00:00.000+0500' },
        { transactionStatusMessage: 'Synthetic note', transactionStatusMessageCode: '0045', modifiedDatetime: '2026-03-09T12:00:00.000+0500' },
      );
    }), DELIVERED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'wording:returned',
      last_status_text: 'Synthetic note', last_update: '2026-03-09T12:00:00+05:00' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events![0]).not.toHaveProperty('stage');
  });

  it('takes the merchant’s name and phone numbers out of the wording', () => {
    expect(postexWording('0001', 'At SAMPLE.STORE DESIGNS Warehouse')).toBe('At Merchant\'s Warehouse');
    expect(postexWording('0001', 'At SAMPLE STORE warehouse - SMP')).toBe('At Merchant\'s Warehouse');
    expect(postexWording('0001', 'Order Booked')).toBe('Order Booked');
    // Another code's warehouse is PostEx's own.
    expect(postexWording('0003', 'Received at ORG Warehouse')).toBe('Received at ORG Warehouse');
    expect(postexWording('0013', 'Attempt Made: rider 0300-0000000 called')).toBe('Attempt Made: rider called');
    expect(postexWording('0013', 'Attempt Made: call +92 300 0000000')).toBe('Attempt Made: call');
  });

  it('reads an unknown number as not found, and a consignment without scans as no history', () => {
    expect(() => parsePostex(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePostex({ ...fixture('not-found'), dist: null }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePostex(fixture('no-history'), NO_HISTORY)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    // A history the page would show nothing of.
    expect(() => parsePostex(changed('in-transit', (shipment) => {
      shipment.transactionStatusHistory = [{ transactionStatusMessage: 'Synthetic note', transactionStatusMessageCode: '0099',
        modifiedDatetime: '2026-04-12T08:21:30.000+0500' }];
    }), IN_TRANSIT)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('keeps the tracking service’s errors apart from a missing parcel', () => {
    expect(() => parsePostex({ timestamp: '2026-01-01T00:00:00.000+0500', status: 401, error: 'Unauthorized', path: '/api/sample' }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePostex({ status: 429, error: 'Too Many Requests' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parsePostex({ status: 502, error: 'Bad Gateway' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePostex({ error: 'Failed to fetch tracking information' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePostex({ statusCode: '500', statusMessage: 'Internal error' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('counts a shipment only when it names the whole number asked', () => {
    expect(() => parsePostex(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'PostEx answered for another shipment' }));
    expect(() => parsePostex(changed('in-transit', (shipment) => { shipment.trackingNumber = IN_TRANSIT.slice(1); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_shipment: Shipment, body: Reply) => { delete (body as Row).statusCode; },
      (_shipment: Shipment, body: Reply) => { body.statusCode = 200; },
      (_shipment: Shipment, body: Reply) => { body.dist = 'shipment' as never; },
      (shipment: Shipment) => { delete shipment.trackingNumber; },
      (shipment: Shipment) => { shipment.trackingNumber = 2; },
      (shipment: Shipment) => { shipment.transactionStatusHistory = 'scans' as never; },
      (shipment: Shipment) => { shipment.transactionStatusHistory = Array.from({ length: 501 }, () => shipment.transactionStatusHistory[0]!); },
      (shipment: Shipment) => { shipment.transactionStatusHistory[0] = 'scan' as never; },
      (shipment: Shipment) => { delete shipment.transactionStatusHistory[0]!.transactionStatusMessageCode; },
      (shipment: Shipment) => { shipment.transactionStatusHistory[0]!.transactionStatusMessageCode = 38; },
      (shipment: Shipment) => { shipment.transactionStatusHistory[0]!.transactionStatusMessage = ''; },
      (shipment: Shipment) => { shipment.transactionStatusHistory[0]!.transactionStatusMessage = ['Waiting']; },
      (shipment: Shipment) => { shipment.transactionStatusHistory[0]!.modifiedDatetime = '2026-04-12T08:21:30.000'; },
      (shipment: Shipment) => { shipment.transactionStatusHistory[0]!.modifiedDatetime = '2026-04-12T24:21:30.000+0500'; },
      (shipment: Shipment) => { shipment.transactionStatusHistory[0]!.modifiedDatetime = '12/04/2026 08:21'; },
      (shipment: Shipment) => { shipment.transactionStatusHistory[0]!.modifiedDatetime = 1_776_000_000_000; },
    ]) {
      expect(() => parsePostex(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page reads a missing parcel from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 308, headers: { Location: 'https://postex.pk/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(CLOUDFLARE, { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CLOUDFLARE, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>PostEx</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    // The page's server's own failure, which it gives for a lookup it could not make.
    await expect(lookup({ error: 'Failed to fetch tracking information' }, { status: 500 })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup({ status: 429, error: 'Too Many Requests' })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number PostEx does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-05T12:42:09.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('0000000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers PostEx does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['0000000000001', '000000000000001', 'PX000000000001', '1', `${'0'.repeat(14)}/`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizePostexNumber('0000-0000-0000-02')).toBe(IN_TRANSIT);
  });

  it('gives its one read the whole budget and ends a hanging read inside it', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a number filed under PostEx to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'postex' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'postex', source: 'postex', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === POSTEX_API)).toBe(true);
  });
});

describe('PostEx status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage?: string }[]) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(postexStage(entry.code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'postex', providerCode: '0013', description: 'Attempt Made: CNA(CUSTOMER NOT AVAILABLE)' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'postex', providerCode: '0099', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to the shared wording rules.
    expect(postexStage('0002', 'Returned')).toEqual({ stage: 'returned', source: 'wording:returned' });
    expect(postexStage('0099', 'Synthetic note')).toBeNull();
  });
});
