import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, FARGO_UZ_API, FargoUzTracker, fargoUzLookupUrl } from './adapter.js';
import { normalizeFargoUzNumber, parseFargoUz } from './parser.js';
import { fargoUzMappedStage, fargoUzStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'TEZ123457';
const IN_TRANSIT = 'TEZ1234567';
const UNKNOWN = 'TEZ000000';

type Row = Record<string, unknown>;
type Reply = { status: string; data: { total: number; list: Row[] } };
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string): Reply => JSON.parse(text(name)) as Reply;
const edited = (name: string, change: (payload: Reply) => void): Reply => {
  const payload = fixture(name);
  change(payload);
  return payload;
};
const reply = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'application/json', ...headers } });
const page = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const ROUTE_GONE = '<!doctype html><html lang="en"><head><title>Not Found</title></head><body><h1>Not Found</h1></body></html>';

describe('Fargo tracking adapter', () => {
  it('asks the tracker for the whole track ID once, as its page does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new FargoUzTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' tez 123-457 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${FARGO_UZ_API}${DELIVERED}/history_items`);
    expect(fargoUzLookupUrl(DELIVERED)).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'fargo-uz', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery after a failed attempt newest first, with Tashkent instants, facilities and codes', () => {
    const result = parseFargoUz(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Order completed', last_update: '2026-05-06T15:20:30+05:00', delivered_at: '2026-05-06T15:20:30+05:00',
      expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.location ?? null, event.description, event.provider_code, event.stage ?? null])).toEqual([
      ['2026-05-06T15:20:30+05:00', null, 'Order completed', 'completed', 'delivered'],
      ['2026-05-06T15:20:30+05:00', null, 'Second delivery attempt', 'second_delivery_attempt', 'out_for_delivery'],
      ['2026-05-06T14:15:00+05:00', null, 'Recipient does not respond', 'recipient_mobile_no_response', 'failed_attempt'],
      ['2026-05-06T14:15:00+05:00', null, 'First delivery attempt', 'first_delivery_attempt', 'out_for_delivery'],
      ['2026-05-06T09:30:00+05:00', null, 'Dispatched', 'dispatched', 'in_transit'],
      ['2026-05-06T09:10:00+05:00', '000 · Namuna (Sinov bozori) bo\'limi · Namuna', 'In sorting facility', 'in_sorting_facility', 'in_transit'],
      ['2026-05-05T22:00:00+05:00', null, 'Order is waiting to be assigned to a courier', 'unassigned', 'registered'],
      ['2026-05-05T22:00:00+05:00', null, 'Order created', 'created', 'registered'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result).not.toHaveProperty('history_truncated');
    // The courier is not kept.
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE COURIER|"driver"|123456789/);
  });

  it('reads an order between warehouses as in transit, passing over a bare update as the page does', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('in-transit')));
    const result = await carrier(fetcher).track({ number: IN_TRANSIT });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'In sorting facility', last_update: '2026-05-08T13:00:00+05:00', expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events![0]).toEqual({ time: '2026-05-08T13:00:00+05:00', description: 'Status updated', provider_code: 'update' });
    expect(result.events![1]).toMatchObject({ location: '000 · Sinov saralash markazi · Sinov', provider_code: 'in_sorting_facility', stage: 'in_transit' });
  });

  it('sorts items by their instant, keeps the reply\'s order at the same instant and lists a repeated item once', () => {
    const payload = edited('delivered', (reply) => {
      const list = reply.data.list;
      reply.data.list = [list[4]!, list[0]!, list[1]!, list[0]!, ...list.slice(2, 4), ...list.slice(5)];
    });
    const codes = parseFargoUz(payload, DELIVERED).events!.map((event) => event.provider_code);
    expect(codes).toEqual(['completed', 'second_delivery_attempt', 'recipient_mobile_no_response', 'first_delivery_attempt',
      'dispatched', 'in_sorting_facility', 'unassigned', 'created']);
  });

  it('keeps an explicit offset as its instant and marks a history shorter than its total', () => {
    const payload = edited('in-transit', (reply) => {
      reply.data.list[1]!.date = '2026-05-08T10:45:00+03:00';
      reply.data.total = 7;
    });
    const result = parseFargoUz(payload, IN_TRANSIT);
    expect(result.events![0]).toMatchObject({ time: '2026-05-08T13:00:00+05:00', provider_code: 'update' });
    expect(result.events![1]).toMatchObject({ time: '2026-05-08T12:45:00+05:00', provider_code: 'in_sorting_facility' });
    expect(result.history_truncated).toBe(true);
  });

  it('names an unknown code by its own words and stages it by the shared wording rules', () => {
    const payload = edited('in-transit', (reply) => {
      reply.data.list.unshift({ id: 7, status: 'sample_new_code', date: '2026-05-08T09:00:00.000Z' });
    });
    expect(parseFargoUz(payload, IN_TRANSIT).events![0]).toEqual({ time: '2026-05-08T14:00:00+05:00',
      description: 'sample new code', provider_code: 'sample_new_code' });
    expect(fargoUzStage('sample_new_code', 'Delivered to the recipient')).toMatchObject({ stage: 'delivered' });
    expect(fargoUzStage('cod_transferred', 'COD transferred')).toBeNull();
  });

  it('reads the tracker\'s order_not_found reply as not found, and a bare 404 or a redirect as a moved route', async () => {
    const lookup = (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response())).track({ number: UNKNOWN });
    await expect(lookup(() => reply(text('not-found'), 404))).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseFargoUz(JSON.parse(text('not-found')), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(lookup(() => page(ROUTE_GONE, 404))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(() => reply('{"detail":"Not found."}', 404))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(() => page('', 302))).rejects.toMatchObject({ kind: 'transport', status: 302 });
    await expect(lookup(() => page('', 410))).rejects.toMatchObject({ kind: 'transport', status: 410 });
  });

  it('reads a browser check, even with HTTP 200, or a refusal as a challenge', async () => {
    const lookup = (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response())).track({ number: DELIVERED });
    await expect(lookup(() => page(CHECK))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => page(CHECK, 403))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(() => reply('{"detail":"Forbidden"}', 403))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
  });

  it('keeps the wait a rate limit names, in its header or its reply', async () => {
    const lookup = (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response())).track({ number: DELIVERED });
    await expect(lookup(() => reply('', 429, { 'Retry-After': '30' }))).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(lookup(() => reply('{"detail":"Request was throttled. Expected available in 42 seconds."}', 429)))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 42_000 });
    await expect(lookup(() => reply('', 429))).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('reads a malformed or changed reply as a schema error and an order without items as no history', async () => {
    const parse = (payload: unknown) => () => parseFargoUz(payload, DELIVERED);
    const schema = expect.objectContaining({ kind: 'schema' });
    expect(parse(null)).toThrow(schema);
    expect(parse({ status: 'error', code: 'sample_error' })).toThrow(schema);
    expect(parse({ status: 'success', data: null })).toThrow(schema);
    expect(parse({ status: 'success', data: { total: 1, list: {} } })).toThrow(schema);
    expect(parse(edited('delivered', (reply) => { reply.data.list[0]!.status = null; }))).toThrow(schema);
    expect(parse(edited('delivered', (reply) => { reply.data.list[0]!.status = 'Order completed'; }))).toThrow(schema);
    expect(parse(edited('delivered', (reply) => { reply.data.list[0]!.date = '2026-05-06 10:20:30'; }))).toThrow(schema);
    expect(parse(edited('delivered', (reply) => { reply.data.list[0]!.date = '2026-02-30T10:20:30.000Z'; }))).toThrow(schema);
    expect(parse(edited('delivered', (reply) => { reply.data.list[0]!.status_desc = { en: 'Order completed' }; }))).toThrow(schema);
    expect(parse(edited('delivered', (reply) => { reply.data.list[5]!.warehouse = 'Namuna'; }))).toThrow(schema);
    expect(parse({ status: 'success', data: { total: 501, list: Array.from({ length: 501 }, () => ({})) } })).toThrow(schema);
    expect(parse({ status: 'success', data: { total: 0, list: [] } })).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(page('<html><body>Sample maintenance page</body></html>')))
      .track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    await expect(carrier(vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind });
  });

  it('sends only a whole track ID: shop order numbers, partial IDs and other layouts go nowhere', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['TEZ12345', 'TEZ12345678901', 'TEZ123456A', 'TE123456', 'XTEZ123456', '123456', '123456789',
      '12345678901234', 'TEZ123456,TEZ000000', 'TEZ123456/history_items', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeFargoUzNumber(' tez-123 457 ')).toBe(DELIVERED);
    expect(normalizeFargoUzNumber('tez1234567')).toBe(IN_TRANSIT);
    expect(normalizeFargoUzNumber('TEZ1234567890')).toBe('TEZ1234567890');
  });

  it('retries a read that fails to reach the tracker', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(text('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new FargoUzTracker({ fetcher, recorder }).fetch(IN_TRANSIT)).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
  });

  it('tries a read that hangs once more, inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('recognizes an order the tracker has, and not an ID it lacks or one it does not issue', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')))).recognize!(DELIVERED))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-05-06T10:20:30.000Z' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(text('not-found'), 404))).recognize!(UNKNOWN))
      .resolves.toEqual({ known: false });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('123456789')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(page(CHECK))).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('routes an ID filed under Fargo to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'fargo-uz' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'fargo-uz', source: 'fargo-uz', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === fargoUzLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('Fargo status vocabulary', () => {
  type Entry = { code: string; wording?: string; stage?: string };

  it('records every code with the stage the map gives, or none on purpose', () => {
    for (const entry of statuses.entries as Entry[]) {
      const description = entry.wording ?? entry.code;
      const answer = statusMapAnswer({ carrier: 'fargo-uz', providerCode: entry.code, description });
      if (entry.stage) {
        expect(answer, entry.code).toEqual({ kind: 'mapped', stage: entry.stage });
        expect(fargoUzStage(entry.code, description), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
      } else {
        expect(answer, entry.code).toMatchObject({ kind: 'intentional_gap' });
        expect(fargoUzStage(entry.code, description), entry.code).toBeNull();
      }
    }
  });

  it('leaves no code both mapped and a gap', () => {
    for (const gap of statusMap.gaps) expect(fargoUzMappedStage(gap.code!), gap.code).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'fargo-uz', providerCode: 'sample_code', description: 'sample' })).toEqual({ kind: 'unknown' });
  });
});
