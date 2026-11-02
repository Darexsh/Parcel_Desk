import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { fillPartialAnswer, isPartialAnswer } from '../../core/result/partial.js';
import type { Stage } from '../../core/status/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SHIPGLOBAL_API, ShipGlobalTracker, shipGlobalLookupUrl } from './adapter.js';
import { normalizeShipGlobalNumber, parseShipGlobal, SHIPGLOBAL_MAX_BYTES, shipGlobalWording } from './parser.js';
import { shipGlobalMappedStage, shipGlobalStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'SG32602010000017';
const UNKNOWN = 'SG39801010000031';
type Row = Record<string, unknown>;
type Payload = { message: string; errors: unknown[]; data: { awbInfo: Row; trackingInfo: Row[] } };
const fixture = (name: string): Payload => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Payload;
const changed = (change: (payload: Payload) => void): Payload => {
  const payload = fixture('delivered');
  change(payload);
  return payload;
};
const reply = (body: unknown, status = 200, headers?: Record<string, string>) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const PRIVATE = /SYNTHETIC (?:SENDER|RECEIVER|POSTCODE|BAG|ACCOUNT)|SYNTHETIC_CAPABILITY|example\.invalid|awbPostCode|awbSenderName|awbReceiverName|partnerLastMileTrackingUrl|vendorId|dispatchBagCode/i;
const evidence = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item instanceof Error
  ? Object.fromEntries(Object.getOwnPropertyNames(item).map((key) => [key, (item as unknown as Row)[key]])) : item);

describe('ShipGlobal India guest tracking', () => {
  it('makes the official whole-number read with the supplied transport, user agent and signal', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { step: vi.fn(), lookup: vi.fn() };
    await expect(new ShipGlobalTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(' sg3 2602010000017 ', { budgetMs: 1_000.5 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SHIPGLOBAL_API}?trackingId=${NUMBER}`);
    expect(String(url)).toBe(shipGlobalLookupUrl(NUMBER));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', cache: 'no-store', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(new Headers(init!.headers).has('authorization')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'shipglobal-in', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('retains the combined history, minute precision and foreign wall clocks without personal data', () => {
    const result = parseShipGlobal(fixture('delivered'), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_update: null, last_update_local: '2026-02-10T15:20:01', destination_country: 'US', delivery_tracking_number: 'SYNTHETIC00000029' });
    expect(result.events).toHaveLength(9);
    expect(result.events!.map((event) => [event.local_time, event.stage])).toEqual([
      ['2026-02-10T15:20:01', 'delivered'], ['2026-02-10T08:00:00', 'out_for_delivery'],
      ['2026-02-09T10:12:11', 'in_transit'], ['2026-02-08T11:39', 'in_transit'],
      ['2026-02-08T10:15', 'customs'], ['2026-02-07T23:14', 'in_transit'],
      ['2026-02-06T20:21:22', 'in_transit'], ['2026-02-06T19:31:02', 'accepted'], ['2026-02-01T10:00:00', 'registered'],
    ]);
    expect(result.events![6]).toMatchObject({ provider_code: 'SGE_207' });
    expect(result.events!.filter((event) => event.provider_code)).toHaveLength(1);
    expect(result.events!.every((event) => !event.time && !event.time_zone)).toBe(true);
    expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('summary_only');
    expect(result).not.toHaveProperty('history_truncated');
    expect(evidence(result)).not.toMatch(PRIVATE);
    expect(result.events!.at(-1)).not.toHaveProperty('location');
  });

  it('keeps undated rows and leaves a richer enabled provider eligible', () => {
    const result = parseShipGlobal(fixture('partial'), NUMBER);
    expect(result.events).toHaveLength(10);
    expect(result.events!.slice(-2).every((event) => !event.time && !event.local_time)).toBe(true);
    expect(isPartialAnswer(result)).toBe(true);
    const fuller = { ...result, history_truncated: false,
      events: [...result.events!, { local_time: '2026-02-02T08:01:02', description: 'Order Picked Up', stage: 'accepted' }] };
    expect(fillPartialAnswer('shipglobal-in', NUMBER, result, fuller)).toMatchObject({ events: expect.any(Array) });
    expect(fillPartialAnswer('shipglobal-in', NUMBER, result, fuller)!.events).toHaveLength(11);
  });

  it('keeps a delivery after a return leg as a return, including when the summary says delivered', () => {
    const result = parseShipGlobal(fixture('returned'), NUMBER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Shipment Delivered' });
    expect(result.events!.map((event) => event.stage)).toEqual(['returned', 'returned', 'returned', 'exception', 'out_for_delivery']);
    expect(result.events![3]!.description).toBe('Refused by the Recipient, Hold for Instructions Requested.');
    expect(result).not.toHaveProperty('delivered_at');
    expect(evidence(result)).not.toMatch(/support@|555|https?:\/\/|SYNTHETIC (?:SENDER|RECEIVER)/);
    const oldestFirst = fixture('returned');
    oldestFirst.data.trackingInfo.reverse();
    expect(parseShipGlobal(oldestFirst, NUMBER).events).toEqual(result.events);
  });

  it('preserves a stated offset and rejects impossible clocks rather than inventing an instant', () => {
    const instant = '2026-02-10T15:20:01-08:00';
    const withOffset = parseShipGlobal(changed((payload) => { payload.data.trackingInfo[0]!.awbHistoryDatetime = instant; }), NUMBER);
    expect(withOffset).toMatchObject({ last_update: instant, delivered_at: instant });
    expect(withOffset.events![0]).toMatchObject({ time: instant });
    expect(withOffset.events![0]).not.toHaveProperty('local_time');
    for (const value of ['2026-02-30 10:00:00', '2026-02-10 24:00:00', '2026-02-10 10:60:00', '2026-02-10 10:00:60',
      '2026-02-10 15:20:01+14:30', '10/02/2026 15:20', 1_770_000_000, {}, []]) {
      expect(() => parseShipGlobal(changed((payload) => { payload.data.trackingInfo[0]!.awbHistoryDatetime = value; }), NUMBER))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('requires the whole returned identity and dated history before accepting a positive', async () => {
    for (const wrong of ['SG32602010000029', `${NUMBER}${'-'.repeat(200)}SECOND17`]) {
      expect(() => parseShipGlobal(changed((payload) => { payload.data.awbInfo.awbNumber = wrong; }), NUMBER))
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    for (const identity of [null, {}, [], 17]) {
      expect(() => parseShipGlobal(changed((payload) => { payload.data.awbInfo.awbNumber = identity; }), NUMBER))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const noHistory = changed((payload) => { payload.data.trackingInfo = []; });
    const undated = changed((payload) => { payload.data.trackingInfo.forEach((row) => { row.awbHistoryDatetime = null; }); });
    for (const body of [noHistory, undated]) {
      expect(() => parseShipGlobal(body, NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
      await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body))).recognize!(NUMBER))
        .rejects.toMatchObject({ name: 'NoHistoryError', kind: 'indeterminate' });
    }
  });

  it('distinguishes the explicit unknown reply from schema changes, upstream failures and HTML blocks', async () => {
    const lookup = (body: unknown, status = 200) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, status))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup({ message: 'OrderId not found', errors: [], data: { awbInfo: {} } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ message: 'Service unavailable', errors: [], data: [] })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup({ message: 'Success', errors: ['SYNTHETIC RECEIVER'], data: [] })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup({ message: 'Success', errors: [], data: null })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({})).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('<html><title>Just a moment</title><script>_cf_chl_opt={}</script></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>ShipGlobal</html>')).rejects.toMatchObject({ kind: 'schema' });
    for (const status of [301, 302, 404, 410]) await expect(lookup('', status)).rejects.toMatchObject({ kind: 'transport' });
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s, with no response or request data in errors or telemetry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered'), status,
        { 'Set-Cookie': 'token=SYNTHETIC_CAPABILITY', 'Retry-After': '30', Location: 'https://example.invalid/handoff?token=SYNTHETIC_CAPABILITY' }));
      const recorder = { step: vi.fn(), lookup: vi.fn() };
      const tracker = new ShipGlobalTracker({ fetcher, recorder });
      const error: unknown = await tracker.fetch(NUMBER).catch((failure: unknown) => failure);
      expect(error).toMatchObject({ kind, status });
      expect(error).toHaveProperty('request', undefined);
      expect(error).toHaveProperty('diagnostics', undefined);
      expect(evidence([error, recorder.step.mock.calls, recorder.lookup.mock.calls])).not.toMatch(PRIVATE);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('drops malformed bodies and unsafe network error causes while retaining recovery provenance', async () => {
    const recorder = { step: vi.fn(), lookup: vi.fn() };
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('SYNTHETIC RECEIVER https://example.invalid/handoff?token=SYNTHETIC_CAPABILITY'))
      .mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(new ShipGlobalTracker({ fetcher, recorder }).fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(recorder.step).toHaveBeenLastCalledWith(expect.objectContaining({ step: 'retry', fallbackFrom: 'direct', fallbackReason: 'transport', outcome: 'ok' }));
    expect(evidence(recorder.step.mock.calls)).not.toMatch(PRIVATE);
    const broken = vi.fn<typeof fetch>().mockResolvedValue(reply('{"awbReceiverName":"SYNTHETIC RECEIVER", "url":"https://example.invalid/handoff?token=SYNTHETIC_CAPABILITY"'));
    const error: unknown = await carrier(broken).track({ number: NUMBER }).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ kind: 'schema' });
    expect(evidence(error)).not.toMatch(PRIVATE);
    expect(broken).toHaveBeenCalledTimes(1);
  });

  it('bounds response bytes, history rows and retained events', async () => {
    const oversized = vi.fn<typeof fetch>().mockResolvedValue(reply('{}', 200, { 'Content-Length': String(SHIPGLOBAL_MAX_BYTES + 1) }));
    await expect(carrier(oversized).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'response_too_large' });
    expect(oversized).toHaveBeenCalledTimes(1);
    expect(() => parseShipGlobal(changed((payload) => { payload.data.trackingInfo = Array.from({ length: 501 }, () => payload.data.trackingInfo[0]!); }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const bounded = parseShipGlobal(changed((payload) => {
      const scan = payload.data.trackingInfo[0]!;
      payload.data.trackingInfo = Array.from({ length: 101 }, (_, index) => ({ ...scan, awbHistoryComment: `Synthetic activity ${index}` }));
    }), NUMBER);
    expect(bounded.events).toHaveLength(100);
    expect(bounded.history_truncated).toBe(true);
  });

  it('recognizes exact dated histories over HTTP, rejects other shapes before a request, and retains the number rule', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered'))).mockResolvedValueOnce(reply(fixture('not-found')));
    const current = carrier(fetcher);
    await expect(current.recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-02-10T15:20:01' });
    await expect(current.recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(current.recognize!('ABC123')).resolves.toEqual({ known: false });
    await expect(current.track({ number: 'ABC123' })).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(current.track({ number: NUMBER }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(normalizeShipGlobalNumber('sg3 2602010000017')).toBe(NUMBER);
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['shipglobal-in'] });
  });

  it('offers the unchanged number rule to HTTP preflight and routes its confirmation to native history', async () => {
    expect(recognitionCandidates(NUMBER).map((candidate) => candidate.carrier)).toContain('shipglobal-in');
    expect(recognitionCandidates(NUMBER, { phase: 'browser' }).map((candidate) => candidate.carrier)).not.toContain('shipglobal-in');
    // Fresh synthetic activity keeps preflight's reused-number age guard in scope.
    const recent = changed((payload) => {
      payload.data.trackingInfo[0]!.awbHistoryDatetime = new Date(Date.now() - 3_600_000).toISOString().slice(0, 19);
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(recent));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    const answer = await tracker.track({ number: NUMBER }, { budgetMs: 3_000 });
    expect(answer).toMatchObject({ carrier: 'shipglobal-in', source: 'shipglobal-in', result: { current_stage: 'delivered' } });
    expect(answer.attempts[0]).toMatchObject({ source: 'shipglobal-in', kind: 'ok' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([url]) => String(url) === shipGlobalLookupUrl(NUMBER))).toBe(true);
  });

  it('routes an explicitly selected older parcel to the native adapter with providers disabled', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: NUMBER, carrier: 'shipglobal-in' }, { budgetMs: 3_000 }))
      .resolves.toMatchObject({ carrier: 'shipglobal-in', source: 'shipglobal-in', result: { current_stage: 'delivered' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retries only a network failure and ends both hanging attempts within the lookup budget', async () => {
    fakeBudgetClock();
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: 50, reply: () => reply(fixture('delivered')) }]);
    const answer = carrier(recovered.fetcher).track({ number: NUMBER }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answer).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(recovered.ended).toEqual([200, 250]);
    const began = performance.now();
    const hanging = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(hanging.fetcher).track({ number: NUMBER }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(hanging.fetcher).toHaveBeenCalledTimes(2);
    expect(hanging.ended.map((at) => at - began)).toEqual([60, 120]);
  });
});

describe('ShipGlobal India status vocabulary', () => {
  it('maps recorded codes and wordings and leaves unknown activity open', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: Stage }[]) {
      expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(shipGlobalStage(entry.code ?? '', entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(shipGlobalMappedStage('0', 'Synthetic activity')).toBeUndefined();
    expect(shipGlobalStage('', 'Synthetic activity')).toBeNull();
    expect(shipGlobalWording('Delivered. Signed by SYNTHETIC RECEIVER')).toBe('Delivered');
    expect(shipGlobalWording('Shipment Delivered | https://example.invalid/handoff?token=SYNTHETIC_CAPABILITY')).toBe('Shipment Delivered');
  });
});
