import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, STALLION_ENDPOINT, StallionTracker } from './adapter.js';
import { normalizeStallionNumber, parseStallion } from './parser.js';
import { stallionScanStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const INTELCOM = 'SE991231ZZ01';
const INTELCOM_CODE = '991231ZZ01';
const USPS_CODE = '991230ZZ02';
const USPS_NUMBER = '9400100000000000000017';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string): Record<string, unknown> => JSON.parse(text(name));
// The site sends its JSON as HTML.
const reply = (name: string) => new Response(text(name), { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (payload: Record<string, unknown>) => payload.events as Record<string, unknown>[];
const details = (payload: Record<string, unknown>) => payload.details as Record<string, unknown>;
const throttle = (seconds?: number) => new Response(JSON.stringify({ message: 'Too many requests', rateLimit: 120,
  ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }) }), { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });

afterEach(() => {
  vi.useRealTimers();
});

describe('Stallion Express HTTP adapter', () => {
  it('posts the whole number to the tracking page’s action once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('intelcom-delivered'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new StallionTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' se 991231 zz01 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(STALLION_ENDPOINT);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(String(init!.body)).toBe(`tracking_number=${INTELCOM}&action=se_track_form_submission`);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'stallion-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads Intelcom’s scans back on Intelcom’s clock and keeps Stallion’s own, without the ship-to town or phone', () => {
    const result = parseStallion(fixture('intelcom-delivered'), INTELCOM);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-12T17:41:05Z', delivered_at: '2026-03-12T17:41:05Z', expected_delivery: null,
      service_name: 'Intelcom Standard', delivery_carrier: 'intelcom', destination_country: 'CA' });
    expect(result.delivery_tracking_number).toBeUndefined();
    expect(result.events!.map((event) => [event.time, event.description, event.stage, event.location ?? null])).toEqual([
      ['2026-03-12T17:41:05Z', 'Delivered', 'delivered', 'Exampleton, ON, CA'],
      ['2026-03-12T17:40:05Z', 'Completed Unloading at Delivery Location', 'delivered', 'Exampleton, ON, CA'],
      ['2026-03-12T10:12:30Z', 'Loaded on Truck', 'out_for_delivery', 'Exampleton, ON, CA'],
      ['2026-03-12T06:05:52Z', 'Arrived at Terminal Location', 'in_transit', 'Sampleford, ON, Canada'],
      ['2026-03-11T23:50:11Z', 'In-transit from Hubton ON, CA', 'in_transit', 'Hubton ON, CA'],
      ['2026-03-11T19:15:40Z', 'Received from Prior Carrier', 'in_transit', 'Hubton, ON, Canada'],
      ['2026-03-11T02:20:44Z', 'Received at Hubton ON, CA', 'in_transit', 'Hubton ON, CA'],
      ['2026-03-10T22:02:17Z', 'In-transit from Dropville ON, CA', 'in_transit', 'Dropville ON, CA'],
      ['2026-03-10T19:31:09Z', 'Received at Dropville ON, CA', 'accepted', 'Dropville ON, CA'],
      ['2026-03-10T17:47:58Z', 'Tendered for Delivery', 'registered', null],
      ['2026-03-10T17:46:57Z', 'Label created', 'registered', null],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/555-0100|track-your-package/);
  });

  it('reads Intelcom’s winter scans five hours back', () => {
    const payload = fixture('intelcom-delivered');
    rows(payload)[0]!.datetime = '2026-01-15T03:00:00.000000Z';
    expect(parseStallion(payload, INTELCOM).events!.find((event) => event.description === 'Delivered')).toMatchObject({ time: '2026-01-14T22:00:00Z' });
  });

  it('names the partner and its number for a shipment code handed to USPS, and drops an undated announcement', () => {
    const result = parseStallion(fixture('usps-held'), USPS_CODE);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', current_stage_source: 'wording:language',
      last_status_text: 'Held at Post Office, At Customer Request', last_update: '2026-07-03T18:12:40Z',
      service_name: 'USPS Ground Advantage', delivery_carrier: 'usps', delivery_tracking_number: USPS_NUMBER, destination_country: 'US' });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events!.map((event) => [event.time, event.stage, event.location ?? null])).toEqual([
      ['2026-07-03T18:12:40Z', 'ready_for_pickup', 'SAMPLETOWN'],
      ['2026-07-03T12:30:15Z', 'out_for_delivery', 'SAMPLETOWN'],
      ['2026-07-02T20:44:03Z', 'in_transit', 'EXAMPLE CITY NJ DISTRIBUTION CENTER'],
      ['2026-07-01T13:02:27Z', 'in_transit', null],
      ['2026-06-30T15:21:09Z', 'in_transit', 'BORDERVILLE'],
      ['2026-06-30T03:00:00Z', 'in_transit', 'Coastville BC, CA'],
      ['2026-06-30T01:10:32Z', 'registered', 'BORDERVILLE'],
      ['2026-06-29T21:05:50Z', 'accepted', 'Coastville BC, CA'],
    ]);
    expect(JSON.stringify(result)).not.toContain('Sampletown, NJ');
  });

  it('reports the SE number Intelcom delivers under when asked by the shipment code', () => {
    expect(parseStallion(fixture('intelcom-delivered'), INTELCOM_CODE))
      .toMatchObject({ delivery_carrier: 'intelcom', delivery_tracking_number: INTELCOM });
  });

  it('names a partner only when Stallion’s link to its tracker agrees with its name', () => {
    const unlinked = fixture('usps-held');
    details(unlinked).url = '';
    expect(parseStallion(unlinked, USPS_CODE).delivery_carrier).toBeUndefined();
    const elsewhere = fixture('usps-held');
    for (const row of rows(elsewhere)) row.carrier = 'APC';
    details(elsewhere).url = `https://example.invalid/track/${USPS_NUMBER}`;
    const result = parseStallion(elsewhere, USPS_CODE);
    expect(result.delivery_carrier).toBeUndefined();
    expect(result.delivery_tracking_number).toBe(USPS_NUMBER);
  });

  it('binds the reply to Stallion’s own code, never to a partner number alone', () => {
    // An SE number that is not the label's own tracking number.
    const handed = fixture('usps-held');
    expect(() => parseStallion(handed, `SE${USPS_CODE}`)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // A ten-character code that is another shipment's partner number.
    const partner = fixture('usps-held');
    details(partner).tracking = '991229ZZ03';
    expect(() => parseStallion(partner, '991229ZZ03')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const other = fixture('intelcom-delivered');
    details(other).ship_code = '991231ZZ09';
    details(other).tracking = 'SE991231ZZ09';
    expect(() => parseStallion(other, INTELCOM)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('drops repeated scans, leaves unknown wording to the shared rules and rejects a changed reply', () => {
    expect(parseStallion(fixture('intelcom-delivered'), INTELCOM).events).toHaveLength(11);
    const unknown = fixture('usps-held');
    rows(unknown)[0]!.status = 'Package acknowledged';
    expect(parseStallion(unknown, USPS_CODE).events![0]).toEqual({ time: '2026-07-03T18:12:40Z', description: 'Package acknowledged', location: 'SAMPLETOWN' });
    for (const change of [
      (payload: Record<string, unknown>) => { rows(payload)[2]!.datetime = '2026-03-12 14:12:30'; },
      (payload: Record<string, unknown>) => { rows(payload)[2]!.status = { text: 'Loaded on Truck' }; },
      (payload: Record<string, unknown>) => { rows(payload)[2]!.carrier = 7; },
      (payload: Record<string, unknown>) => { payload.events = {}; },
      (payload: Record<string, unknown>) => { payload.details = null; },
    ]) {
      const payload = fixture('intelcom-delivered');
      change(payload);
      expect(() => parseStallion(payload, INTELCOM)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const empty = fixture('intelcom-delivered');
    empty.events = [];
    expect(() => parseStallion(empty, INTELCOM)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps an unknown number, the site’s throttle and other replies apart', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: INTELCOM });
    await expect(lookup(reply('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // Too long a wait for the budget left: the throttle is the answer at once.
    const limited = vi.fn<typeof fetch>().mockResolvedValue(reply('rate-limited'));
    await expect(carrier(limited).track({ number: INTELCOM }, { budgetMs: 12_000 })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 11_000 });
    expect(limited).toHaveBeenCalledOnce();
    for (const body of ['{"success":false,"errors":["Something went wrong"]}', '{"success":false,"errors":["No shipment found","Try again"]}',
      '{"message":""}', '0', '{"success":"true"}']) {
      await expect(lookup(new Response(body))).rejects.toMatchObject({ kind: 'indeterminate' });
    }
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}', { status }));
      await expect(carrier(fetcher).track({ number: INTELCOM })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(INTELCOM)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps blocked HTTP 200 pages and malformed replies apart from missing parcels', async () => {
    for (const [body, kind] of [['<html><title>Just a moment...</title></html>', 'challenge'], ['<html>Maintenance</html>', 'schema'], ['[]', 'schema']]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      await expect(carrier(fetcher).recognize!(INTELCOM)).rejects.toMatchObject({ kind });
    }
  });

  it('recognizes a known shipment and the unknown-number answer, and asks nothing for a number Stallion does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('intelcom-delivered')).mockResolvedValueOnce(reply('not-found'));
    await expect(carrier(fetcher).recognize!(INTELCOM)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-12T17:41:05.000Z' });
    await expect(carrier(fetcher).recognize!(INTELCOM)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(USPS_NUMBER)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Stallion does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of [USPS_NUMBER, '991331ZZ01', '991200ZZ01', '991231ZZ0', 'SE991231ZZ011', 'SX991231ZZ01', 'FSTE991231000000001']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: INTELCOM }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeStallionNumber('se-991231-zz01')).toEqual({ number: INTELCOM, shipCode: INTELCOM_CODE });
    expect(normalizeStallionNumber('9912319999')).toEqual({ number: '9912319999', shipCode: '9912319999' });
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply('usps-held'));
    await expect(carrier(fetcher).track({ number: USPS_CODE }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'ready_for_pickup' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('sends a throttled lookup once more when the wait the site names is over', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(throttle(2)).mockResolvedValueOnce(reply('intelcom-delivered'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const answer = new StallionTracker({ fetcher, recorder }).fetch(INTELCOM, { budgetMs: 8_000 });
    // The named seconds and one more for their rounding.
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]![1]!.body)).toBe(`tracking_number=${INTELCOM}&action=se_track_form_submission`);
    expect(recorder.step).toHaveBeenLastCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok', fallbackFrom: 'direct', fallbackReason: 'rate_limited' }));
  });

  it('keeps the throttle when the lookup sent again is throttled too', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(throttle(0)).mockResolvedValueOnce(throttle(4)).mockResolvedValue(reply('intelcom-delivered'));
    const failure = expect(carrier(fetcher).track({ number: INTELCOM }, { budgetMs: 15_000 })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 4_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    await failure;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('answers a throttle at once when it names no wait, a long one or one past the budget', async () => {
    for (const [response, budgetMs] of [[throttle(), 60_000], [throttle(61), 600_000], [throttle(5), 7_000]] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response).mockResolvedValue(reply('intelcom-delivered'));
      await expect(carrier(fetcher).track({ number: INTELCOM }, { budgetMs })).rejects.toMatchObject({ kind: 'rate_limited' });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('stops waiting out the throttle when the caller cancels', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(throttle(3)).mockResolvedValue(reply('intelcom-delivered'));
    const failure = expect(carrier(fetcher).track({ number: INTELCOM }, { signal: controller.signal, budgetMs: 10_000 }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 3_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(new Error('cancelled'));
    await failure;
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: INTELCOM }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a shipment filed under Stallion Express to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('intelcom-delivered'));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: INTELCOM, carrier: 'stallion-express' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'stallion-express', source: 'stallion-express', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === STALLION_ENDPOINT)).toBe(true);
  });
});

describe('Stallion Express status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(stallionScanStage(entry.wording)).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'stallion-express', description: 'Received at Sampleton ON, CA' })).toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'stallion-express', description: 'Out for Delivery' })).toEqual({ kind: 'unknown' });
    expect(statusMap.stage('7', 'delivered')).toBeUndefined();
  });
});
