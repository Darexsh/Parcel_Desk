import { afterEach, describe, expect, it, vi } from 'vitest';
import { fillPartialAnswer, isPartialAnswer } from '../../core/result/partial.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, InpostTracker } from './adapter.js';
import { parseInpostShipxSummary } from './shipx.js';

const NUMBER = '640000000000000000000001';
const CLOCK = '2026-05-04T10:00:00.000+02:00';
const EXPECTED_CLOCK = '2026-05-04T10:00:00+02:00';
function shipx(overrides: Record<string, unknown> = {}) {
  return {
    tracking_number: NUMBER, service: 'inpost_courier_standard', status: 'returned_to_sender',
    updated_at: '2026-05-04T12:00:00+02:00',
    tracking_details: [
      { status: 'returned_to_sender', datetime: CLOCK, agency: 'PRIVATE_BRANCH', location: 'PRIVATE_LOCATION' },
      { status: 'pickup_reminder_sent_address', datetime: '2026-05-04T08:00:00+02:00' },
    ],
    receiver: { name: 'PRIVATE_RECIPIENT', phone: 'PRIVATE_PHONE', address: 'PRIVATE_ADDRESS' },
    custom_attributes: { target_machine_detail: { name: 'PLANNED_LOCKER' } },
    expected_flow: [{ status: 'delivered', datetime: '2026-05-05T10:00:00+02:00' }],
    ...overrides,
  };
}
function problem(number = NUMBER) {
  return { type: '/errors/external/tracking-error', title: 'Inpost error response', status: 500,
    instance: `/api/tracking/${number}` };
}
function response(value: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json', ...headers },
  });
}
afterEach(() => { vi.restoreAllMocks(); });

describe('InPost ShipX current status', () => {
  it('keeps the explicitly dated current status without importing another feed\'s history or private fields', () => {
    const result = parseInpostShipxSummary(shipx(), NUMBER);
    expect(result).toEqual({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      provider_code: 'returned_to_sender', last_status_text: 'Returning to the sender', last_update: EXPECTED_CLOCK,
      expected_delivery: null, summary_only: true, events: [] });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|PLANNED_|2026-05-05|12:00:00/);
  });

  it.each([
    ['ready_to_pickup', 'out_for_delivery', 'ready_for_pickup'], ['delivered', 'delivered', 'delivered'],
    ['pickup_reminder_sent_address', 'exception', 'failed_attempt'], ['rejected_by_receiver', 'exception', 'failed_attempt'],
  ])('classifies %s from the official meaning', (code, status, stage) => {
    const result = parseInpostShipxSummary(shipx({ status: code, tracking_details: [{ status: code, datetime: CLOCK }] }), NUMBER);
    expect(result).toMatchObject({ status, current_stage: stage, last_update: EXPECTED_CLOCK });
    if (code === 'delivered') expect(result?.delivered_at).toBe(EXPECTED_CLOCK);
    else expect(result).not.toHaveProperty('delivered_at');
  });

  it.each([null, {}, shipx({ tracking_number: '640000000000000000000002' }), shipx({ tracking_number: `X${NUMBER}` })])('requires the whole identifier (%j)', payload => {
      expect(() => parseInpostShipxSummary(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    });

  it.each([
    { service: 'other_courier_standard' }, { service: 'inpost_unknown' },
    { status: 'new_status' }, { status: '__proto__' },
    { tracking_details: [] }, { tracking_details: null },
    { tracking_details: [{ status: 'delivered', datetime: CLOCK }] },
    { tracking_details: [{ status: 'returned_to_sender', datetime: '2026-05-04T10:00:00' }] },
    { tracking_details: [{ status: 'returned_to_sender', datetime: '2026-05-04T25:00:00+02:00' }] },
    { tracking_details: [{ status: 'returned_to_sender', datetime: CLOCK }, { status: 'delivered', datetime: '2026-05-05T10:00:00+02:00' }] },
    { tracking_details: Array.from({ length: 501 }, () => ({ status: 'returned_to_sender', datetime: CLOCK })) },
  ])('leaves unsupported or inconsistent state inconclusive (%j)', overrides => {
    expect(parseInpostShipxSummary(shipx(overrides), NUMBER)).toBeNull();
  });

  it('keeps fuller history eligible but prevents a stale provider answer from undoing an official return', () => {
    const returned = parseInpostShipxSummary(shipx(), NUMBER)!;
    expect(isPartialAnswer(returned)).toBe(true);
    const stale = { status: 'in_transit' as const, current_stage: 'in_transit' as const, last_update: CLOCK,
      events: [{ time: CLOCK, description: 'Moving', stage: 'in_transit' as const }] };
    expect(fillPartialAnswer('inpost', NUMBER, returned, stale)).toBeNull();
    const fuller = { ...stale, status: 'exception' as const, current_stage: 'returned' as const,
      events: [{ time: CLOCK, description: 'Returning', stage: 'returned' as const }, ...stale.events] };
    expect(fillPartialAnswer('inpost', NUMBER, returned, fuller)?.events).toEqual(fuller.events);
  });
});

describe('InPost ShipX recovery', () => {
  it('recovers only after a matching structured hub failure and records both steps and their provenance', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(problem(), 500)).mockResolvedValueOnce(response(shipx()));
    const recorder = { step: vi.fn(), lookup: vi.fn() };
    const result = await new InpostTracker({ fetcher, recorder }).fetch(NUMBER);
    expect(result.current_stage).toBe('returned');
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `https://inposteasy.com/api/tracking/${NUMBER}?language=en`, `https://api-shipx-pl.easypack24.net/v1/tracking/${NUMBER}`,
    ]);
    expect(recorder.step.mock.calls.map(([record]) => [record.step, record.outcome, record.fallbackFrom])).toEqual([
      ['direct', 'indeterminate', null], ['shipx', 'ok', 'direct'],
    ]);
    expect(recorder.step.mock.calls[1]?.[0]).toMatchObject({ fallbackReason: 'indeterminate', fallbackErrorType: 'UpstreamHttpError' });
    expect(recorder.lookup).toHaveBeenCalledWith(expect.objectContaining({ finalStep: 'shipx', outcome: 'ok', attempts: 2 }));
  });

  it.each([
    [500, {}], [500, '<html>Unavailable</html>'], [500, problem('640000000000000000000002')],
    [500, { ...problem(), status: 404 }], [500, { ...problem(), type: '/errors/internal' }],
    [403, problem()], [429, problem()],
    [404, { type: '/errors/external/not-found', title: 'NOT_FOUND', status: 404, instance: `/api/tracking/${NUMBER}` }],
  ])('never starts ShipX after an unrelated HTTP %s reply (%j)', async (status, body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(body, status));
    await expect(new InpostTracker({ fetcher }).fetch(NUMBER)).rejects.toBeDefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('honors a hub retry window rather than immediately starting the fallback', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(problem(), 500, { 'Retry-After': '120' }));
    await expect(new InpostTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ status: 500, retryAfterMs: 120_000 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([404, 'unsupported'])('preserves the hub error when ShipX has narrower coverage (%s)', async outcome => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(problem(), 500))
      .mockResolvedValueOnce(outcome === 404 ? response({}, 404) : response(shipx({ service: 'other_courier_standard' })));
    await expect(new InpostTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ status: 500, provider: 'InPost tracking', kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([403, 429])('preserves a ShipX HTTP %s failure kind and recovery provenance', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(problem(), 500))
      .mockResolvedValueOnce(response({}, status, { 'Retry-After': '60' }));
    const recorder = { step: vi.fn(), lookup: vi.fn() };
    await expect(new InpostTracker({ fetcher, recorder }).fetch(NUMBER)).rejects.toMatchObject({ status,
      kind: status === 403 ? 'challenge' : 'rate_limited', retryAfterMs: 60_000 });
    expect(recorder.step.mock.calls[1]?.[0]).toMatchObject({ step: 'shipx', fallbackFrom: 'direct', fallbackErrorType: 'UpstreamHttpError' });
  });

  it('keeps recognition on the hub alone', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(problem(), 500));
    const instance = adapter({ fetcher, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null, env: {} });
    await expect(instance.recognize!(NUMBER)).rejects.toMatchObject({ status: 500, kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(instance.steps).toEqual(['direct', 'shipx']);
    expect(instance.recordsSteps).toBe(true);
  });

  it('does not call the narrower Polish endpoint for a UK identifier', async () => {
    const number = '8YDR000000001';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(problem(number), 500));
    await expect(new InpostTracker({ fetcher }).fetch(number)).rejects.toMatchObject({ status: 500 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('starts no fallback when the caller cancels after the hub failure', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort();
      return response(problem(), 500);
    });
    await expect(new InpostTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toBeDefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('passes the remaining lookup budget and cancellation to the fallback', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
      now = 80;
      return response(problem(), 500);
    }).mockImplementationOnce(async (_url, init) => {
      expect(init?.signal?.aborted).toBe(false);
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      throw controller.signal.reason;
    });
    const recorder = { step: vi.fn(), lookup: vi.fn() };
    await expect(new InpostTracker({ fetcher, recorder }).fetch(NUMBER, { budgetMs: 100, signal: controller.signal })).rejects.toBeDefined();
    const failure = recorder.step.mock.calls[1]?.[0];
    expect(failure).toMatchObject({ step: 'shipx', error: { request: { timeout_ms: 20 } } });
  });

  it('does not start a fallback after the shared budget expires', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      now = 100;
      return response(problem(), 500);
    });
    await expect(new InpostTracker({ fetcher }).fetch(NUMBER, { budgetMs: 100 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
