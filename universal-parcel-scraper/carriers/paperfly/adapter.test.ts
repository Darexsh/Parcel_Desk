import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PAPERFLY_API, PaperflyTracker } from './adapter.js';
import { paperflyRequestNumber } from './number.js';
import { paperflyWording, parsePaperfly } from './parser.js';
import { paperflyStage, paperflySummaryStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'PFLBDZZ0000000001';
const DELIVERED_ORDER = '010126000001A1B2';
const IN_TRANSIT = '02012600002C3D4';
const CLOSED = '030126000003E5F6';
const UNKNOWN = '010125000000A1A1';

type Row = Record<string, unknown>;
type Order = Row & { package: Row; timeline: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Order;
const changed = (name: string, change: (order: Order) => void) => {
  const order = fixture(name);
  change(order);
  return order;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const NOT_FOUND = { status: 400 };

describe('Paperfly HTTP adapter', () => {
  it('posts the number with its hyphens to the tracking page’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PaperflyTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' pflbd zz 0000000001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${PAPERFLY_API}?order_number=PFL-BD-ZZ-0000000001`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'paperfly', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('writes each number the way the tracker finds it', () => {
    expect(paperflyRequestNumber(DELIVERED_ORDER)).toBe('010126-000001-A1-B2');
    expect(paperflyRequestNumber('02012600002c3d4')).toBe('020126-00002-C3-D4');
    expect(paperflyRequestNumber('3101260000A1A1')).toBe('310126-0000-A1-A1');
    expect(paperflyRequestNumber('Z-241225-00000-A1-H7')).toBe('Z-241225-00000-A1-H7');
    expect(paperflyRequestNumber('pfl-bd-zz-0000000001')).toBe('PFL-BD-ZZ-0000000001');
  });

  it('reads the history at Bangladesh’s offset, newest first, without the riders', () => {
    const result = parsePaperfly(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Invoiced', last_update: '2026-01-07T18:30:00+06:00', expected_delivery: null,
      delivered_at: '2026-01-07T14:12:45+06:00', canonical_tracking_number: '010126-000001-A1-B2' });
    expect(result.events!.map((event) => [event.time, event.description, event.stage ?? null])).toEqual([
      ['2026-01-07T18:30:00+06:00', 'Invoiced', null],
      ['2026-01-07T14:12:45+06:00', 'Delivered', 'delivered'],
      ['2026-01-07T10:01:30+06:00', 'On the way to delivery', 'out_for_delivery'],
      ['2026-01-06T16:48:02+06:00', 'On hold, Reason: কাস্টমার আজ পার্সেলটি নিতে পারবে না', 'failed_attempt'],
      ['2026-01-06T10:15:20+06:00', 'On the way to delivery', 'out_for_delivery'],
      // The repeated line is kept once.
      ['2026-01-05T20:05:10+06:00', 'Reached delivery point', 'in_transit'],
      ['2026-01-05T06:30:00+06:00', 'Parcel in transit', 'in_transit'],
      ['2026-01-03T21:10:00+06:00', 'Parcel Picked', 'accepted'],
      ['2026-01-02T11:00:00+06:00', 'Pickup request sent', 'registered'],
    ]);
    expect(result).not.toHaveProperty('history_truncated');
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Person|Upazila|District|Road|Thana|goods)|SAMPLE (?:SHOP|RIDER)|01000000|XXXXX|1250|000000"|rotp|0\.50/);
  });

  it('keeps an order found by its own number without a canonical number', () => {
    const result = parsePaperfly(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'On the way to delivery', last_update: '2026-01-04T09:10:00+06:00' });
    expect(result).not.toHaveProperty('canonical_tracking_number');
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events).toHaveLength(5);
    expect(parsePaperfly(fixture('delivered'), DELIVERED_ORDER)).not.toHaveProperty('canonical_tracking_number');
  });

  it('takes the order’s status over a history that lost its lines, and says the history is partial', () => {
    const result = parsePaperfly(fixture('closed'), CLOSED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-01-05T06:30:00+06:00', history_truncated: true });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events).toEqual([{ time: '2026-01-05T06:30:00+06:00', description: 'Parcel in transit', stage: 'in_transit',
      stage_source: 'carrier_map' }]);
    const held = parsePaperfly(changed('closed', (order) => { order.status = 'On hold'; }), CLOSED);
    expect(held).toMatchObject({ current_stage: 'failed_attempt', last_status_text: 'On hold', history_truncated: true });
    const partial = parsePaperfly(changed('delivered', (order) => { order.status = 'Partially delivered'; }), DELIVERED);
    expect(partial).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-01-07T14:12:45+06:00' });
    expect(partial).not.toHaveProperty('history_truncated');
    // A status the map does not know leaves the newest staged line in charge.
    const unknown = parsePaperfly(changed('in-transit', (order) => { order.status = 'Synthetic state'; }), IN_TRANSIT);
    expect(unknown).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'On the way to delivery' });
    expect(unknown).not.toHaveProperty('history_truncated');
  });

  it('keeps an order without history lines as its status alone', () => {
    const result = parsePaperfly(changed('closed', (order) => { order.timeline = []; }), CLOSED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      last_update: null, summary_only: true, events: [] });
    expect(result).not.toHaveProperty('history_truncated');
    expect(() => parsePaperfly(changed('closed', (order) => { order.timeline = []; order.status = 'Synthetic state'; }), CLOSED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parsePaperfly(changed('closed', (order) => { delete (order as Row).timeline; order.status = ''; }), CLOSED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('takes riders, phone numbers and amounts out of the wording', () => {
    expect(paperflyWording('On the way to delivery,Name: SAMPLE RIDER,Call: 01000000000')).toBe('On the way to delivery');
    expect(paperflyWording('On the way to delivery, Phone: +880 1000-000000')).toBe('On the way to delivery');
    expect(paperflyWording('On hold, Reason: Customer 017XXXXX000 asked for tomorrow')).toBe('On hold, Reason: Customer asked for tomorrow');
    expect(paperflyWording('Partial delivery requested by DA, proposed cash 500')).toBe('Partial delivery requested by DA, proposed cash');
    expect(paperflyWording('Paid returned, charge ৳ 60')).toBe('Paid returned, charge');
    expect(paperflyWording('Collected 1,250 Tk')).toBe('Collected');
    // A date stays.
    expect(paperflyWording('On hold, Reason: Delivery on 2026-01-09')).toBe('On hold, Reason: Delivery on 2026-01-09');
  });

  it('skips lines without a clock or wording and rejects a changed reply', () => {
    const skipped = parsePaperfly(changed('in-transit', (order) => {
      order.timeline.push({ date_time: '0000-00-00 00:00:00', message: 'Pickup request sent' }, { date_time: '2026-01-01 00:00:00', message: '' });
    }), IN_TRANSIT);
    expect(skipped.events).toHaveLength(5);
    for (const change of [
      (order: Order) => { delete (order as Row).order_number; },
      (order: Order) => { order.order_number = 7; },
      (order: Order) => { order.package = 'package' as never; },
      (order: Order) => { order.package.merchant_order_ref = ['SAMPLE']; },
      (order: Order) => { order.timeline = 'timeline' as never; },
      (order: Order) => { order.timeline = Array.from({ length: 501 }, () => order.timeline[0]!); },
      (order: Order) => { order.timeline[0] = 'line' as never; },
      (order: Order) => { order.timeline[0]!.date_time = '04/01/2026 09:10'; },
      (order: Order) => { order.timeline[0]!.date_time = '2026-01-04T09:10:00Z'; },
      (order: Order) => { order.timeline[0]!.date_time = '2026-02-30 09:10:00'; },
      (order: Order) => { order.timeline[0]!.message = { text: 'Delivered' }; },
      (order: Order) => { order.status = 3; },
    ]) {
      expect(() => parsePaperfly(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parsePaperfly('order', IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePaperfly({ error: 'Merchant Order number not found' }, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('counts an order only when it names the number asked, as its own number or its merchant’s reference', () => {
    expect(() => parsePaperfly(fixture('in-transit'), CLOSED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Paperfly answered for another order' }));
    // A longer or shorter number in the reply is another order.
    expect(() => parsePaperfly(changed('delivered', (order) => { order.package.merchant_order_ref = 'PFL-BD-ZZ-00000000011'; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePaperfly(changed('delivered', (order) => { delete (order as Row).package; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parsePaperfly(changed('in-transit', (order) => { order.order_number = '020126-00002-c3-d4'; }), IN_TRANSIT).events).toHaveLength(5);
  });

  it('reads the service’s own error for an unknown number as not found', () => {
    expect(() => parsePaperfly(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('keeps an unknown number, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'), NOT_FOUND)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // A 400 without the service's error is no answer about the order.
    await expect(lookup({ message: 'Bad request' }, NOT_FOUND)).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('<html><title>400 Bad Request</title></html>', NOT_FOUND)).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://paperfly.com.bd/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><script src="https://sample.awswaf.com/challenge.js"></script></html>', { status: 403 }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><head><title>Just a moment...</title></head></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Paperfly</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number Paperfly does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found'), NOT_FOUND));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-01-07T12:30:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('PFLBD0000000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Paperfly does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['320126000001A1B2', '011326000001A1B2', '010126000A1B2', '0101260000001A1B2', '010126000001AAB2',
      'PFLBD0000000001', 'PFLBDZ00000000001', 'X010126000001A1B2', 'SAMPLETRACKING', `PFLBDZZ${'0'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends a read that fails to reach the site once more, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 3000 })).resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('routes a number filed under Paperfly, or detected as one of its numbers, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'paperfly' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'paperfly', source: 'paperfly', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: 'PFL-BD-ZZ-0000000001' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'paperfly', source: 'paperfly' });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(PAPERFLY_API))).toBe(true);
  });
});

describe('Paperfly numbers', () => {
  it('claims its order numbers, with or without the API’s Z, and Daraz’s references', () => {
    for (const number of ['010126-000001-A1-B2', '020126-00002-C3-D4', '311225-0000-K1-K1', 'Z-010126-00000-A1-B2', 'PFL-BD-ZZ-0000000001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'paperfly', confidence: 'high' });
    }
    for (const number of ['320126-000001-A1-B2', '010126-000-A1-B2', 'Y-010126-00000-A1-B2', 'PFL-BD-0000000001']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('paperfly');
    }
  });
});

describe('Paperfly status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string }[]) {
      const stage = paperflySummaryStage(entry.wording) ?? paperflyStage(entry.wording)?.stage;
      expect(stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'paperfly', providerCode: null, description: 'On the way to delivery' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'paperfly', providerCode: null, description: 'Invoiced' })).toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'paperfly', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(statusMap.stage(null, 'reached at delivery point')).toBe('in_transit');
    // Wording the map does not know falls to the shared rules.
    expect(paperflyStage('Synthetic note')).toBeNull();
  });
});
