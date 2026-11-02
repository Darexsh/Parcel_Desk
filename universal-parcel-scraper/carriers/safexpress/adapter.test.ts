import { describe, expect, it, vi } from 'vitest';
import { CarrierError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import { isPartialAnswer } from '../../core/result/partial.js';
import type { LookupRecord, StepRecord } from '../../core/telemetry/index.js';
import { SafexpressTracker } from './adapter.js';
import { normalizeSafexpressNumber, parseSafexpress } from './parser.js';

const NUMBER = '100076543210';
const TOKEN = 'synthetic-guest-token';
const detail = (status: string, eventDate: string, extra: Record<string, unknown> = {}) => ({
  wayblNo: NUMBER, status, eventDate, ...extra,
});
function shipment(extra: Record<string, unknown> = {}) {
  return { wayblNo: NUMBER, trackBy: 'WB', ttlPkgs: '2', dlvryPkgs: '2',
    status: [{ status: 'BOOKED', trackDate: '2025-04-01 00:00:00' },
      { status: 'OUT FOR DELIVERY', trackDate: '2025-04-03 09:30:00' },
      { status: 'DELIVERED', trackDate: '2025-04-03 23:59:59' }],
    details: [detail('BOOKED', '2025-04-01 00:00:00', { eventDesc: 'Waybill Generated at DELHI' }),
      detail('IN-TRANSIT', '2025-04-01 13:14:15', { eventDesc: 'Consignment Arrived at DELHI' }),
      detail('ARRIVED AT DESTINATION', '2025-04-02 12:13:14', { eventDesc: 'Consignment Arrived at MUMBAI' }),
      detail('DELIVERED', '2025-04-03 23:59:59', { eventDesc: 'Consignment Delivered :- 03-Apr-2025' }),
      detail('OUT FOR DELIVERY', '2025-04-03 09:30:00'),
      detail('DELIVERED', '2025-04-03 23:59:59')], ...extra };
}
const payload = (item = shipment()) => ({ status: 'Ok', data: { tracking: [item] } });
const bootstrap = () => Response.json({ status: '200', result: 'success', error: '', msg: TOKEN });
const rendered = (value: unknown) => JSON.stringify(value, Object.getOwnPropertyNames(value instanceof Error ? value : {}));

describe('Safexpress history parsing', () => {
  it('retains details, orders a misplaced delivery, deduplicates milestones, and preserves calendar days', () => {
    const result = parseSafexpress(payload(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null,
      last_update_local: '2025-04-03', delivered_at: '2025-04-03', timezone: 'Asia/Kolkata' });
    expect(result.events).toEqual([
      { description: 'DELIVERED', local_time: '2025-04-03', stage: 'delivered', stage_source: 'carrier_map', provider_code: 'DELIVERED' },
      { description: 'OUT FOR DELIVERY', local_time: '2025-04-03T09:30:00', stage: 'out_for_delivery', stage_source: 'carrier_map', provider_code: 'OUT FOR DELIVERY' },
      { description: 'ARRIVED AT DESTINATION', local_time: '2025-04-02T12:13:14', location: 'MUMBAI', stage: 'in_transit', stage_source: 'carrier_map', provider_code: 'ARRIVED AT DESTINATION' },
      { description: 'IN-TRANSIT', local_time: '2025-04-01T13:14:15', location: 'DELHI', stage: 'in_transit', stage_source: 'carrier_map', provider_code: 'IN-TRANSIT' },
      { description: 'BOOKED', local_time: '2025-04-01', location: 'DELHI', stage: 'registered', stage_source: 'carrier_map', provider_code: 'BOOKED' },
    ]);
  });

  it('accepts the official form lengths without making them detector evidence', () => {
    for (const number of ['87654321', '876543210', NUMBER, '123456789012345']) expect(normalizeSafexpressNumber(number)).toBe(number);
    expect(normalizeSafexpressNumber('1000 7654-3210')).toBe(NUMBER);
    for (const number of ['1234567', '1234567890', `${NUMBER}1`, `${NUMBER},${NUMBER}`, 'ABC123456789']) {
      expect(() => normalizeSafexpressNumber(number)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('binds the whole container and every detail identity and rejects ambiguous replies', () => {
    for (const body of [payload(shipment({ wayblNo: '100076543211' })), payload(shipment({ wayblNo: `${NUMBER} ${NUMBER}` })),
      payload(shipment({ trackBy: 'INV' })), payload(shipment({ details: [detail('BOOKED', '2025-04-01', { wayblNo: '100076543211' })] })),
      { status: 'Ok', data: { tracking: [shipment(), shipment()] } }]) {
      expect(() => parseSafexpress(body, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    const old = '87654321';
    expect(parseSafexpress(payload(shipment({ wayblNo: old, details: [detail('BOOKED', '2025-04-01', { wayblNo: old })], status: [] })), old).events).toHaveLength(1);
  });

  it('keeps empty, malformed and refused envelopes distinct from not-found', () => {
    expect(() => parseSafexpress(payload(shipment({ details: [], status: [] })), NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    for (const body of [{}, { status: 'Error', data: { tracking: [] } }, payload(shipment({ details: null })),
      payload(shipment({ details: [detail('IN-TRANSIT', '2025-02-30 12:00:00')] })),
      payload(shipment({ details: [detail('IN-TRANSIT', '2025-04-01 24:00:00')] }))]) {
      expect(() => parseSafexpress(body, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('preserves an offset stated by a scan', () => {
    const result = parseSafexpress(payload(shipment({ status: [], details: [detail('IN-TRANSIT', '2025-04-01T13:14:15+05:30')] })), NUMBER);
    expect(result.events?.[0]).toMatchObject({ time: '2025-04-01T13:14:15+05:30' });
    expect(result.events?.[0]?.local_time).toBeUndefined();
  });

  it('marks milestone-only and capped histories as partial so richer enabled providers remain eligible', () => {
    const summary = parseSafexpress(payload(shipment({ details: [] })), NUMBER);
    expect(summary.summary_only).toBe(true);
    expect(isPartialAnswer(summary)).toBe(true);
    const many = Array.from({ length: 101 }, (_, i) => detail('IN-TRANSIT', `2025-04-01 ${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`));
    const capped = parseSafexpress(payload(shipment({ status: [], details: many })), NUMBER);
    expect(capped.events).toHaveLength(100);
    expect(capped.history_truncated).toBe(true);
  });

  it('does not complete a multi-package shipment after a partial delivery', () => {
    const result = parseSafexpress(payload(shipment({ dlvryPkgs: '1' })), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', history_truncated: true });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events?.[0]).toMatchObject({ description: 'Partially delivered', stage: 'in_transit' });
    expect(result.events?.[0]?.provider_code).toBeUndefined();
  });

  it('does not call an ordinary in-transit package count an incomplete history', () => {
    const result = parseSafexpress(payload(shipment({ dlvryPkgs: '0', status: [],
      details: [detail('IN-TRANSIT', '2025-04-02 12:00:00')] })), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit' });
    expect(result.history_truncated).toBeUndefined();
    expect(result.summary_only).toBeUndefined();
  });

  it('projects operational fields without recipient, POD, free-form descriptions, identifiers or unknown status text', () => {
    const secret = 'PRIVATE_RECIPIENT synthetic@example.invalid +91 5551234567';
    const item = shipment({ recipient: secret, propeliWayblId: secret, responseId: secret, details: [
      detail('DELIVERED', '2025-04-03 23:59:59', { eventDesc: `Delivered to ${secret}`, detailsMessage: secret, recipient: secret,
        podUrl: `https://private.invalid/${secret}`, propeliWbId: secret }),
      detail(secret, '2025-04-02 12:00:00', { eventDesc: secret, origin: secret, destination: secret }),
    ] });
    const text = JSON.stringify(parseSafexpress(payload(item), NUMBER));
    expect(text).not.toContain(secret);
    expect(text).not.toContain(NUMBER);
    expect(text).not.toContain('private.invalid');
    expect(text).toContain('Tracking update');
  });
});

describe('Safexpress guest flow', () => {
  it('uses the supplied transport, UA, whole number array and token without sharing tokens across lookups', async () => {
    const fetcher = vi.fn().mockImplementation(async (url, init) => {
      if (String(url).endsWith('getpropeliauth2token')) return bootstrap();
      expect(new Headers(init.headers).get('token')).toBe(TOKEN);
      return Response.json(payload());
    });
    const tracker = new SafexpressTracker({ fetcher, userAgent: 'Synthetic test agent' });
    await tracker.fetch(NUMBER);
    await tracker.fetch(NUMBER);
    expect(fetcher).toHaveBeenCalledTimes(4);
    for (const [index, [url, init]] of fetcher.mock.calls.entries()) {
      expect(String(url)).toMatch(index % 2 ? /\/trackingbytype$/ : /\/getpropeliauth2token$/);
      expect(new Headers(init.headers).get('User-Agent')).toBe('Synthetic test agent');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      if (index % 2) expect(JSON.parse(init.body)).toEqual({ docNo: [NUMBER], docType: 'WB' });
      else expect(new Headers(init.headers).has('token')).toBe(false);
    }
  });

  it('restarts token acquisition on network failure and keeps recovery errors private in telemetry', async () => {
    const records: (StepRecord | LookupRecord)[] = [];
    const fetcher = vi.fn().mockResolvedValueOnce(bootstrap()).mockRejectedValueOnce(new Error(`private request ${TOKEN} ${NUMBER}`))
      .mockResolvedValueOnce(bootstrap()).mockResolvedValueOnce(Response.json(payload()));
    await expect(new SafexpressTracker({ fetcher, recorder: { step: r => records.push(r), lookup: r => records.push(r) } }).fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(records).toMatchObject([{ step: 'direct', outcome: 'transport' },
      { step: 'retry', outcome: 'ok', fallbackFrom: 'direct', fallbackReason: 'transport', fallbackErrorType: 'UpstreamNetworkError' },
      { finalStep: 'retry', outcome: 'ok', attempts: 2 }]);
    for (const record of records) {
      for (const value of ['error' in record ? record.error : undefined, 'fallbackError' in record ? record.fallbackError : undefined]) {
        if (value === undefined) continue;
        expect(value).toBeInstanceOf(UpstreamNetworkError);
        expect(rendered(value)).not.toContain(TOKEN);
        expect(rendered(value)).not.toContain(NUMBER);
        expect((value as Error).cause).toBeUndefined();
      }
    }
  });

  it.each([401, 403, 429, 500, 503])('preserves HTTP %i without retrying or retaining request or response secrets', async status => {
    const records: (StepRecord | LookupRecord)[] = [];
    const fetcher = vi.fn().mockResolvedValueOnce(bootstrap()).mockResolvedValueOnce(new Response(`private ${TOKEN} ${NUMBER}`, {
      status, headers: { 'Retry-After': '15', 'X-Private-Token': TOKEN },
    }));
    let failure: unknown;
    try { await new SafexpressTracker({ fetcher, recorder: { step: r => records.push(r), lookup: r => records.push(r) } }).fetch(NUMBER); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(UpstreamHttpError);
    expect(failure).toMatchObject({ status, retryAfterMs: 15_000 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const record of records) {
      if (record.error !== undefined) {
        expect(rendered(record.error)).not.toContain(TOKEN);
        expect(rendered(record.error)).not.toContain(NUMBER);
        expect(record.error).not.toHaveProperty('request.url');
        expect(record.error).not.toHaveProperty('diagnostics.body');
      }
    }
  });

  it.each([301, 404, 410])('treats a moved or unavailable endpoint (%i) as transport', async status => {
    const fetcher = vi.fn().mockResolvedValue(new Response('unavailable', { status }));
    await expect(new SafexpressTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('distinguishes blocked HTML, malformed JSON and failed or invalid bootstrap replies without retrying', async () => {
    for (const [reply, kind] of [[new Response('<html><title>Just a moment</title>captcha</html>'), 'challenge'],
      [new Response(`invalid json ${TOKEN}`), 'schema'], [Response.json({ result: 'failed', msg: TOKEN }), 'indeterminate'],
      [Response.json({ result: 'success', msg: '' }), 'schema']] as const) {
      const fetcher = vi.fn().mockResolvedValue(reply);
      await expect(new SafexpressTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('honors cancellation before and during a request', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const fetcher = vi.fn();
    await expect(new SafexpressTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    const active = new AbortController();
    const blocked = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      active.abort(new Error('cancelled'));
    }));
    await expect(new SafexpressTracker({ fetcher: blocked }).fetch(NUMBER, { signal: active.signal })).rejects.toMatchObject({ kind: 'transport' });
    expect(blocked).toHaveBeenCalledTimes(1);
  });

  it('shares the attempt budget across bootstrap and tracking', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 80));
        return bootstrap();
      });
      const promise = new SafexpressTracker({ fetcher }).fetch(NUMBER, { budgetMs: 100 });
      const assertion = expect(promise).rejects.toBeInstanceOf(CarrierError);
      await vi.advanceTimersByTimeAsync(200);
      await assertion;
      expect(fetcher.mock.calls.every(([url]) => String(url).endsWith('getpropeliauth2token'))).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
