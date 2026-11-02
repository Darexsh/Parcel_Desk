import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { CARRIERS } from '../../core/catalog/index.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, UPAYA_API, UpayaTracker } from './adapter.js';
import { normalizeUpayaNumber, parseUpaya, upayaWording } from './parser.js';
import { statusMap, upayaStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const CANCELLED = 'ZZZZZZ0001-0000001';
const IN_TRANSIT = 'ZZZZZZ00002-0000002';
const DELIVERED = 'ZZZZZZ00003-0000003';
const UNKNOWN = 'ZZZZZZ00000-0000000';

const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
// The lookup's envelope around a result fragment.
const found = (name: string, code: string, html = page(name)) => ({ ok: true, code, html });
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=UTF-8', ...init.headers } });
const answering = (body: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => body());
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (result: CarrierResult) => result.events!.map((event) => [event.time, event.location ?? null, event.description, event.stage ?? null]);
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
// The sender, the receiver, the destination area, the order reference, the cash to collect and the hub's contacts.
const PRIVATE = /Sample (?:Sender|Receiver|Area|Town|Street)|SAMPLE-ORDER|Rs\.|1,234|9800000000|01-0000000|Upaya Fulfillment/;

describe('Upaya HTTP adapter', () => {
  it('asks the tracking page’s lookup for the code in capitals with its hyphen, once, through the supplied transport', async () => {
    const fetcher = answering(() => reply(found('in-transit', IN_TRANSIT)));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new UpayaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zzzzzz000020000002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${UPAYA_API}?code=${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'upaya', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a cancelled order newest first on Nepal’s clock, with the hub of each scan', () => {
    const result = parseUpaya(found('cancelled', CANCELLED), CANCELLED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map',
      last_status_text: 'Cancelled', last_update: '2026-05-06T10:00:00+05:45', expected_delivery: null, service_name: 'Door to Door Delivery' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(rows(result)).toEqual([
      // The cancellation's line names only its hub, which other scans name too.
      ['2026-05-06T10:00:00+05:45', 'Sample Hub', 'Cancelled', 'exception'],
      // A failed pickup leaves the parcel with the sender.
      ['2026-05-05T17:15:00+05:45', 'Sample Hub', 'Pickup Process: Failed pickup', 'registered'],
      ['2026-05-05T14:45:00+05:45', 'Sample Hub', 'Pickup Process: Pickup assigned to rider', 'registered'],
      ['2026-05-05T00:05:00+05:45', 'Sample Hub', 'Pickup Process: Failed pickup', 'registered'],
      ['2026-05-04T17:45:00+05:45', 'Sample Hub', 'Pickup Process: Pickup assigned to rider', 'registered'],
      ['2026-05-04T14:15:00+05:45', 'Sample Hub', 'Pickup Process: Awaiting pickup assignment', 'registered'],
      // A line that opens with its heading stands alone.
      ['2026-05-04T14:15:00+05:45', 'Sample Hub', 'Order created', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.local_time === undefined)).toBe(true);
  });

  it('reads a parcel between hubs once per repeated scan, with the newest staged scan deciding', async () => {
    const result = await carrier(answering(() => reply(found('in-transit', IN_TRANSIT)))).track({ number: IN_TRANSIT });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'wording:language',
      last_status_text: 'In Transit: Received at hub', last_update: '2026-06-11T08:50:00+05:45', expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    expect(rows(result)).toEqual([
      ['2026-06-11T08:50:00+05:45', 'Sample City Hub', 'In Transit: Received at hub', 'in_transit'],
      // A line that opens with its heading stands alone.
      ['2026-06-10T19:25:00+05:45', 'Sample Hub', 'In transit to hub', 'in_transit'],
      ['2026-06-10T13:05:00+05:45', 'Sample Hub', 'Pickup Process: Picked up by rider', 'accepted'],
      ['2026-06-10T10:55:00+05:45', 'Sample Hub', 'Pickup Process: Rider out for pickup', null],
      ['2026-06-09T17:45:00+05:45', 'Sample Hub', 'Pickup Process: Awaiting pickup assignment', 'registered'],
      ['2026-06-09T17:45:00+05:45', 'Sample Hub', 'Order created', 'registered'],
    ]);
  });

  it('reads a delivered parcel with its delivery’s instant', () => {
    const result = parseUpaya(found('delivered', DELIVERED), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      last_update: '2026-07-03T14:35:00+05:45', delivered_at: '2026-07-03T14:35:00+05:45', expected_delivery: null });
    expect(rows(result).map(([, , description, stage]) => [description, stage])).toEqual([
      ['Delivered', 'delivered'],
      ['Out for Delivery: Dispatched with rider', 'out_for_delivery'],
      ['In Transit: Received at hub', 'in_transit'],
      ['In transit to hub', 'in_transit'],
      ['Pickup Process: Picked up by rider', 'accepted'],
      ['Pickup Process: Pickup assigned to rider', 'registered'],
      ['Order created', 'registered'],
    ]);
  });

  it('keeps no sender, receiver, destination area, order reference, cash to collect or hub contact', () => {
    const results = ['cancelled', 'in-transit', 'delivered'].map((name, index) => {
      const code = [CANCELLED, IN_TRANSIT, DELIVERED][index]!;
      return parseUpaya(found(name, code), code);
    });
    for (const name of ['cancelled', 'in-transit', 'delivered']) expect(page(name)).toMatch(PRIVATE);
    expect(JSON.stringify(results)).not.toMatch(PRIVATE);
  });

  it('reads a one-part line as a hub only when the reply names that hub, and leaves out what sits between a line and its hub', () => {
    const html = page('cancelled')
      .replace('Sample Hub            </p>', 'Sender asked to cancel            </p>')
      .replace('Failed pickup · Sample Hub', 'Failed pickup · Sample Person · Sample Hub');
    const result = parseUpaya(found('cancelled', CANCELLED, html), CANCELLED);
    expect(rows(result).slice(0, 2)).toEqual([
      ['2026-05-06T10:00:00+05:45', null, 'Cancelled: Sender asked to cancel', 'exception'],
      ['2026-05-05T17:15:00+05:45', 'Sample Hub', 'Pickup Process: Failed pickup', 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toContain('Sample Person');
    // The handling hub names a place no other scan does.
    const hubOnly = page('cancelled').replace(/ · Sample Hub/g, '');
    expect(rows(parseUpaya(found('cancelled', CANCELLED, hubOnly), CANCELLED))[0]).toEqual(['2026-05-06T10:00:00+05:45', 'Sample Hub', 'Cancelled', 'exception']);
  });

  it('turns an oldest-first timeline round', () => {
    const html = page('delivered');
    const items = html.match(/ {8}<li class="uot-timeline__item[\s\S]*?<\/li>\n/g)!;
    const reversed = html.replace(items.join(''), [...items].reverse().join(''));
    expect(rows(parseUpaya(found('delivered', DELIVERED, reversed), DELIVERED))).toEqual(rows(parseUpaya(found('delivered', DELIVERED), DELIVERED)));
  });

  it('reads the lookup’s 404 “uot_not_found” as not found, and a recognition of it as unknown', async () => {
    await expect(carrier(answering(() => reply(text('not-found'), { status: 404 }))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(answering(() => reply(text('not-found'), { status: 404 }))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(answering(() => reply(found('cancelled', CANCELLED)))).recognize!(CANCELLED))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-05-06T04:15:00.000Z' });
    // A code of another layout is unknown without a request.
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('ZZZZZZ000-0000000')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads the lookup’s “invalid_code” as a code Upaya does not issue', async () => {
    await expect(carrier(answering(() => reply(text('invalid-code'), { status: 400 }))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'invalid_input' });
  });

  it('refuses a result for another code', () => {
    expect(() => parseUpaya(found('delivered', DELIVERED), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const otherInPage = page('delivered').replace(`data-uot-copy-value="${DELIVERED}"`, 'data-uot-copy-value="ZZZZZZ00003-00000031"');
    expect(() => parseUpaya(found('delivered', DELIVERED, otherInPage), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const code of ['ZZZZZZ00003-000000', 'ZZZZZZ00003', 'ZZZZZZ00003-00000031']) {
      expect(() => parseUpaya({ ...found('delivered', DELIVERED), code }, DELIVERED), code).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseUpaya(found('delivered', DELIVERED, page('delivered') + page('cancelled')), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The same code without its hyphen or in lower case is the one asked.
    expect(parseUpaya({ ...found('delivered', DELIVERED), code: 'zzzzzz000030000003' }, DELIVERED).events).toHaveLength(7);
  });

  it('refuses a malformed reply, and reads a result without scans as no history', () => {
    for (const payload of [null, 'text', [], {}, { ok: 'true' }, { ok: false }, { ok: false, error: 7 },
      { ok: true, html: page('delivered') }, { ok: true, code: DELIVERED }, { ok: true, code: DELIVERED, html: 7 },
      found('delivered', DELIVERED, '<div class="uot-notice">Something went wrong.</div>'),
      found('delivered', DELIVERED, page('delivered').replace(/ data-uot-copy-value="[^"]*"/, '')),
      found('delivered', DELIVERED, page('delivered').replace('datetime="2026-07-03T08:50:00.000Z"', 'datetime="2026-07-03T08:50:00"')),
      found('delivered', DELIVERED, page('delivered').replace('datetime="2026-07-03T08:50:00.000Z"', 'datetime="3 Jul 2026"')),
      found('delivered', DELIVERED, page('delivered').replace('datetime="2026-07-03T08:50:00.000Z"', 'datetime="2026-02-30T08:50:00.000Z"')),
      found('delivered', DELIVERED, page('delivered').replace(/<time class="uot-timeline__time" datetime="2026-07-03T08:50:00.000Z">/, '<time>')),
      found('delivered', DELIVERED, page('delivered').replace('<p class="uot-timeline__title">Delivered</p>', '<p class="uot-timeline__title">Delivered</p><p class="uot-timeline__title">Delivered</p>')),
      found('delivered', DELIVERED, page('delivered').replace(/<p class="uot-timeline__title">Delivered<\/p>\s*<p class="uot-timeline__meta">[^<]*<\/p>/, '')),
      found('delivered', DELIVERED, page('delivered').replace(/<ol class="uot-timeline">/, `<ol class="uot-timeline">${'<li class="uot-timeline__item"></li>'.repeat(301)}`)),
    ]) {
      expect(() => parseUpaya(payload, DELIVERED), JSON.stringify(payload).slice(0, 120)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const empty = page('delivered').replace(/<ol class="uot-timeline">[\s\S]*<\/ol>/, '<ol class="uot-timeline"></ol>');
    expect(() => parseUpaya(found('delivered', DELIVERED, empty), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    // Another failure the lookup names is no answer about the parcel.
    expect(() => parseUpaya({ ok: false, error: 'uot_upstream_error', html: '' }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps blocks, rate limits and moved routes apart from a missing parcel', async () => {
    const lookup = (answer: () => Response) => carrier(answering(answer)).track({ number: DELIVERED });
    await expect(lookup(() => reply(CHALLENGE, { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(CHALLENGE, { status: 403, headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply({ ...found('delivered', DELIVERED), html: CHALLENGE }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(CHALLENGE, { status: 404, headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply('<html><body>Too many requests</body></html>', { status: 429, headers: { 'Retry-After': '120' } })))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 });
    // WordPress's answer for a route it does not have is a moved route, as are a bare 404 and a redirect.
    await expect(lookup(() => reply({ code: 'rest_no_route', message: 'No route was found matching the URL and request method.', data: { status: 404 } },
      { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('<html><body>Not Found</body></html>', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 301, headers: { Location: 'https://upaya.com.np/' } }))).rejects.toMatchObject({ kind: 'transport' });
    // A 400 without the lookup's own error is a changed request, not a code Upaya does not issue.
    await expect(lookup(() => reply({ code: 'rest_missing_callback_param', message: 'Missing parameter(s): code', data: { status: 400 } }, { status: 400 })))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => reply('<html><body>Error</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => reply('{"ok":false,"error":"uot_upstream_error"}', { status: 502 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(() => reply('', { status: 503 }))).rejects.toMatchObject({ kind: 'maintenance' });
  });

  it('asks once more when Upaya cannot be reached, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(found('in-transit', IN_TRANSIT)));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new UpayaTracker({ fetcher: flaky, recorder }).fetch(IN_TRANSIT, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
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

  it('rejects what is not an Upaya tracking code, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'ZZZZZZ000-0000000', 'ZZZZZZ000000-0000000', 'ZZZZZ00001-0000001', 'ZZZZZZZ0001-0000001', 'ZZZZZZ0001-000000',
      'ZZZZZZ0001_0000001', 'ZZZ0001-0000001', 'WRL0000000AZSN', `ZZZZZZ0001-${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeUpayaNumber('zzzzzz00010000001')).toBe(CANCELLED);
    expect(normalizeUpayaNumber(' ZZZZZZ 00002 0000002 ')).toBe(IN_TRANSIT);
    // A hyphen typed elsewhere goes back before the last seven digits.
    expect(normalizeUpayaNumber('ZZZZZZ-00002-000000-2')).toBe(IN_TRANSIT);
  });

  it('answers a code filed under Upaya, offered by detection with its hyphen, or opened from its tracker’s address', async () => {
    const fetcher = answering(() => reply(found('delivered', DELIVERED)));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'upaya' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'upaya', source: 'upaya', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === `${UPAYA_API}?code=${DELIVERED}`)).toBe(true);
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ confidence: 'low', candidates: ['upaya'] });
    expect(detectCarrierMatch(CANCELLED)).toMatchObject({ confidence: 'low', candidates: expect.arrayContaining(['upaya']) });
    expect(parseTrackingInput(`https://upaya.com.np/track/?tracking=${DELIVERED}`)).toMatchObject({ carrier: 'upaya' });
    expect(CARRIERS.upaya.trackingUrl?.(DELIVERED)).toBe(`https://upaya.com.np/track/?tracking=${DELIVERED}`);
  });
});

describe('Upaya status vocabulary', () => {
  it('maps every wording recorded for the tracker to its stage', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(upayaStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'upaya', description: 'Pickup Process: Failed pickup' })).toEqual({ kind: 'mapped', stage: 'registered' });
    expect(statusMapAnswer({ carrier: 'upaya', description: 'Xyzzy' })).toEqual({ kind: 'unknown' });
    expect(statusMap.stage('7', 'cancelled')).toBeUndefined();
    for (const wording of ['constructor', 'toString', 'pickup process']) expect(statusMap.stage(null, wording), wording).toBeUndefined();
  });

  it('gives a pickup wording the map does not know no stage the shared rules give a recipient’s pickup or delivery', () => {
    expect(upayaStage('Pickup Process: Failed pickup attempt')).toBeNull();
    expect(upayaStage('Pickup Process: Awaiting pickup')).toBeNull();
    expect(upayaStage('Pickup Process: Picked up by rider')).toMatchObject({ stage: 'accepted' });
    expect(upayaStage('Out for Delivery: Dispatched with rider')).toMatchObject({ stage: 'out_for_delivery' });
    expect(upayaStage('Xyzzy')).toBeNull();
    expect(upayaWording('Order Created', 'Order created')).toBe('Order created');
    // A cancellation is one whatever its line says.
    expect(upayaStage('Cancelled: Sender asked to cancel')).toEqual({ stage: 'exception', source: 'carrier_map' });
    expect(statusMap.stage(null, 'cancelled: sender asked to cancel')).toBe('exception');
    expect(upayaWording('Cancelled', '')).toBe('Cancelled');
    expect(upayaWording('', 'Failed pickup')).toBe('Failed pickup');
  });
});
