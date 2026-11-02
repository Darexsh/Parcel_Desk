import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, normalizeOldDominionNumber, OldDominionTracker, oldDominionPro, oldDominionTraceUrl, parseOldDominionReply,
  type OldDominionReply } from './adapter.js';
import { CAPTURE_LIMIT_MS, CLEANUP_MS, NAVIGATION_LIMIT_MS } from './browser.js';
import { OLD_DOMINION_API } from './parser.js';
import { oldDominionStatus } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// A synthetic PRO; its leading zero is dropped when the page sends it.
const NUMBER = '07200000001';
const PRO = '7200000001';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const delivered = () => JSON.parse(fixture('delivered.ndjson')) as { body: Record<string, unknown> & {
  traceInfo: (Record<string, unknown> & { trackTraceDetail: Record<string, unknown>[] })[] } };
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const reply = (body: string, status = 200, contentType = 'application/x-ndjson', retryAfter: string | null = null): OldDominionReply =>
  ({ status, contentType, retryAfter, body });
const parse = (body: string, status?: number, contentType?: string, retryAfter?: string | null) =>
  parseOldDominionReply(reply(body, status, contentType, retryAfter), NUMBER);
const fails = (body: string, kind: string, status?: number, contentType?: string) =>
  expect(() => parse(body, status, contentType)).toThrowError(expect.objectContaining({ kind }));

describe('Old Dominion PRO numbers', () => {
  it('accepts what the trace page accepts and sends it without leading zeros', () => {
    expect(normalizeOldDominionNumber(' 072-0000-0001 ')).toBe(NUMBER);
    expect(normalizeOldDominionNumber('720000001')).toBe('720000001');
    expect(oldDominionPro(NUMBER)).toBe(PRO);
    expect(oldDominionTraceUrl(NUMBER)).toBe(`https://www.odfl.com/us/en/tools/trace-track-ltl-freight.html?proNumbers=${NUMBER}`);
  });

  // The page's address loader drops any PRO containing 123456789 and sends nothing.
  it.each(['72000000', '720000000012', 'A7200000001', '11111111111', '0123456789', '12345678901', '11234567890', '01234567892', ''])(
    'rejects %j before any request', (raw) => {
      expect(() => normalizeOldDominionNumber(raw)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    });

  it('leaves Truckload Services PROs out, leading zeros or not', () => {
    for (const raw of ['6001234567', '06001234567']) {
      expect(() => normalizeOldDominionNumber(raw)).toThrowError(expect.objectContaining({ kind: 'invalid_input', message: expect.stringMatching(/Truckload/) }));
    }
  });
});

describe('Old Dominion trace replies', () => {
  it('reads a delivered history newest first, on the clocks its offsets give', () => {
    const result = normalizeCarrierResult(parse(fixture('delivered.ndjson')));
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivery Confirmed', last_update: '2026-03-11T06:10:00-04:00',
      // The handover is the Delivered scan, not the later confirmation.
      delivered_at: '2026-03-10T14:20:10-04:00', expected_delivery: null, weight_kg: 453.592,
      tracking_url: oldDominionTraceUrl(NUMBER), tracking_source: 'structured-web-response',
    });
    expect(result.events).toHaveLength(10);
    expect(result.events?.map(event => event.time)).toEqual([...result.events!.map(event => event.time)].sort().reverse());
    expect(result.events?.[4]).toEqual({ time: '2026-03-09T05:40:40-04:00', location: 'TESTVILLE, TX',
      description: 'Arrived at TESTVILLE, TX (TST)', provider_code: 'In Transit', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(result.events?.at(-1)).toMatchObject({ location: 'EXAMPLE CITY, NC', stage: 'registered' });
    expect(result.events?.find(event => event.provider_code === 'Pickup Completed')?.stage).toBe('accepted');
    expect(result.events?.every(event => /T\d{2}:\d{2}:\d{2}-04:00$/.test(event.time ?? ''))).toBe(true);
  });

  it('never projects shipper, consignee, signer, references or a delivered shipment\'s appointment', () => {
    const result = parse(fixture('delivered.ndjson'));
    expect(JSON.stringify({ ...result, tracking_url: null })).not.toMatch(/PRIVATE|07:30|15:30|09:00:00|12:00:00|\b0000\d\b|\b2 ?pieces/i);
    expect(Object.keys(result).sort()).toEqual(['current_stage', 'current_stage_source', 'delivered_at', 'events', 'expected_delivery',
      'last_status_text', 'last_update', 'status', 'tracking_source', 'tracking_url', 'weight_kg']);
    // Customer sites keep their status and lose the city.
    for (const event of result.events ?? []) {
      if (['Pickup Completed', 'Arrived at Consignee', 'Delivered', 'Delivery Confirmed'].includes(event.provider_code ?? '')) {
        expect(event.location).toBeUndefined();
        expect(event.description).toBe(event.provider_code);
      }
      expect(Object.keys(event).every(key => ['time', 'location', 'description', 'provider_code', 'stage', 'stage_source'].includes(key))).toBe(true);
    }
  });

  it('orders scans by their instants, keeps an estimate until delivery and prefers the updated one', () => {
    const payload = delivered();
    const info = payload.body.traceInfo[0]!;
    info.trackTraceDetail = info.trackTraceDetail.slice(4).reverse();
    delete info.deliveryDetails;
    const result = parse(line(payload));
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Arrived at TESTVILLE, TX (TST)',
      expected_delivery: '2026-03-10', delivered_at: null });
    expect(result.events?.[0]?.time).toBe('2026-03-09T05:40:40-04:00');
    delete info.updatedEta;
    expect(parse(line(payload)).expected_delivery).toBe('2026-03-09');
    info.standardEta = '2026-02-30';
    expect(parse(line(payload)).expected_delivery).toBeNull();
  });

  it('keeps scans of one instant in the carrier’s order', () => {
    const payload = delivered();
    const info = payload.body.traceInfo[0]!;
    info.trackTraceDetail = info.trackTraceDetail.slice(-3).reverse();
    info.trackTraceDetail[2]!.dateTime = info.trackTraceDetail[1]!.dateTime;
    expect(parse(line(payload)).events?.map(event => event.provider_code)).toEqual(['In Transit', 'Pickup Completed', 'Pickup Requested']);
  });

  it('prefers a confirmed delivery appointment, as a local window within one day', () => {
    const payload = delivered();
    const info = payload.body.traceInfo[0]!;
    info.trackTraceDetail = info.trackTraceDetail.slice(3);
    // The ends carry no offset, so the window keeps the service's own clock.
    expect(parse(line(payload))).toMatchObject({ status: 'out_for_delivery', expected_delivery: '2026-03-10 07:30–15:30' });
    // The estimate falls on another day, so the appointment's day is told apart from it.
    info.updatedEta = '2026-03-11';
    const details = info.deliveryDetails as Record<string, unknown>;
    for (const [begin, end, expected] of [
      // The page shows the start's day with a single time: the end after a
      // midnight start, which it drops, or the one time of both ends.
      ['2026-03-10 00:00:00', '2026-03-10 15:30:00', '2026-03-10'],
      ['2026-03-10 07:30:00', '2026-03-10 07:30:00', '2026-03-10'],
      // It shows the start's day beside any other window, or the start alone.
      ['2026-03-10 15:00:00', '2026-03-10 00:00:00', '2026-03-10'],
      ['2026-03-10 07:30:00', '2026-03-11 15:30:00', '2026-03-10'],
      ['2026-03-10 07:30:00', null, '2026-03-10'],
      // A start that is no wall clock leaves the estimate.
      ['2026-03-10T07:30:00-04:00', '2026-03-10T15:30:00-04:00', '2026-03-11'],
      ['2026-02-30 07:30:00', '2026-02-30 15:30:00', '2026-03-11'],
      [null, '2026-03-10 15:30:00', '2026-03-11'],
    ]) {
      Object.assign(details, { deliveryAptBeginTime: begin, deliveryAptEndTime: end });
      expect(parse(line(payload)).expected_delivery, `${begin} to ${end}`).toBe(expected);
    }
    Object.assign(details, { deliveryAptBeginTime: '2026-03-10 07:30:00', deliveryAptEndTime: '2026-03-10 15:30:00' });
    for (const status of ['Appointment Cancelled', 'Appointment Attempted', undefined]) {
      details.deliveryAppointmentStatus = status;
      expect(parse(line(payload)).expected_delivery, String(status)).toBe('2026-03-11');
    }
    // A pickup window, valid or not, is never the delivery's.
    delete info.deliveryDetails;
    delete info.updatedEta;
    expect(parse(line(payload)).expected_delivery).toBe('2026-03-09');
    expect(JSON.stringify(parse(line(payload)))).not.toMatch(/09:00|12:00/);
  });

  it('files a confirmed pickup before the pickup, without a place', () => {
    const payload = delivered();
    const info = payload.body.traceInfo[0]!;
    info.trackTraceDetail = [{ status: 'Pickup Confirmed', statusDesc: 'Pickup Confirmed', dateTime: '2026-03-05T11:00:00.000-04:00',
      city: 'EXAMPLE CITY', state: 'NC', zipCode: '00001' }, ...info.trackTraceDetail.slice(-1)];
    const result = parse(line(payload));
    expect(result).toMatchObject({ status: oldDominionStatus('Pickup Requested')?.status, current_stage: 'registered',
      current_stage_source: 'carrier_map', last_status_text: 'Pickup Confirmed', delivered_at: null });
    expect(result.events?.[0]).toEqual({ time: '2026-03-05T11:00:00-04:00', description: 'Pickup Confirmed', provider_code: 'Pickup Confirmed',
      stage: 'registered', stage_source: 'carrier_map' });
  });

  it('accepts the PRO named with or without its leading zeros', () => {
    const payload = delivered();
    payload.body.referenceNumber = NUMBER;
    payload.body.traceInfo[0]!.proNumber = NUMBER;
    expect(parse(line(payload)).status).toBe('delivered');
  });

  it('answers an unknown PRO the service names with a clean not-found', () => {
    expect(() => parse(fixture('not-found.ndjson'))).toThrowError(expect.objectContaining({ kind: 'not_found' }));
  });

  it.each([
    ['another reference', (payload: ReturnType<typeof delivered>) => { payload.body.referenceNumber = '7200000002'; }],
    ['another reference type', (payload: ReturnType<typeof delivered>) => { payload.body.referenceType = 'BOL'; }],
    ['another shipment', (payload: ReturnType<typeof delivered>) => { payload.body.traceInfo[0]!.proNumber = 7200000002; }],
    ['no shipment number', (payload: ReturnType<typeof delivered>) => { delete payload.body.traceInfo[0]!.proNumber; }],
    ['two shipments', (payload: ReturnType<typeof delivered>) => { payload.body.traceInfo.push(payload.body.traceInfo[0]!); }],
    ['no answer flag', (payload: ReturnType<typeof delivered>) => { delete payload.body.ok; }],
  ])('rejects %s before reading the history', (_, change) => {
    const payload = delivered();
    change(payload);
    fails(line(payload), 'schema');
  });

  it('never takes another PRO\'s not-found for this one', () => {
    const payload = JSON.parse(fixture('not-found.ndjson')) as { body: Record<string, unknown> };
    payload.body.referenceNumber = '7200000002';
    fails(line(payload), 'schema');
    fails(fixture('not-found.ndjson') + fixture('not-found.ndjson'), 'schema');
  });

  it('keeps a verification failure apart from a missing shipment', () => {
    fails('', 'challenge', 500, '');
    fails(fixture('robot.json'), 'challenge', 422, 'application/json');
    fails(fixture('robot.json'), 'challenge', 200, 'application/json');
    fails('<html><body>Request blocked</body></html>', 'challenge', 200, 'text/html');
    fails('{}', 'challenge', 403, 'application/json');
    const payload = JSON.parse(fixture('not-found.ndjson')) as { body: Record<string, unknown> };
    payload.body.errors = [{ message: "We couldn't confirm you're not a robot, please try again." }];
    fails(line(payload), 'challenge');
  });

  it('keeps rate limits, missing routes and outages out of not-found', () => {
    expect(() => parse('', 429, 'text/plain', '30')).toThrowError(expect.objectContaining({ kind: 'rate_limited', retryAfterMs: 30_000 }));
    fails('', 'transport', 404, 'text/html');
    fails(fixture('not-found.ndjson'), 'transport', 410);
    fails('', 'maintenance', 503, 'text/html');
    fails('<html>Bad gateway</html>', 'indeterminate', 502, 'text/html');
    fails('{"status":406,"error":"Not Acceptable"}', 'transport', 406, 'application/json');
    fails('{"ok":false,"errors":[{"message":"other"}]}', 'transport', 422, 'application/json');
  });

  it.each([
    ['unreadable JSON', () => 'not json'],
    ['an empty reply', () => ''],
    ['a scan without a clock', () => { const p = delivered(); delete p.body.traceInfo[0]!.trackTraceDetail[0]!.dateTime; return line(p); }],
    ['a clock without an offset', () => { const p = delivered(); p.body.traceInfo[0]!.trackTraceDetail[0]!.dateTime = '2026-03-11 06:10:00'; return line(p); }],
    ['an impossible offset', () => { const p = delivered(); p.body.traceInfo[0]!.trackTraceDetail[0]!.dateTime = '2026-03-11T06:10:00.000-24:00'; return line(p); }],
    ['a scan without a status', () => { const p = delivered(); p.body.traceInfo[0]!.trackTraceDetail[0]!.status = { text: 'Delivered' }; return line(p); }],
    ['a history that is not a list', () => { const p = delivered(); (p.body.traceInfo[0] as Record<string, unknown>).trackTraceDetail = {}; return line(p); }],
    ['an excessive history', () => { const p = delivered(); const info = p.body.traceInfo[0]!; info.trackTraceDetail = Array.from({ length: 501 }, () => info.trackTraceDetail[0]!); return line(p); }],
  ])('rejects %s', (_, body) => fails(body(), 'schema'));

  it('leaves an unfinished lookup and an empty history inconclusive', () => {
    const empty = delivered();
    empty.body.traceInfo[0]!.trackTraceDetail = [];
    fails(line(empty), 'indeterminate');
    const payload = JSON.parse(fixture('not-found.ndjson')) as { body: Record<string, unknown> };
    payload.body.errors = [{ errorCode: 500, message: 'service_unavailable' }];
    fails(line(payload), 'indeterminate');
  });

  it('maps every status seen from Old Dominion', () => {
    for (const entry of statuses.entries) expect(oldDominionStatus(entry.wording)?.stage, entry.wording).toBe(entry.stage);
  });

  it('leaves a status outside its list to the shared wording rules', () => {
    const payload = delivered();
    Object.assign(payload.body.traceInfo[0]!.trackTraceDetail[0]!, { status: 'Interline Handoff', statusDesc: 'Interline Handoff' });
    const result = parse(line(payload));
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Interline Handoff', delivered_at: null });
    expect(result.current_stage).toBeUndefined();
    expect(result.events?.[0]).toEqual({ time: '2026-03-11T06:10:00-04:00', description: 'Interline Handoff', provider_code: 'Interline Handoff' });
  });

  it('proves each declared capability', () => {
    const result = parse(fixture('delivered.ndjson'));
    const inTransit = delivered();
    inTransit.body.traceInfo[0]!.trackTraceDetail = inTransit.body.traceInfo[0]!.trackTraceDetail.slice(3);
    const checks: Record<string, boolean> = {
      history: Boolean(result.events?.length), location: Boolean(result.events?.some(event => event.location)),
      eta: Boolean(parse(line(inTransit)).expected_delivery), delivered_at: Boolean(result.delivered_at),
      provider_code: Boolean(result.events?.every(event => event.provider_code)), weight: typeof result.weight_kg === 'number',
    };
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8')) as { capabilities: string[] };
    for (const capability of metadata.capabilities) expect(checks[capability], capability).toBe(true);
  });
});

interface FakeOptions { reply?: { status: number; body: string; contentType?: string }; pageStatus?: number; landed?: string;
  navigation?: Error; close?: () => Promise<void> }

/** A browser whose trace page makes one tracking call, as the real page does on load. */
function fakeBrowser(options: FakeOptions) {
  const emitter = new EventEmitter();
  const frame = {};
  let url = 'about:blank';
  const goto = vi.fn(async (target: string, init: { waitUntil: string; timeout: number }) => {
    void init;
    if (options.navigation) throw options.navigation;
    url = options.landed ?? target;
    const { reply } = options;
    if (reply) {
      const request = { url: () => OLD_DOMINION_API, method: () => 'POST', frame: () => frame,
        postDataJSON: () => ({ referenceType: 'PRO', referenceNumbers: [PRO] }) };
      emitter.emit('response', { request: () => request, status: () => reply.status,
        headers: () => ({ 'content-type': reply.contentType ?? 'application/x-ndjson' }), body: async () => Buffer.from(reply.body) });
    }
    return { status: () => options.pageStatus ?? 200, headers: () => ({}) };
  });
  const page = Object.assign(emitter, { mainFrame: () => frame, goto, url: () => url });
  const context = { newPage: vi.fn(async () => page), close: vi.fn(options.close ?? (async () => {})) };
  const browser = { version: () => '140.0.7339.16', newContext: vi.fn(async (init: Record<string, unknown>) => { void init; return context; }),
    close: vi.fn(async () => {}) };
  const launch = vi.spyOn(chromium, 'launch').mockResolvedValue(browser as never);
  return { browser, context, page, goto, launch };
}

const instance = (recorder = NOOP_RECORDER, browserExecutablePath: string | null = '/synthetic/chromium') =>
  adapter({ fetcher: vi.fn<typeof fetch>(), env: {}, recorder, trawl: null, browserExecutablePath });

describe('Old Dominion browser lookup', () => {
  it('reads the trace page\'s own call in a fresh context and closes it', async () => {
    const fake = fakeBrowser({ reply: { status: 200, body: fixture('delivered.ndjson') } });
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      const tracker = instance(recorder);
      expect(tracker.steps).toEqual(['browser']);
      await expect(tracker.track({ number: NUMBER }, { budgetMs: 90_000 })).resolves.toMatchObject({ status: 'delivered',
        delivered_at: '2026-03-10T14:20:10-04:00' });
      expect(fake.launch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ executablePath: '/synthetic/chromium', headless: true,
        args: ['--disable-blink-features=AutomationControlled'] }));
      expect(fake.browser.newContext).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ locale: 'en-US', acceptDownloads: false,
        serviceWorkers: 'block', userAgent: expect.stringMatching(/ Chrome\/140\.0\.0\.0 Safari\/537\.36$/) }));
      const [url, init] = fake.goto.mock.calls[0]!;
      const deadlines = timeout.mock.calls.map(([ms]) => ms);
      expect(url).toBe(oldDominionTraceUrl(NUMBER));
      expect(init.waitUntil).toBe('domcontentloaded');
      // A page that never answers releases the shared browser well inside its minute.
      expect(init.timeout).toBe(NAVIGATION_LIMIT_MS);
      expect(deadlines).toContain(CAPTURE_LIMIT_MS);
      expect(fake.context.close).toHaveBeenCalledOnce();
      expect(fake.browser.close).toHaveBeenCalledOnce();
      expect(recorder.step).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ step: 'browser', outcome: 'ok' }));
    } finally { fake.launch.mockRestore(); timeout.mockRestore(); }
  });

  it.each<[string, FakeOptions, string, string?]>([
    ['a failed page verification', { reply: { status: 422, body: fixture('robot.json'), contentType: 'application/json' } }, 'challenge'],
    ['an unknown PRO', { reply: { status: 200, body: fixture('not-found.ndjson') } }, 'not_found'],
    ['a missing trace page', { pageStatus: 404 }, 'transport', 'Old Dominion trace page is unavailable'],
    ['a blocked trace page', { pageStatus: 403 }, 'challenge'],
    ['a redirect elsewhere', { landed: 'https://www.odfl.com/us/en/maintenance.html' }, 'schema'],
    ['a navigation failure', { navigation: new Error('net::ERR_FAILED at PRIVATE URL') }, 'transport', 'Old Dominion browser tracking failed'],
  ])('answers %s and still closes the context', async (_, options, kind, message) => {
    const fake = fakeBrowser(options);
    try {
      const failure = new OldDominionTracker({ executablePath: '/synthetic/chromium' }).fetch(NUMBER, { budgetMs: 10_000 });
      await expect(failure).rejects.toMatchObject({ kind, ...(message ? { message } : {}) });
      await expect(failure).rejects.not.toHaveProperty('cause');
      expect(fake.context.close).toHaveBeenCalledOnce();
    } finally { fake.launch.mockRestore(); }
  });

  it('does not wait on a context that never closes beyond the time kept for it', async () => {
    const fake = fakeBrowser({ reply: { status: 200, body: fixture('not-found.ndjson') }, close: () => new Promise(() => {}) });
    try {
      const started = performance.now();
      await expect(new OldDominionTracker({ executablePath: '/synthetic/chromium' }).fetch(NUMBER, { budgetMs: 10_000 }))
        .rejects.toMatchObject({ kind: 'not_found' });
      expect(performance.now() - started).toBeLessThan(CLEANUP_MS + 1_000);
    } finally { fake.launch.mockRestore(); }
  });

  it('launches nothing without a browser, for an invalid PRO or after cancellation', async () => {
    const launch = vi.spyOn(chromium, 'launch').mockRejectedValue(new Error('Synthetic browser launch'));
    try {
      await expect(instance(NOOP_RECORDER, null).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
      await expect(instance().track({ number: '6001234567' })).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(instance().track({ number: 'not a pro' })).rejects.toMatchObject({ kind: 'invalid_input' });
      const reason = new Error('cancelled');
      await expect(instance().track({ number: NUMBER }, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
      expect(launch).not.toHaveBeenCalled();
    } finally { launch.mockRestore(); }
  });
});
