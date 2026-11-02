import { describe, expect, it, vi } from 'vitest';
import { NoHistoryError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER, type StepRecord } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { adapter, TAQBIN_HK_API } from './adapter.js';
import { parseTaqbinHkWaybill, TAQBIN_HK_MAX_BYTES, taqbinHkWaybill } from './parser.js';
import { statusMap, taqbinHkStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const PARCEL = '980001234560';
type Row = Record<string, unknown>;
const scan = (status: string, date = '2026-05-16', clock = '17:06', location = 'HONG KONG'): Row => ({
  status, createddatecaption: date, createdtimecaption: clock, location,
  statusreason: 'Signed by SAMPLE RECIPIENT', createdbyName: 'SAMPLE OPERATOR', noofrecords: 1,
});
const payload = (rows: Row[], total = rows.length) => ({ d: JSON.stringify(rows.map((row) => ({ ...row, noofrecords: total }))) });
const history = () => payload([
  scan('Delivered'), scan('Out for delivery', '2026-05-16', '10:19'), scan('Received', '2026-05-15', '18:10'),
]);
const response = (data: unknown = history(), init: ResponseInit = {}) => new Response(JSON.stringify(data), init);
const carrier = (fetcher?: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null, userAgent: 'Parcel Test Client' });

describe('TA-Q-BIN Hong Kong waybills', () => {
  it('posts exactly one whole waybill to the Hong Kong service with the supplied transport and identity', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    await expect(carrier(fetcher).track({ number: '9800-0123-4560' })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(TAQBIN_HK_API);
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ keyTrackingNumber: PARCEL }), redirect: 'manual', cache: 'no-store' });
    expect(new Headers(init!.headers).get('User-Agent')).toBe('Parcel Test Client');
    expect(new Headers(init!.headers).get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(carrier(fetcher).recognize).toBeUndefined();
    expect(taqbinHkWaybill('9800 0123 4560')).toBe(PARCEL);
  });

  it('keeps the dated wall clocks and full history, stages every scan, and drops personal fields', () => {
    const result = parseTaqbinHkWaybill(history());
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-05-16T17:06', expected_delivery: null });
    expect(result.events).toEqual([
      { local_time: '2026-05-16T17:06', description: 'Delivered', location: 'HONG KONG', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2026-05-16T10:19', description: 'Out for delivery', location: 'HONG KONG', stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { local_time: '2026-05-15T18:10', description: 'Received', location: 'HONG KONG', stage: 'accepted', stage_source: 'carrier_map' },
    ]);
    for (const omitted of ['SAMPLE RECIPIENT', 'SAMPLE OPERATOR', 'statusreason', 'createdbyName', 'noofrecords']) expect(JSON.stringify(result)).not.toContain(omitted);
    expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('history_truncated');
  });

  it('orders scans, preserves ties and second precision, and reads a repeated scan once', () => {
    const result = parseTaqbinHkWaybill(payload([
      scan('Received', '2026-05-15', '18:10'), scan('Delivered', '2026-05-16', '17:06:25'),
      scan('Sample Note', '2026-05-16', '17:06:25', ''), scan('Delivered', '2026-05-16', '17:06:25'),
    ]));
    expect(result.events!.map((event) => [event.local_time, event.description])).toEqual([
      ['2026-05-16T17:06:25', 'Delivered'], ['2026-05-16T17:06:25', 'Sample Note'], ['2026-05-15T18:10', 'Received'],
    ]);
    expect(result.events![1]).not.toHaveProperty('stage');
    expect(result.events![1]).not.toHaveProperty('location');
    expect(result).not.toHaveProperty('history_truncated');
  });

  it('retains a reported incomplete history and bounds the events it projects', () => {
    expect(parseTaqbinHkWaybill(payload([scan('Received')], 5))).toMatchObject({ history_truncated: true });
    const rows = Array.from({ length: 101 }, (_, index) => scan('Sample Note', '2026-05-16',
      `${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`));
    const result = parseTaqbinHkWaybill(payload(rows));
    expect(result.events).toHaveLength(100);
    expect(result).toMatchObject({ status: 'unknown', history_truncated: true, last_update_local: '2026-05-16T01:40' });
  });

  it('keeps an empty waybill service inconclusive and leaves other parcel systems to enabled providers', async () => {
    expect(() => parseTaqbinHkWaybill({ d: '[]' })).toThrow(NoHistoryError);
    const empty = vi.fn<typeof fetch>().mockResolvedValue(response({ d: '[]' }));
    await expect(carrier(empty).track({ number: PARCEL })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(empty).toHaveBeenCalledOnce();
    const unused = vi.fn<typeof fetch>();
    for (const number of ['HK20980001234560', '98000123456', '9800012345601', 'SAMPLETRACKING', `98${'0'.repeat(70)}`]) {
      await expect(carrier(unused).track({ number })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'unsupported_service' });
      expect(taqbinHkWaybill(number)).toBeNull();
    }
    for (const prefix of ['1848', '2162', '2765', '2766', '9729', '3', '4', '9009', '9010', '9011', '9012', '9013', '6213', '9014', '0171']) {
      const number = `${prefix}${'980001234560'.slice(prefix.length)}`;
      await expect(carrier(unused).track({ number })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'unsupported_service' });
      expect(taqbinHkWaybill(number)).toBeNull();
    }
    expect(unused).not.toHaveBeenCalled();
  });

  it('rejects missing or changed data, foreign-system replies, and invalid counts', () => {
    for (const value of [null, [], {}, { d: null }, { d: [] }, { d: '{}' }, { d: 'broken' },
      { message: 'Success', data: [{ [PARCEL]: 'Tracking data not found' }] }, { d: '[null]' },
      { d: JSON.stringify([{ ...scan('Delivered'), noofrecords: '1' }]) },
      { d: JSON.stringify([{ ...scan('Delivered'), noofrecords: 0 }]) },
      { d: JSON.stringify([{ ...scan('Delivered'), noofrecords: 2 }, { ...scan('Received'), noofrecords: 3 }]) },
      payload(Array.from({ length: 501 }, () => scan('Received'))),
    ]) expect(() => parseTaqbinHkWaybill(value)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const [key, value] of [['status', ''], ['status', {}], ['createddatecaption', '2026-02-30'],
      ['createddatecaption', null], ['createdtimecaption', '24:00'], ['createdtimecaption', '12:60'],
      ['createdtimecaption', '12:00+08:00'], ['location', {}]] as const) {
      expect(() => parseTaqbinHkWaybill(payload([{ ...scan('Received'), [key]: value }]))).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps HTTP failures, a moved route, a browser check and malformed HTML distinct from empty history', async () => {
    for (const [status, kind] of [[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance'],
      [302, 'transport'], [404, 'transport'], [410, 'transport']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status, headers: { 'Retry-After': '60' } }));
      await expect(carrier(fetcher).track({ number: PARCEL })).rejects.toMatchObject({ kind, ...(status === 429 ? { retryAfterMs: 60_000 } : {}) });
      expect(fetcher).toHaveBeenCalledOnce();
    }
    for (const [body, kind] of [
      ['<!doctype html><title>Access Denied</title>', 'challenge'],
      ['<html>Request unsuccessful. Incapsula incident ID</html>', 'challenge'],
      ['<html><script src="/_Incapsula_Resource?test"></script></html>', 'challenge'],
      ['<html><title>Yamato tracking</title></html>', 'schema'], ['', 'schema'],
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      await expect(carrier(fetcher).track({ number: PARCEL })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('retries only a read that failed to reach the site and records the original failure', async () => {
    const events: StepRecord[] = [];
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(response());
    const tracker = adapter({ fetcher, recorder: { step: (event) => events.push(event), lookup() {} }, env: {}, trawl: null, browserExecutablePath: null });
    await expect(tracker.track({ number: PARCEL })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([, init]) => init!.body)).toEqual([JSON.stringify({ keyTrackingNumber: PARCEL }), JSON.stringify({ keyTrackingNumber: PARCEL })]);
    expect(events.map(({ step, outcome, fallbackFrom, fallbackReason }) => ({ step, outcome, fallbackFrom, fallbackReason }))).toEqual([
      { step: 'direct', outcome: 'transport', fallbackFrom: null, fallbackReason: null },
      { step: 'retry', outcome: 'ok', fallbackFrom: 'direct', fallbackReason: 'transport' },
    ]);
  });

  it('honors cancellation, the remaining budget and response-size limits', async () => {
    const unused = vi.fn<typeof fetch>();
    await expect(carrier(unused).track({ number: PARCEL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(unused).track({ number: PARCEL }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(unused).not.toHaveBeenCalled();
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(TAQBIN_HK_MAX_BYTES + 1)));
    await expect(carrier(large).track({ number: PARCEL })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'response_too_large' });
    expect(large).toHaveBeenCalledOnce();
    fakeBudgetClock();
    const started = performance.now();
    const hanging = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const pending = expect(carrier(hanging.fetcher).track({ number: PARCEL }, { budgetMs: 120.5 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(121);
    await pending;
    expect(hanging.fetcher).toHaveBeenCalledTimes(2);
    expect(hanging.ended.map((at) => at - started)).toEqual([60, 120]);
  });
});

describe('TA-Q-BIN Hong Kong status vocabulary', () => {
  it('maps the service vocabulary and keeps unknown wording unresolved', () => {
    for (const entry of statuses.entries) {
      expect(taqbinHkStage(entry.wording)).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording))).toBe(entry.stage);
      expect(statusMap.stage('FOREIGN', normalizeStatusWording(entry.wording))).toBeUndefined();
    }
    for (const wording of ['Sample Note', 'constructor', 'toString']) expect(taqbinHkStage(wording)).toBeNull();
    expect(taqbinHkStage('Parcel returned to sender')).toMatchObject({ stage: 'returned', source: 'wording:language' });
  });
});
