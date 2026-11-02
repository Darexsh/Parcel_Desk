import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { UpstreamNetworkError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, COLLIVERY_TRACKING, ColliveryTracker } from './adapter.js';
import { colliveryWording, normalizeColliveryNumber, parseCollivery } from './parser.js';
import { colliveryStage, colliveryStatusStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '900000001';
const IN_TRANSIT = '900000002';
const UNKNOWN = '900000003';

type Row = Record<string, unknown>;
type Waybill = Row & { status: Row; history: Row[] };
type Reply = Row & { data: Waybill };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (data: Waybill, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const answering = (body: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => body());
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const NOT_FOUND = () => reply(readFileSync(new URL('./fixtures/not-found.json', import.meta.url), 'utf8'), { status: 404 });
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('MDS Collivery HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole waybill once, through the supplied transport', async () => {
    const fetcher = answering(() => reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ColliveryTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 900 000 002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${COLLIVERY_TRACKING}${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'mds-collivery', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a completed booking newest first at South African time, from its current status, without the addresses', async () => {
    const result = await carrier(answering(() => reply(fixture('delivered')))).track({ number: DELIVERED });
    // The history has no delivery line; the page's current status completes the booking.
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Completed', last_update: '2026-03-06T20:00:01+02:00', expected_delivery: null,
    });
    expect(result.events!.map((event) => [event.time, event.description, event.location ?? null, event.stage ?? null])).toEqual([
      ['2026-03-06T20:00:01+02:00', 'Collivery invoiced', null, null],
      ['2026-03-04T07:10:30+02:00', 'Driver assigned to deliver your parcel', null, 'in_transit'],
      ['2026-03-03T18:02:11+02:00', 'Received in Otherton branch', 'Otherton', 'in_transit'],
      ['2026-03-03T13:20:45+02:00', 'The delivery attempt of your parcel failed because Contact not available', null, 'failed_attempt'],
      // Rows of the same second keep the page's order, newest last.
      ['2026-03-03T06:31:02+02:00', 'Driver assigned to deliver your parcel', null, 'in_transit'],
      ['2026-03-03T06:31:02+02:00', 'Received in Otherton branch', 'Otherton', 'in_transit'],
      ['2026-03-02T19:05:48+02:00', 'En route to destination', null, 'in_transit'],
      ['2026-03-02T17:42:31+02:00', 'Parcel details updated', null, null],
      ['2026-03-02T17:42:10+02:00', 'Received in Sampleton branch', 'Sampleton', 'in_transit'],
      ['2026-03-02T08:15:00+02:00', 'Collivery loaded on system', null, 'registered'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && (!event.stage || event.stage_source === 'carrier_map'))).toBe(true);
    // The addresses, the support links and the status sentence are not kept.
    expect(JSON.stringify(result)).not.toMatch(/Sample Person|Example|wa\.me|svg|is in status/);
    expect(result).not.toHaveProperty('history_truncated');
    expect(result).not.toHaveProperty('summary_only');
  });

  it('takes the current status over a history that leaves the step out, and the scans when the status moves nothing', () => {
    const result = parseCollivery(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'Delivery Driver Dispatched', last_update: '2026-07-14T05:55:41+02:00' });
    expect(result.events![0]).toEqual({ time: '2026-07-14T05:55:41+02:00', description: 'Driver assigned to deliver your parcel', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(result.events![1]).toEqual({ time: '2026-07-14T05:55:41+02:00', description: 'Received in branch', stage: 'in_transit', stage_source: 'carrier_map' });
    const modified = parseCollivery(changed('in-transit', (data) => { data.status.text = 'Collivery Modified'; }), IN_TRANSIT);
    expect(modified).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Collivery Modified' });
    const cancelled = parseCollivery(changed('in-transit', (data) => {
      data.status = { processed: false, secondaryProcessed: false, dispatched: false, inTransit: false, completed: false, text: 'Collivery Cancelled' };
      data.history = [{ time: 1783926120, index: 0, type: 'status', text: 'Collivery cancelled' }];
    }), IN_TRANSIT);
    expect(cancelled).toMatchObject({ status: 'exception', current_stage: 'exception', events: [{ description: 'Collivery cancelled', stage: 'exception' }] });
  });

  it('reads a booking without a history as its current status alone', () => {
    const result = parseCollivery(changed('in-transit', (data) => {
      data.status.text = 'Waiting Client Acceptance';
      data.history = [];
    }), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'Waiting Client Acceptance',
      last_update: null, summary_only: true, events: [] });
  });

  it('takes the name of whoever took the parcel and phone numbers out of a line, and leaves a line the map lacks to the shared rules', () => {
    const result = parseCollivery(changed('in-transit', (data) => {
      data.status.text = 'Invoiced';
      data.history.push({ time: 1784030000, index: 5, type: 'status', text: 'Parcel delivered, signed by Sample Person 082 000 0000' });
    }), IN_TRANSIT);
    expect(result).toMatchObject({ current_stage: 'delivered', current_stage_source: expect.stringMatching(/^wording:/) });
    expect(result.events![0]).toMatchObject({ description: 'Parcel delivered', stage: 'delivered' });
    expect(JSON.stringify(result)).not.toMatch(/Sample Person|082/);
    expect(colliveryWording('Call 012 345 6789 to rebook')).toBe('Call to rebook');
  });

  it('reads the lookup’s 404 for a waybill Collivery has no record of as not found, and another 404 or a redirect as a moved route', async () => {
    const lookup = (answer: () => Response) => carrier(answering(answer)).track({ number: UNKNOWN });
    await expect(lookup(NOT_FOUND)).rejects.toMatchObject({ kind: 'not_found' });
    // A missing route answers 404 with an empty message, and without JSON asked, the site's HTML page.
    await expect(lookup(() => reply({ message: '' }, { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('<!DOCTYPE html><html><body>Page not found</body></html>', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 410 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 302, headers: { Location: '/login' } }))).rejects.toMatchObject({ kind: 'transport' });
  });

  it('refuses a reply for another waybill or without one', () => {
    expect(() => parseCollivery(fixture('delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCollivery(changed('delivered', (data) => { data.waybill = 9000000010; }), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCollivery(changed('delivered', (data) => { delete data.waybill; }), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseCollivery(changed('delivered', (data) => { data.waybill = DELIVERED; }), DELIVERED)).toMatchObject({ current_stage: 'delivered' });
  });

  it('refuses a changed reply and reads a bot check as a challenge', () => {
    for (const body of [
      { data: null },
      { message: 'Server Error' },
      changed('delivered', (data) => { delete (data as Row).status; }),
      changed('delivered', (data) => { data.status.text = null; }),
      changed('delivered', (data) => { (data as Row).history = { 0: data.history[0] }; }),
      changed('delivered', (data) => { data.history[0]!.time = '2026-03-02 08:15'; }),
      changed('delivered', (data) => { data.history[0]!.time = 1772432100.5; }),
      changed('delivered', (data) => { data.history[0]!.time = 0; }),
      changed('delivered', (data) => { data.history[0]!.text = ''; }),
      changed('delivered', (data) => { data.history[0]!.text = 7; }),
      changed('delivered', (data) => { delete data.history[0]!.type; }),
      changed('delivered', (data) => { data.history[0] = 'Collivery loaded on system' as unknown as Row; }),
      changed('delivered', (data) => { data.history = Array.from({ length: 501 }, () => data.history[0]!); }),
    ]) expect(() => parseCollivery(body, DELIVERED), JSON.stringify(body).slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCollivery(changed('delivered', (data) => { data.status.text = ''; data.history = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('keeps blocks, rate limits, server errors and malformed replies apart from a missing parcel', async () => {
    const lookup = (answer: () => Response) => carrier(answering(answer)).track({ number: DELIVERED });
    await expect(lookup(() => reply(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply('Forbidden', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply('Too Many Attempts.', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup(() => reply('<html><body>Server Error</body></html>', { status: 500 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(() => reply('', { status: 503 }))).rejects.toMatchObject({ kind: 'maintenance' });
    await expect(lookup(() => reply('<html><body>Tracking</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('asks once more when Collivery cannot be reached, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new ColliveryTracker({ fetcher: flaky, recorder }).fetch(IN_TRANSIT, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(failing).track({ number: IN_TRANSIT }, { budgetMs: 2000 })).rejects.toBeInstanceOf(UpstreamNetworkError);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects what is not a waybill, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '12345', '1234567890', '0900000002', 'ZZ0000001', '900000002A', '9'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeColliveryNumber('900-000-002')).toBe(IN_TRANSIT);
  });

  it('recognizes a known waybill and the unknown-waybill answer, and asks nothing for what is not a waybill', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => String(input).endsWith(UNKNOWN) ? NOT_FOUND() : reply(fixture('delivered')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toMatchObject({ known: true });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('0012')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(carrier(answering(() => reply(CHALLENGE))).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('answers a waybill filed under Collivery or opened from its tracker’s address', async () => {
    const fetcher = answering(() => reply(fixture('in-transit')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: IN_TRANSIT, carrier: 'mds-collivery' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'mds-collivery', source: 'mds-collivery', result: { current_stage: 'out_for_delivery' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(COLLIVERY_TRACKING))).toBe(true);
    expect(parseTrackingInput(`https://collivery.net/tracking?waybill=${IN_TRANSIT}`)).toMatchObject({ trackingNumber: IN_TRANSIT, carrier: 'mds-collivery' });
  });
});

describe('MDS Collivery status vocabulary', () => {
  it('records every status and line seen with the stage the map gives it', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      // Coded entries are the API's status names, which the page gives as the current status; the rest are history lines.
      if (entry.code) expect(colliveryStatusStage(entry.wording), `${entry.code} ${entry.wording}`).toBe(entry.stage);
      else expect(colliveryStage(entry.wording), entry.wording).toEqual(entry.stage ? { stage: entry.stage, source: 'carrier_map' } : null);
    }
    expect(statusMapAnswer({ carrier: 'mds-collivery', providerCode: null, description: 'Received in Sampleton branch' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'mds-collivery', providerCode: null, description: 'Collivery invoiced' })).toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'mds-collivery', providerCode: null, description: 'Xyzzy' })).toEqual({ kind: 'unknown' });
    expect(statusMap.gaps.map((gap) => gap.wording)).toEqual(['parcel details updated', 'collivery invoiced']);
  });
});
