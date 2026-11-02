import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { UpstreamNetworkError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TWO_GO_API, TwoGoTracker } from './adapter.js';
import { normalizeTwoGoNumber, parseTwoGo, twoGoWording } from './parser.js';
import { statusMap, twoGoStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'A0000001B';
const IN_TRANSIT = 'A0000002B';
const UNKNOWN = 'A0000003B';
const REFERENCE = 'AA0000004';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string): unknown => JSON.parse(text(name));
const reply = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const answering = (body: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => body());
// The tracker's replies by the number asked, as its API answers them.
const tracker = (replies: Readonly<Record<string, () => Response>>) => vi.fn<typeof fetch>().mockImplementation(async (url) => {
  const number = decodeURIComponent(String(url).slice(TWO_GO_API.length));
  return (replies[number] ?? (() => reply(text('not-found'), { status: 404 })))();
});
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const scan = (status: string, timestamp: string, number = DELIVERED) => ({ trackingNumber: number, status, timestamp });

describe('2GO Express HTTP adapter', () => {
  it('asks the tracker’s lookup for the whole number in capitals, once, through the supplied transport', async () => {
    const fetcher = answering(() => reply(text('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TwoGoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' a000-0002 b ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${TWO_GO_API}${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: '2go', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered parcel newest first on its wall clocks, with the hub an arrival names', () => {
    const result = parseTwoGo(fixture('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Parcel has been delivered', last_update: null, last_update_local: '2026-04-04T14:22:31',
      expected_delivery: null,
      events: [
        { local_time: '2026-04-04T14:22:31', description: 'Parcel has been delivered', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-04-04T08:30:00', description: 'Parcel is out for delivery', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2026-04-04T06:05:48', location: 'SAMPLETOWN HUB', description: 'Parcel has arrived at SAMPLETOWN HUB', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-04-02T17:40:12', location: 'SAMPLE HUB', description: 'Parcel has arrived at SAMPLE HUB', stage: 'in_transit', stage_source: 'carrier_map' },
        // Microseconds go; the clock keeps its second.
        { local_time: '2026-04-02T09:14:05', description: 'Order is placed', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
  });

  it('reads a parcel on its way once per repeated scan, and takes the newest scan of one second last in the list', async () => {
    const result = await carrier(answering(() => reply(text('in-transit')))).track({ number: IN_TRANSIT });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Parcel has arrived at SAMPLE HUB',
      last_update: null, last_update_local: '2026-05-12T10:11:09' });
    expect(result.events!.map((event) => event.description)).toEqual(['Parcel has arrived at SAMPLE HUB', 'Order is placed']);
    expect(result).not.toHaveProperty('canonical_tracking_number');
    // A bare list of scans, which the page also reads, is the same history.
    expect(parseTwoGo((fixture('in-transit') as { history: unknown[] }).history, IN_TRANSIT).events).toEqual(result.events);
    const same = parseTwoGo({ history: [scan('Order is placed', '2026-05-11 20:00:00'), scan('Parcel has arrived at SAMPLE HUB', '2026-05-11 20:00:00')] }, DELIVERED);
    expect(same.events!.map((event) => event.description)).toEqual(['Parcel has arrived at SAMPLE HUB', 'Order is placed']);
  });

  it('follows a reference to the shipment that lists it whole, as the page does', async () => {
    const fetcher = tracker({ [REFERENCE]: () => reply(text('redirect')), [IN_TRANSIT]: () => reply(text('in-transit')) });
    const result = await carrier(fetcher).track({ number: REFERENCE.toLowerCase() });
    expect(result).toMatchObject({ current_stage: 'in_transit', canonical_tracking_number: IN_TRANSIT });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([`${TWO_GO_API}${REFERENCE}`, `${TWO_GO_API}${IN_TRANSIT}`]);
    expect(fetcher.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true);
  });

  it('refuses a redirect to a shipment that does not list the number whole, or that goes round', async () => {
    const lookup = (replies: Readonly<Record<string, () => Response>>, number = REFERENCE) => carrier(tracker(replies)).track({ number });
    const listing = (attachment: unknown) => () => reply(JSON.stringify({ ...(fixture('in-transit') as object), attachment }));
    for (const attachment of ['SAMPLE-REF-01', 'AA00000040', 'XAA0000004 / SAMPLE', 'AA000000', 'NO_ATTACHMENT', '', null]) {
      await expect(lookup({ [REFERENCE]: () => reply(text('redirect')), [IN_TRANSIT]: listing(attachment) }), String(attachment))
        .rejects.toMatchObject({ kind: 'indeterminate' });
    }
    await expect(lookup({ [REFERENCE]: () => reply(text('redirect')), [IN_TRANSIT]: listing(' aa0000004 ') })).resolves.toMatchObject({ canonical_tracking_number: IN_TRANSIT });
    await expect(lookup({ [REFERENCE]: () => reply(text('redirect')), [IN_TRANSIT]: listing(42) })).rejects.toMatchObject({ kind: 'schema' });
    // The shipment it names is gone.
    await expect(lookup({ [REFERENCE]: () => reply(text('redirect')) })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup({ [REFERENCE]: () => reply(JSON.stringify({ redirect: true, trackingNumber: REFERENCE })) })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ [REFERENCE]: () => reply(text('redirect')), [IN_TRANSIT]: () => reply(JSON.stringify({ redirect: true, trackingNumber: DELIVERED })) }))
      .rejects.toMatchObject({ kind: 'schema' });
    for (const target of [undefined, '', 'A0', 'A000/0002B', 12]) {
      await expect(lookup({ [REFERENCE]: () => reply(JSON.stringify({ redirect: true, trackingNumber: target })) }), String(target))
        .rejects.toMatchObject({ kind: 'schema' });
    }
  });

  it('reads the tracker’s own 404 answer as not found, and a recognition of it as unknown', async () => {
    await expect(carrier(tracker({})).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseTwoGo(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(tracker({})).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(tracker({ [DELIVERED]: () => reply(text('delivered')) })).recognize!(DELIVERED)).resolves.toMatchObject({ known: true });
    // A shape 2GO does not issue is unknown without a request.
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('A00000001B')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses a history for another shipment', () => {
    expect(() => parseTwoGo(fixture('delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const mixed = { history: [scan('Order is placed', '2026-04-02 09:14:05'), scan('Parcel is out for delivery', '2026-04-04 08:30:00', IN_TRANSIT)] };
    expect(() => parseTwoGo(mixed, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const partial = { history: [scan('Order is placed', '2026-04-02 09:14:05', 'A0000001')] };
    expect(() => parseTwoGo(partial, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a malformed reply, and reads an empty history as none', () => {
    const delivered = fixture('delivered') as { history: Record<string, unknown>[] };
    const changed = (patch: Record<string, unknown>) => ({ history: [{ ...delivered.history[0], ...patch }] });
    for (const payload of [
      {}, null, 'text', { history: 'none' }, { history: [null] }, { error: 'Internal server error' },
      changed({ trackingNumber: undefined }), changed({ status: 7 }), changed({ status: ' ' }),
      changed({ timestamp: '02/04/2026 09:14' }), changed({ timestamp: '2026-02-30 09:14:05' }), changed({ timestamp: '2026-04-02 24:00:00' }),
      changed({ timestamp: undefined }), { history: Array.from({ length: 501 }, () => delivered.history[0]) },
    ]) expect(() => parseTwoGo(payload, DELIVERED), JSON.stringify(payload)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTwoGo({ history: [], attachment: 'NO_ATTACHMENT' }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('keeps blocks, rate limits and moved routes apart from a missing parcel', async () => {
    const lookup = (answer: () => Response) => carrier(answering(answer)).track({ number: DELIVERED });
    await expect(lookup(() => reply(CHALLENGE, { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(CHALLENGE, { status: 404, headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply('{"message":"Forbidden"}', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply('{"message":"Too Many Requests"}', { status: 429, headers: { 'Retry-After': '120' } })))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 });
    // API Gateway's answer for a route it does not have is a moved route, as is a redirect.
    await expect(lookup(() => reply('{"message":"Missing Authentication Token"}', { status: 403 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 301, headers: { Location: 'https://track.2go.com.ph/' } }))).rejects.toMatchObject({ kind: 'transport' });
    // A 404 without the tracker's own message is not a missing parcel.
    await expect(lookup(() => reply('{"message":"Not Found"}', { status: 404 }))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => reply('<html><body>Internal Server Error</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => reply('{"message":"Internal server error"}', { status: 502 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(() => reply('', { status: 503 }))).rejects.toMatchObject({ kind: 'maintenance' });
  });

  it('gives an instant only to a clock with an offset, and drops who took the parcel and phone numbers', () => {
    const result = parseTwoGo({ history: [scan('Order is placed', '2026-04-02 09:14:05'), scan('Parcel has been delivered', '2026-04-04T06:22:31Z')] }, DELIVERED);
    expect(result).toMatchObject({ last_update: '2026-04-04T06:22:31Z', delivered_at: '2026-04-04T06:22:31Z' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events![0]).toEqual({ time: '2026-04-04T06:22:31Z', description: 'Parcel has been delivered', stage: 'delivered', stage_source: 'carrier_map' });
    expect(parseTwoGo({ history: [scan('Parcel has been delivered', '2026-04-04 14:22:31+08:00')] }, DELIVERED)).toMatchObject({ delivered_at: '2026-04-04T14:22:31+08:00' });
    expect(twoGoWording('DELIVERED - Received by: SAMPLE PERSON')).toBe('DELIVERED');
    expect(twoGoWording('Parcel has been delivered, received by Sample Person 0917 000 0000')).toBe('Parcel has been delivered');
    expect(twoGoWording('Shipment received by 2GO')).toBe('Shipment received by 2GO');
    expect(twoGoWording('Call your courier at +63 917 000 0000 today')).toBe('Call your courier at today');
  });

  it('asks once more when 2GO cannot be reached, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new TwoGoTracker({ fetcher: flaky, recorder }).fetch(IN_TRANSIT, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
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

  it('rejects what is not a 2GO number, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'A000001B', 'A00000001B', '00000001B', 'A0000001', 'AB0000001', 'AA000001', 'AA00000001', `A${'0'.repeat(70)}B`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTwoGoNumber('a 000-0001 b')).toBe(DELIVERED);
    expect(normalizeTwoGoNumber('aa 000 0004')).toBe(REFERENCE);
  });

  it('answers a number filed under 2GO, suggested for its shape, or opened from the earlier tracker’s address', async () => {
    const fetcher = answering(() => reply(text('in-transit')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: IN_TRANSIT, carrier: '2go' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: '2go', source: '2go', result: { current_stage: 'in_transit' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(TWO_GO_API))).toBe(true);
    // The shape only suggests 2GO, so preflight asks the tracker whether it knows the number.
    expect(detectCarrierMatch(IN_TRANSIT).candidates).toContain('2go');
    expect(recognitionCandidates(IN_TRANSIT).map((candidate) => candidate.carrier)).toContain('2go');
    expect(parseTrackingInput(`https://express.2go.com.ph/tracking?tracking_no=${IN_TRANSIT}`)).toMatchObject({ trackingNumber: IN_TRANSIT, carrier: '2go' });
  });
});

describe('2GO Express status vocabulary', () => {
  it('maps every wording seen on the current tracker to the stage recorded for it', () => {
    const live = (statuses.entries as { code?: string; wording: string; stage: string; confirmedBy: string }[])
      .filter((entry) => entry.confirmedBy === 'live' && /^(?:Order|Parcel)\b/.test(entry.wording));
    expect(live).toHaveLength(4);
    for (const entry of live) {
      const wording = entry.wording.replace('[hub]', 'SAMPLE HUB');
      expect(statusMap.stage(null, wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(twoGoStage(wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: '2go', providerCode: null, description: 'Parcel has arrived at SAMPLE HUB' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: '2go', providerCode: null, description: 'Xyzzy' })).toEqual({ kind: 'unknown' });
  });

  it('stages the earlier tracker’s titles, through its bookings or the shared rules', () => {
    for (const entry of statuses.entries as { wording: string; stage: string; confirmedBy: string }[]) {
      // A text message announcing a delivery attempt is no scan.
      if (entry.confirmedBy === 'source') continue;
      expect(twoGoStage(entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(twoGoStage('Xyzzy')).toBeNull();
  });
});
