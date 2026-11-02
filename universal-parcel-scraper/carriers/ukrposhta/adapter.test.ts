import { readFileSync } from 'node:fs';
import { chromium, type Browser } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, UKRPOSHTA_API, UKRPOSHTA_STATUS_API, UkrposhtaTracker, ukrposhtaTrackingUrl } from './adapter.js';
import { normalizeUkrposhtaNumber, parseUkrposhtaHistory, parseUkrposhtaOverview, parseUkrposhtaStatuses, ukrposhtaWallClock } from './parser.js';
import { InvalidInputError } from '../../core/errors/index.js';

const NUMBER = '0000000000091';
const fixture = (name = 'returned') => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const parsed = (pair = fixture(), number = NUMBER) => normalizeCarrierResult(parseUkrposhtaHistory(pair.history, parseUkrposhtaOverview(pair.overview, number)));

afterEach(() => vi.restoreAllMocks());

describe('Ukrposhta native history projection', () => {
  it('requires the exact barcode-bound overview and complete matching full history', () => {
    const result = parsed();
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_update: null });
    expect(result.events).toHaveLength(5);
    expect(result.events?.[0]).toMatchObject({ local_time: '2026-03-29T16:03:00', stage: 'returned', provider_leg: 'return' });
    expect(result.events?.[1]).toMatchObject({ stage: 'ready_for_pickup', provider_leg: 'return' });
    expect(result.events?.[2]).toMatchObject({ stage: 'in_transit', provider_leg: 'return' });
    expect(result.events?.[3]).toMatchObject({ stage: 'exception', provider_leg: 'return' });
    expect(result.events?.[4]).toMatchObject({ stage: 'registered' });
    expect(result.events?.[4]!.provider_leg).toBeUndefined();
    expect(result.delivered_at).toBeUndefined();
    expect(result.expected_delivery).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('keeps international delivered history local rather than assigning the home zone', () => {
    const result = parsed(fixture('delivered'), 'RR000000005UA');
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null });
    expect(result.events?.[1]!.stage).toBe('out_for_delivery');
    expect(result.events?.every(event => event.local_time && !event.time)).toBe(true);
    expect(result.delivered_at).toBeUndefined();
  });

  it.each(['identity', 'duplicate', 'count', 'code', 'label', 'location', 'country', 'date'])('rejects an overview/history %s mismatch', mode => {
    const pair = fixture(), row = pair.overview.result[0];
    if (mode === 'identity') row.barcode = '0000000000092';
    if (mode === 'duplicate') pair.overview.result.push(row);
    if (mode === 'count') row.step++;
    if (mode === 'code') row.event = '48000';
    if (mode === 'label') row.eventName = 'Final delivery';
    if (mode === 'location') row.name = 'Different facility';
    if (mode === 'country') row.country = 'Different country';
    if (mode === 'date') row.date = '2026-03-29T16:04:00';
    expect(() => parsed(pair)).toThrow();
  });

  it.each(['top', 'row'])('requires any optional %s history identity to agree', mode => {
    const pair = fixture();
    if (mode === 'top') pair.history.nod_barcode = '0000000000092';
    else pair.history.result[2].nod_barcode = '0000000000092';
    expect(() => parsed(pair)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('does not turn a return decision or later transport into completed return', () => {
    const pair = fixture();
    pair.history.result.shift(); pair.overview.result[0] = { ...pair.overview.result[0], step: 4,
      date: '2026-03-28T13:32:44', event: '21700', eventName: 'Return: Arrived to the Branch' };
    expect(parsed(pair)).toMatchObject({ status: 'in_transit', current_stage: 'ready_for_pickup' });
    pair.history.result.shift(); pair.overview.result[0] = { ...pair.overview.result[0], step: 3,
      date: '2026-03-28T11:27:44', event: '20800', eventName: 'Return: Departed from the Logistics Center' };
    expect(parsed(pair)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    pair.history.result.shift(); pair.overview.result[0] = { ...pair.overview.result[0], step: 2,
      date: '2026-03-27T10:34:44', event: '31200', eventName: "Returned to Sender (Due to Recipient's Refusal)" };
    expect(parsed(pair)).toMatchObject({ status: 'exception', current_stage: 'exception' });
  });

  it.each(['invalid', 'missing'])('preserves an unresolved %s latest clock and native current-first order', mode => {
    const pair = fixture(), value = mode === 'invalid' ? 'not a date' : '';
    pair.overview.result[0].date = pair.history.result[0].gtt_date = value;
    const result = parsed(pair);
    expect(result.last_update).toBeNull();
    expect(result.events?.[0]).toMatchObject({ provider_code: '41000', stage: 'returned' });
    expect(result.events?.[0]!.local_time).toBeUndefined();
    if (mode === 'invalid') expect(result.events?.[0]!.provider_time_text).toBe(value);
    expect(result.events?.[1]!.provider_code).toBe('21700');
  });

  it.each(['31.02.2026 12:00', '29.03.2026 24:00', '2026-03-29T12:60:00', '2026-03-29T12:00:00Z', '29.03.2026'])('never normalizes malformed or unsupported clock %s', value => {
    expect(ukrposhtaWallClock(value)).toBeNull();
  });

  it('preserves a current unknown code without borrowing older delivered progress', () => {
    const pair = fixture();
    pair.overview.result[0].event = pair.history.result[0].gtt_event = 'constructor';
    const result = parsed(pair);
    expect(result.status).toBe('unknown');
    expect(result.current_stage).toBeUndefined();
    expect(result.events?.[0]!.stage).toBeUndefined();
  });

  it.each(['multiple', 'empty', 'malformed date flag', 'malformed rows', 'malformed clock', 'too many'])('rejects %s without inventing absence', mode => {
    const pair = fixture();
    if (mode === 'multiple') pair.history.from_to.ISSEVERALPLACES = 1;
    if (mode === 'empty') pair.history.result = [];
    if (mode === 'malformed date flag') pair.history.date_by_barcode = 'false';
    if (mode === 'malformed rows') pair.history.result[4] = null;
    if (mode === 'malformed clock') pair.history.result[4].gtt_date = {};
    if (mode === 'too many') { pair.history.result = Array(501).fill(pair.history.result[0]); pair.overview.result[0].step = 501; }
    expect(() => parsed(pair)).toThrow();
  });

  it('keeps unbound not-found and verification replies distinct', () => {
    expect(() => parseUkrposhtaOverview(fixture('unknown'), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    expect(() => parseUkrposhtaOverview({ result: [] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: undefined }));
    expect(() => parseUkrposhtaOverview({ code: 'captcha_failed' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseUkrposhtaOverview({ result: {} }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('deduplicates only fully projected repeats after validating the native count', () => {
    const pair = fixture(); pair.history.result.splice(2, 0, pair.history.result[2]); pair.overview.result[0].step++;
    expect(parsed(pair).events).toHaveLength(5);
  });

  it('caps projected output after validating every row and preserving older return cues', () => {
    const pair = fixture();
    pair.history.result.splice(1, 0, ...Array.from({ length: 101 }, (_, index) => ({ ...pair.history.result[2],
      gtt_event_name: `Return: Departed from example facility ${index}` })));
    pair.overview.result[0].step = pair.history.result.length;
    expect(parsed(pair).events).toHaveLength(100);
    pair.history.result.at(-1).gtt_event_name = {};
    expect(() => parsed(pair)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('validates input before any browser operation and preserves exact output identities', () => {
    expect(normalizeUkrposhtaNumber(' 000 0000 0000 91 ')).toBe(NUMBER);
    expect(normalizeUkrposhtaNumber('rr000000005ua')).toBe('RR000000005UA');
    expect(() => normalizeUkrposhtaNumber('RR000000009UA')).toThrow(InvalidInputError);
    expect(() => normalizeUkrposhtaNumber('1234567890123&extra=1')).toThrow(InvalidInputError);
  });
});

function browserSeam(pair = fixture(), number = NUMBER) {
  const frame = {}, replies = [pair.overview, pair.history];
  let current = 0;
  const page = {
    mainFrame: () => frame,
    waitForResponse: vi.fn(async () => {
      const index = current++;
      const input = index === 0 ? `${number},${number}` : number;
      return { url: () => UKRPOSHTA_API, status: (): number => 200, headers: () => ({}),
        request: () => ({ method: () => 'POST', frame: () => frame, postDataJSON: () => ({ barcode: input, lang: 'EN' }) }),
        body: async () => Buffer.from(JSON.stringify(replies[index])) };
    }),
    goto: vi.fn(async (url: string, options?: unknown) => { void url; void options; return { status: (): number => 200 }; }),
  };
  const context = { route: vi.fn(), newPage: vi.fn(async () => page) };
  const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => {}) };
  const launch = vi.spyOn(chromium, 'launch').mockResolvedValue(browser as never);
  return { page, context, browser, launch };
}

const statuses = () => fixture('statuses');
const statusApi = (body: unknown = statuses(), status = 200, headers: Record<string, string> = {}) =>
  vi.fn<typeof fetch>().mockImplementation(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }));
// The status API refuses its credential, so the lookup goes on to the browser.
const viaBrowser = (options: ConstructorParameters<typeof UkrposhtaTracker>[0] = {}) =>
  new UkrposhtaTracker({ executablePath: '/synthetic/chromium', fetcher: statusApi('<html>403 Forbidden</html>', 403), ...options });

describe('Ukrposhta status API projection', () => {
  it('reads the oldest-first reply as the portal history, with second precision', () => {
    const result = normalizeCarrierResult(parseUkrposhtaStatuses(statuses(), NUMBER));
    const portal = parsed();
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_update: null });
    expect(result.events?.map(event => [event.stage, event.provider_code, event.provider_leg])).toEqual(
      portal.events?.map(event => [event.stage, event.provider_code, event.provider_leg]));
    expect(result.events?.[0]).toMatchObject({ local_time: '2026-03-29T16:03:37', description: 'Return: Delivered to Sender' });
    expect(result.events?.every(event => event.local_time && !event.time)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('dates scans in Ukraine on Kyiv time to the minute both sources share, and keeps other clocks local', () => {
    const countries = ['UKRAINE', '', 'EXAMPLE COUNTRY', 'Ukraine', 'UKRAINE'];
    const rows = statuses(); rows.forEach((row: Record<string, unknown>, index: number) => { row.country = countries[index]; });
    const api = parseUkrposhtaStatuses(rows, NUMBER);
    expect(api.last_update).toBe('2026-03-29T16:03:00+03:00');
    expect(api.events?.map(event => event.time ?? event.local_time)).toEqual(['2026-03-29T16:03:00+03:00',
      '2026-03-28T13:32:00+02:00', '2026-03-28T11:27:44', '2026-03-27T10:34:44', '2026-03-25T18:11:00+02:00']);
    expect(api.events?.filter(event => event.time).every(event => !event.local_time)).toBe(true);
    const pair = fixture(); pair.overview.result[0].country = countries[4];
    pair.history.result.forEach((row: Record<string, unknown>, index: number) => { row.gtt_country = countries[4 - index]; });
    const portal = parseUkrposhtaHistory(pair.history, parseUkrposhtaOverview(pair.overview, NUMBER));
    const dated = (result: typeof api) => result.events?.filter(event => event.time)
      .map(event => [event.time, event.description, event.location, event.provider_code]);
    expect(portal.last_update).toBe(api.last_update);
    expect(dated(portal)).toEqual(dated(api));
    // The delivery back to the sender dates no delivery.
    expect(api).toMatchObject({ current_stage: 'returned' });
    expect(api.delivered_at).toBeUndefined();
  });

  it('keeps the country of an office of exchange and of scans abroad, which the API names "TERMINAL"', () => {
    const rows = statuses().slice(0, 3);
    Object.assign(rows[0], { name: 'TERMINAL', country: 'UKRAINE' });
    Object.assign(rows[1], { name: 'Terminal', country: '' });
    Object.assign(rows[2], { event: '29200', eventName: 'Item into sorting centre', name: '', country: 'EXAMPLE COUNTRY' });
    const events = parseUkrposhtaStatuses(rows, NUMBER).events ?? [];
    expect(events.map(event => [event.location, event.stage])).toEqual([
      ['EXAMPLE COUNTRY', 'in_transit'], [undefined, events[1]!.stage], ['UKRAINE', events[2]!.stage]]);
    expect(events[1]).not.toHaveProperty('location');
  });

  it('dates a delivery in Ukraine, but not one abroad', () => {
    const rows = statuses().slice(0, 2);
    Object.assign(rows[1], { event: '41000', eventName: 'Delivered to Recipient', country: 'UKRAINE', date: '2026-03-29T16:03:37' });
    expect(parseUkrposhtaStatuses(rows, NUMBER)).toMatchObject({ current_stage: 'delivered',
      last_update: '2026-03-29T16:03:00+03:00', delivered_at: '2026-03-29T16:03:00+03:00' });
    rows[1].country = 'EXAMPLE COUNTRY';
    expect(parseUkrposhtaStatuses(rows, NUMBER)).not.toHaveProperty('delivered_at');
  });

  it.each(['2026-03-29T03:30:12', '2026-10-25T03:30:12'])('keeps a Kyiv wall clock the clocks skip or repeat local: %s', date => {
    const rows = statuses(); Object.assign(rows[4], { country: 'UKRAINE', date });
    const result = parseUkrposhtaStatuses(rows, NUMBER);
    expect(result.last_update).toBeNull();
    expect(result.events?.[0]).toMatchObject({ local_time: date });
    expect(result.events?.[0]).not.toHaveProperty('time');
  });

  it('orders by position, whatever order the reply or its clocks arrive in', () => {
    const rows = statuses().reverse();
    rows[0].date = '2020-01-01T00:00:00';
    expect(parseUkrposhtaStatuses(rows, NUMBER).events?.[0]).toMatchObject({ provider_code: '41000', local_time: '2020-01-01T00:00:00' });
  });

  it('follows a return under the Ukrainian wording too', () => {
    const rows = statuses();
    for (const row of rows) row.eventName = String(row.eventName).replace(/^Return: /, 'Повернення. ');
    rows[1].eventName = 'Повернення. Відмова одержувача';
    expect(parseUkrposhtaStatuses(rows, NUMBER)).toMatchObject({ status: 'exception', current_stage: 'returned' });
  });

  it.each(['identity', 'missing identity', 'duplicate position', 'position', 'code', 'reason', 'label', 'row', 'envelope', 'too many'])('rejects a changed %s', mode => {
    const rows: unknown[] = statuses(), row = rows[2] as Record<string, unknown>;
    if (mode === 'identity') row.barcode = '0000000000092';
    if (mode === 'missing identity') delete row.barcode;
    if (mode === 'duplicate position') row.step = 1;
    if (mode === 'position') row.step = '3';
    if (mode === 'code') row.event = null;
    if (mode === 'reason') row.eventReason_id = {};
    if (mode === 'label') row.eventName = '';
    if (mode === 'row') rows[2] = null;
    const payload = mode === 'envelope' ? { result: rows } : mode === 'too many' ? Array.from({ length: 501 }, (_, step) => ({ ...row, step: step + 1 })) : rows;
    expect(() => parseUkrposhtaStatuses(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an empty history inconclusive', () => {
    expect(() => parseUkrposhtaStatuses([], NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });
});

describe('Ukrposhta direct status API retrieval', () => {
  it("asks once with the app's bearer and starts no browser", async () => {
    const seam = browserSeam(), fetcher = statusApi(), recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const instance = adapter({ browserExecutablePath: '/synthetic/chromium', trawl: null, recorder, fetcher, userAgent: 'Host/1.0', env: {} });
    await expect(instance.track({ number: NUMBER })).resolves.toMatchObject({ current_stage: 'returned' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${UKRPOSHTA_STATUS_API}?barcode=${NUMBER}&lang=en`);
    expect(Object.fromEntries(new Headers(init!.headers))).toEqual({ accept: 'application/json',
      authorization: expect.stringMatching(/^Bearer [\w-]{8,}$/), 'user-agent': 'Host/1.0' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(seam.launch).not.toHaveBeenCalled();
    expect(recorder.step).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ step: 'direct', outcome: 'ok' }));
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [500, 'indeterminate']] as const)('hands HTTP %s to the browser', async (status, kind) => {
    const seam = browserSeam(), recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const tracker = new UkrposhtaTracker({ executablePath: '/synthetic/chromium', fetcher: statusApi('<html>403 Forbidden</html>', status), recorder });
    await expect(tracker.fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'returned' });
    expect(seam.launch).toHaveBeenCalledOnce();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'direct', outcome: kind }));
    await expect(new UkrposhtaTracker({ fetcher: statusApi('<html>403 Forbidden</html>', status) }).fetch(NUMBER)).rejects.toMatchObject({ kind });
  });

  it('leaves an unknown domestic barcode inconclusive and gives an international one its second source', async () => {
    const international = 'RR000000005UA';
    const seam = browserSeam({ overview: fixture('unknown'), history: fixture().history }, international);
    const unknown = () => statusApi({ message: 'Shipment not found' }, 404);
    const options = { executablePath: '/synthetic/chromium' };
    await expect(new UkrposhtaTracker({ ...options, fetcher: unknown() }).fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'status_api_not_found' });
    expect(seam.launch).not.toHaveBeenCalled();
    // Neither source has it: the portal's miss is the answer, and says so.
    await expect(new UkrposhtaTracker({ ...options, fetcher: unknown() }).fetch(international))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    expect(seam.launch).toHaveBeenCalledOnce();
  });

  it('recognizes through the status API alone, reading its miss as unknown only for a domestic barcode', async () => {
    const seam = browserSeam();
    const recognize = (fetcher: typeof fetch, number = NUMBER, budgetMs?: number) =>
      adapter({ browserExecutablePath: '/synthetic/chromium', trawl: null, recorder: NOOP_RECORDER, fetcher, env: {} }).recognize!(number, { budgetMs });
    await expect(recognize(statusApi())).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-29T16:03:37' });
    // A recognition budget past the lookup's minute still asks.
    await expect(recognize(statusApi(), NUMBER, 120_000)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-29T16:03:37' });
    await expect(recognize(statusApi({ message: 'Shipment not found' }, 404))).resolves.toEqual({ known: false });
    await expect(recognize(statusApi({ message: 'Shipment not found' }, 404), 'RR000000005UA')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(recognize(statusApi([]))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(recognize(statusApi('<html>403 Forbidden</html>', 403))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(recognize(statusApi({ message: 'no Route matched' }, 404))).rejects.toMatchObject({ kind: 'transport' });
    expect(seam.launch).not.toHaveBeenCalled();
    const fetcher = statusApi();
    await expect(recognize(fetcher, 'RR000000006UA')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps rate limits, a missing endpoint and changed replies apart from absence', async () => {
    browserSeam();
    const run = (fetcher: typeof fetch) => new UkrposhtaTracker({ fetcher }).fetch(NUMBER);
    await expect(run(statusApi('{}', 429, { 'retry-after': '20' }))).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 20_000 });
    await expect(run(statusApi({ message: 'no Route matched' }, 404))).rejects.toMatchObject({ kind: 'transport' });
    await expect(run(statusApi('<html></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(run(statusApi({ message: 'Shipment not found' }))).rejects.toMatchObject({ kind: 'schema' });
  });
});

describe('Ukrposhta bounded anonymous browser retrieval', () => {
  it('uses a fresh context and two native requests inside one recorded lookup', async () => {
    const seam = browserSeam(), recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const fetcher = statusApi('<html>403 Forbidden</html>', 403);
    const instance = adapter({ browserExecutablePath: '/synthetic/chromium', trawl: null, recorder, fetcher, env: {} });
    await expect(instance.track({ number: NUMBER }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'returned' });
    expect(seam.page.goto.mock.calls.map(call => call[0])).toEqual([ukrposhtaTrackingUrl(`${NUMBER},${NUMBER}`), ukrposhtaTrackingUrl(NUMBER)]);
    expect(Object.keys(seam.launch.mock.calls[0]![0]!.env!)).toEqual(['PATH', 'HOME', 'LANG']);
    expect(seam.browser.newContext).toHaveBeenCalledWith({ locale: 'en-US', acceptDownloads: false, serviceWorkers: 'block' });
    expect(seam.browser.close).toHaveBeenCalledOnce();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'browser', outcome: 'ok' }));
  });

  it('stops after an inconclusive overview without requesting history', async () => {
    const seam = browserSeam({ overview: fixture('unknown'), history: fixture().history });
    await expect(viaBrowser().fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(seam.page.goto).toHaveBeenCalledOnce();
    expect(seam.browser.close).toHaveBeenCalledOnce();
  });

  it('does not begin the second request after the lookup deadline', async () => {
    const seam = browserSeam(), clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    seam.page.goto.mockImplementation(async () => { clock.mockReturnValue(5001); return { status: () => 200 }; });
    await expect(viaBrowser().fetch(NUMBER, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'budget' });
    expect(seam.page.goto).toHaveBeenCalledOnce();
  });

  it('records a page timeout that lands on the lookup deadline as the budget running out', async () => {
    const seam = browserSeam(), clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    // The browser is handed the remaining budget rounded down, so its own timer fires just before the deadline.
    seam.page.goto.mockImplementation(async () => { clock.mockReturnValue(4998); throw new Error('page.goto: Timeout 4998ms exceeded.'); });
    await expect(viaBrowser({ recorder }).fetch(NUMBER, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'budget' });
    expect(recorder.step.mock.calls.map(call => call[0])).toEqual([expect.objectContaining({ step: 'direct', outcome: 'challenge' }),
      expect.objectContaining({ step: 'browser', outcome: 'budget' })]);
    expect(seam.browser.close).toHaveBeenCalledOnce();
  });

  it('rejects a captured response submitted for another parcel', async () => {
    const seam = browserSeam();
    const original = await seam.page.waitForResponse();
    seam.page.waitForResponse.mockResolvedValue({ ...original, request: () => ({ ...original.request(), postDataJSON: () => ({ barcode: '0000000000092', lang: 'EN' }) }) });
    await expect(viaBrowser().fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([404, 410, 429])('keeps native API HTTP %s separate from parcel absence', async status => {
    const seam = browserSeam(), original = await seam.page.waitForResponse();
    seam.page.waitForResponse.mockResolvedValue({ ...original, status: () => status, headers: () => ({ 'retry-after': '7' }) });
    await expect(viaBrowser().fetch(NUMBER)).rejects.toMatchObject({ status,
      kind: status === 429 ? 'rate_limited' : 'transport' });
  });

  it.each([404, 410])('treats tracking page HTTP %s as a transport failure', async status => {
    const seam = browserSeam(); seam.page.goto.mockResolvedValue({ status: () => status });
    await expect(viaBrowser().fetch(NUMBER)).rejects.toMatchObject({ status, kind: 'transport' });
    expect(seam.browser.close).toHaveBeenCalledOnce();
  });

  it.each(['declared size', 'actual size', 'invalid JSON'])('rejects a captured %s before returning progress', async mode => {
    const seam = browserSeam(), original = await seam.page.waitForResponse();
    seam.page.waitForResponse.mockResolvedValue({ ...original,
      headers: () => mode === 'declared size' ? { 'content-length': '1000001' } : {},
      body: async () => mode === 'actual size' ? Buffer.alloc(1000001) : Buffer.from('invalid JSON') });
    await expect(viaBrowser().fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    expect(seam.browser.close).toHaveBeenCalledOnce();
  });

  it('closes the browser when a pending native response is cancelled', async () => {
    const seam = browserSeam(), controller = new AbortController();
    let submitted!: () => void;
    const ready = new Promise<void>(resolve => { submitted = resolve; });
    seam.page.waitForResponse.mockImplementation(() => new Promise(() => {}));
    seam.page.goto.mockImplementation(async () => { submitted(); return { status: () => 200 }; });
    const pending = viaBrowser().fetch(NUMBER, { signal: controller.signal });
    await ready; controller.abort(new Error('Synthetic cancellation'));
    await expect(pending).rejects.toThrow('Synthetic cancellation');
    expect(seam.browser.close).toHaveBeenCalled();
  });

  it('rejects launch cancellation promptly and closes a late browser before the next lookup gets its turn', async () => {
    const seam = browserSeam(), controller = new AbortController();
    let resolveLaunch!: (browser: Browser) => void;
    let resolveClose!: () => void;
    seam.launch.mockImplementation(() => new Promise(resolve => { resolveLaunch = resolve; }));
    seam.browser.close.mockImplementation(() => new Promise(resolve => { resolveClose = resolve; }));
    const tracker = viaBrowser();
    const pending = tracker.fetch(NUMBER, { signal: controller.signal });
    await vi.waitFor(() => expect(seam.launch).toHaveBeenCalledOnce());
    controller.abort(new Error('Cancelled during launch'));
    await expect(pending).rejects.toThrow('Cancelled during launch');
    // A waiting lookup spends its own budget; it never starts a second browser.
    await expect(tracker.fetch(NUMBER, { budgetMs: 20 })).rejects.toMatchObject({ kind: 'budget' });
    expect(seam.launch).toHaveBeenCalledOnce();
    resolveLaunch(seam.browser as never);
    await vi.waitFor(() => expect(seam.browser.close).toHaveBeenCalledOnce());
    await expect(tracker.fetch(NUMBER, { budgetMs: 20 })).rejects.toMatchObject({ kind: 'budget' });
    expect(seam.browser.newContext).not.toHaveBeenCalled();
    seam.launch.mockResolvedValue(seam.browser as never);
    seam.browser.close.mockResolvedValue();
    const queued = tracker.fetch(NUMBER);
    resolveClose();
    await expect(queued).resolves.toMatchObject({ current_stage: 'returned' });
  });

  it.each(['context', 'page'])('rejects cancellation during %s setup and closes its browser', async phase => {
    const seam = browserSeam(), controller = new AbortController();
    let began!: () => void;
    const ready = new Promise<void>(resolve => { began = resolve; });
    if (phase === 'context') seam.browser.newContext.mockImplementation(() => { began(); return new Promise(() => {}); });
    else seam.context.newPage.mockImplementation(() => { began(); return new Promise(() => {}); });
    const pending = viaBrowser().fetch(NUMBER, { signal: controller.signal });
    await ready; controller.abort(new Error(`Cancelled during ${phase} setup`));
    await expect(pending).rejects.toThrow(`Cancelled during ${phase} setup`);
    expect(seam.browser.close).toHaveBeenCalledOnce();
    expect(seam.page.goto).not.toHaveBeenCalled();
  });

  it('performs no browser work for invalid or pre-aborted input', async () => {
    const seam = browserSeam();
    expect(() => viaBrowser().fetch('invalid')).toThrow(InvalidInputError);
    await expect(viaBrowser().fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(seam.launch).not.toHaveBeenCalled();
  });
});
