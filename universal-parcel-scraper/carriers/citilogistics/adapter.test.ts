import { describe, expect, it, vi } from 'vitest';
import { carrierErrorKind } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, CitilogisticsTracker } from './adapter.js';
import { CITI_PAGE, citiForm, normalizeCitiNumber, parseCiti } from './parser.js';
import { citiStage, statusMap } from './status.js';

const NUMBER = '87000000001';
const NONCE = 'a'.repeat(32), SECOND_NONCE = 'b'.repeat(32);
const COOKIE = 'synthetic-guest-session';
const form = (number = '', nonce = NONCE) => `<form class="track-submit" method="get" action="//tracking.citilogistics.ca"><input type="hidden" name="n" value="${nonce}"><input name="trackid" value="${number}"></form>`;
const row = (day: string, time: string, description: string, zone = 'Canada/Eastern', place = 'Synthetic depot') =>
  `<tr><td>${day}</td><td>${time}</td><td>${place}</td><td>${description}</td><td>${zone}</td></tr>`;
const rows = row('2025-07-30', '09:32', 'Delivered', 'Canada/Pacific')
  + row('2025-07-24', '15:47', 'Item received in sort facility')
  + row('2025-07-21', '15:31', 'item imported');
const history = (scans = rows, number = NUMBER) => `${form(number)}<h4>Tracking Info as of Friday, Jan 01 2099 10:00am EST</h4><table class="table table-hover"><thead><tr><th>Event Date</th><th>Time</th><th>Location</th><th>Description</th><th>Time Zone</th></tr></thead><tbody>${scans}</tbody></table>`;
const absent = (number = NUMBER) => `${form(number)}<div class="alert alert-danger"><button>×</button>Invalid tracking number or No tracking info available.</div>`;
const reply = (body: string, status = 200, headers: HeadersInit = {}) => Object.defineProperty(new Response(body, { status, headers }), 'url', { value: CITI_PAGE });
const tracker = (fetcher: typeof fetch) => new CitilogisticsTracker({ fetcher });

describe('Citilogistics guest tracking', () => {
  it('keeps scan clocks and each stated zone, and ignores lookup time', () => {
    const result = parseCiti(history() + '<a href="/private?auth=synthetic-capability">Synthetic recipient</a>', NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update: '2025-07-30T09:32:00-07:00', last_status_text: 'Delivered', expected_delivery: null });
    expect(result.events).toHaveLength(3);
    expect(result.events![0]).toMatchObject({ local_time: '2025-07-30T09:32:00', time_zone: 'Canada/Pacific', time_zone_basis: 'carrier' });
    expect(result.events![1]).toMatchObject({ time: '2025-07-24T15:47:00-04:00', time_zone: 'Canada/Eastern', stage: 'in_transit' });
    expect(result.events![2]!.stage).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/2099|Synthetic recipient|synthetic-capability|private|auth|trackid/);
    expect(citiStage('item imported')).toBeNull();
    expect(statusMap.gaps).toHaveLength(1);
    expect(statusMap.stage(null, 'Delivered')).toBe('delivered');
  });

  it('sorts real instants across zones, keeps tied milestones and removes exact duplicates', () => {
    const a = row('2025-07-30', '10:00', 'Delivered', 'Canada/Eastern');
    const b = row('2025-07-30', '09:00', 'Item received in sort facility', 'Canada/Pacific');
    const c = row('2025-07-30', '09:00', 'item imported', 'Canada/Pacific');
    const events = parseCiti(history(a + b + b + c), NUMBER).events!;
    expect(events.map(e => e.description)).toEqual(['Item received in sort facility', 'item imported', 'Delivered']);
  });

  it('rejects invalid calendars and DST gaps; chooses the first repeated clock', () => {
    for (const [day, time, zone] of [['2025-02-30', '09:00', 'Canada/Eastern'], ['2025-03-09', '02:30', 'Canada/Eastern'], ['2025-01-01', '24:00', 'Canada/Eastern'], ['2025-01-01', '01:00', 'EST']]) {
      expect(() => parseCiti(history(row(day!, time!, 'Delivered', zone)), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(parseCiti(history(row('2025-11-02', '01:30', 'Delivered')), NUMBER).events![0]!.time).toBe('2025-11-02T01:30:00-04:00');
  });

  it('requires the whole echoed query and a unique official form and history', () => {
    for (const html of [history(rows, NUMBER + '7'), history(rows, '87000000002'), history() + history()]) {
      expect(() => parseCiti(html, NUMBER)).toThrow();
    }
    for (const html of [form().replace('//tracking.citilogistics.ca', 'https://foreign.invalid'), form().replace(NONCE, 'short'), form() + form(), form().replace('method="get"', 'method="post"')]) {
      expect(() => citiForm(html)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => normalizeCitiNumber('1234567890123456')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(normalizeCitiNumber(' cam 000000001 ')).toBe('CAM000000001');
  });

  it('keeps missing, empty and ambiguous notices inconclusive; challenge HTML stays challenge', () => {
    for (const html of [absent(), history(''), form(NUMBER)]) {
      expect(() => parseCiti(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseCiti('<title>Just a moment</title>', NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseCiti(history() + '<div class="alert alert-danger">Invalid tracking number or No tracking info available.</div>', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCiti(history().replace('Event Date', 'Renamed Date'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCiti(history(row('2025-01-01', '09:00', '')), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('limits history and marks a bounded projection incomplete', () => {
    const many = Array.from({ length: 101 }, (_, n) => row('2025-01-01', '09:00', `Unmapped scan ${n}`)).join('');
    const result = parseCiti(history(many), NUMBER);
    expect(result.history_truncated).toBe(true);
    expect(result.events).toHaveLength(100);
    expect(() => parseCiti(history(row('2025-01-01', '09:00', 'Delivered').repeat(501)), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('uses the supplied transport, guest cookie, current form state, UA and signal', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(form(), 200, { 'set-cookie': `PHPSESSID=${COOKIE}; Path=/; Secure; HttpOnly` })).mockResolvedValueOnce(reply(history()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new CitilogisticsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(NUMBER, { budgetMs: 1000.5 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]![0])).toBe(CITI_PAGE);
    const [url, init] = fetcher.mock.calls[1]!;
    const request = new URL(String(url));
    expect(request.origin + request.pathname).toBe(CITI_PAGE);
    expect(request.searchParams.get('n')).toBe(NONCE);
    expect(request.searchParams.get('trackid')).toBe(NUMBER);
    expect(new Headers(init!.headers).get('cookie')).toBe(`PHPSESSID=${COOKIE}`);
    expect(new Headers(init!.headers).get('user-agent')).toBe('SyntheticHost/1.0');
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify([result, recorder.step.mock.calls, recorder.lookup.mock.calls])).not.toMatch(new RegExp(`${NONCE}|${COOKIE}|trackid|2099`));
  });

  it('restarts the whole guest flow after a network failure without retaining state in telemetry', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(form())).mockRejectedValueOnce(new TypeError(`network ${NONCE} ${COOKIE}`))
      .mockResolvedValueOnce(reply(form('', SECOND_NONCE))).mockResolvedValueOnce(reply(history()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CitilogisticsTracker({ fetcher, recorder }).fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('n'))).toEqual([null, NONCE, null, SECOND_NONCE]);
    expect(recorder.step.mock.calls.map(([value]) => [value.step, value.outcome])).toEqual([['direct', 'transport'], ['retry', 'ok']]);
    expect(JSON.stringify(recorder.step.mock.calls)).not.toMatch(new RegExp(`${NONCE}|${COOKIE}|${SECOND_NONCE}`));
  });

  it('preserves HTTP failure kinds, retry-after and privacy without replaying a received reply', async () => {
    for (const [status, kind] of [[429, 'rate_limited'], [500, 'indeterminate'], [403, 'challenge'], [404, 'transport'], [302, 'transport']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(form())).mockResolvedValueOnce(reply(`${NONCE} ${COOKIE}`, status, { 'Retry-After': '7' }));
      const error = await tracker(fetcher).fetch(NUMBER).catch((e: unknown) => e);
      expect(carrierErrorKind(error)).toBe(kind);
      if (status === 429) expect(error).toMatchObject({ retryAfterMs: 7000 });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(error)).not.toMatch(new RegExp(`${NONCE}|${COOKIE}|trackid`));
    }
  });

  it('does not retry malformed HTML and exposes no HTTP ownership probe for ambiguous codes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(form())).mockResolvedValueOnce(reply('<html>changed</html>'));
    await expect(tracker(fetcher).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null }).recognize).toBeUndefined();
  });

  it('honors cancellation and remaining budget before starting another guest request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(tracker(fetcher).fetch(NUMBER, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    await expect(tracker(fetcher).fetch(NUMBER, { signal: AbortSignal.abort(new Error('Synthetic stop')) })).rejects.toThrow('Synthetic stop');
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    fetcher.mockImplementationOnce(async () => { controller.abort(new Error('Synthetic stop')); return reply(form()); });
    await expect(tracker(fetcher).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow('Synthetic stop');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
