import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, EQUICK_API, EquickTracker } from './adapter.js';
import { equickWording, normalizeEquickNumber, parseEquick } from './parser.js';
import { equickScanStage, equickStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

// Synthetic Equick numbers.
const TRANSIT = 'EQKPT9000000001YQ';
const DELIVERED = 'EQKML9000000002YQ';
const UNKNOWN = 'EQKPT9000000003YQ';

type Reply = { code: number; msg: string; data: Record<string, Record<string, unknown>[]> | null };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const raw = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'application/json;charset=UTF-8', ...init.headers } });
const json = (payload: unknown) => raw(JSON.stringify(payload));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** The transit fixture with its scans changed. */
const transitWith = (change: (rows: Record<string, unknown>[]) => unknown[]) => {
  const reply = fixture('transit');
  return { ...reply, data: { [TRANSIT]: change(reply.data![TRANSIT]!) } };
};
const summary = (result: ReturnType<typeof parseEquick>) => result.events!.map((event) =>
  [event.local_time, event.description, event.location ?? null, event.stage ?? null]);

describe('Equick HTTP adapter', () => {
  it('asks the tracker\'s lookup for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new EquickTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' eqkpt 9000 0000 01yq ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(EQUICK_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(JSON.parse(String(init!.body))).toEqual({ txtDanHao: TRANSIT });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'equick', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a parcel in transit with its destination', () => {
    const result = parseEquick(fixture('transit'), TRANSIT);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Arrived at original airport', last_update: null, last_update_local: '2029-12-17T14:40:56',
      expected_delivery: null, destination_country: 'NL',
    });
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(summary(result)).toEqual([
      ['2029-12-17T14:40:56', 'Arrived at original airport', 'China', 'in_transit'],
      ['2029-12-14T18:55:22', 'Departed from Equick operation center', 'China', 'in_transit'],
      ['2029-12-14T18:45:22', 'Arrived at Equick operation center', 'China', 'in_transit'],
      ['2029-12-14T18:35:22', 'Departed from Original Depot', 'China', 'in_transit'],
      // The destination carrier's notice that it has the data, after Equick took the parcel.
      ['2029-12-14T18:32:10', 'Shipment not yet received or processed', 'NETHERLANDS', 'in_transit'],
      ['2029-12-14T18:15:22', 'Arrived at SHA Depot', 'Shanghai', 'in_transit'],
      // The Status column's Hold on the pick-up sets nothing.
      ['2029-12-14T17:15:22', 'Picked up from shipper', 'China', 'accepted'],
      ['2029-12-12T00:38:03', 'Shipping Label Created', 'China', 'registered'],
    ]);
    // The clocks carry no zone: none becomes an instant.
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/9000001\d\d|Hold|In progress/);
  });

  it('reads a delivery with the delivering carrier\'s number, without who signed, phone numbers or repeated scans', () => {
    const result = parseEquick(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update_local: '2029-12-22T13:05:00',
      destination_country: 'DE', delivery_tracking_number: '09000000000002',
    });
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivered_at');
    expect(summary(result)).toEqual([
      ['2029-12-22T13:05:00', 'Delivered', 'Sampleburg', 'delivered'],
      ['2029-12-22T08:12:00', 'Out for delivery. Driver', 'Sampleburg', 'out_for_delivery'],
      ['2029-12-21T22:40:00', 'At parcel delivery centre.', 'Sampleburg', 'in_transit'],
      ['2029-12-21T09:30:00', 'Order information has been transmitted to DPD.', 'Germany', 'in_transit'],
      ['2029-12-20T16:00:00', 'Released from customs', 'Frankfurt', 'in_transit'],
      // A site the map knows by its pattern, whatever its code.
      ['2029-12-19T06:20:00', 'Arrived at FRA airport', 'Frankfurt', 'in_transit'],
      ['2029-12-18T01:10:00', 'Departed from PVG airport', 'Shanghai', 'in_transit'],
      ['2029-12-16T20:00:00', 'Arrived at SHA operation center', 'Shanghai', 'in_transit'],
      ['2029-12-16T11:00:00', 'Picked up from shipper', 'Shenzhen', 'accepted'],
      ['2029-12-15T09:00:00', 'Shipping Label Created', 'China', 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE NAME|Signed|0000000"|\+49/);
  });

  it('turns an oldest-first history round and takes the newest staged scan', () => {
    const result = parseEquick(transitWith((rows) => [...rows].reverse()), TRANSIT);
    expect(result.events![0]!.local_time).toBe('2029-12-17T14:40:56');
    const unstaged = parseEquick(transitWith((rows) => [{ ...rows[0], traceContent: 'Synthetic scan' }, ...rows.slice(1)]), TRANSIT);
    expect(unstaged).toMatchObject({ last_status_text: 'Synthetic scan', current_stage: 'in_transit' });
    expect(unstaged.events![0]).not.toHaveProperty('stage');
  });

  it('names the delivering carrier\'s number only when the scans carry one other number', () => {
    const tracking = (values: string[]) => parseEquick(transitWith((rows) => rows.map((row, index) =>
      ({ ...row, destinationWBNo: values[index] ?? '' }))), TRANSIT).delivery_tracking_number;
    expect(tracking(['09000000000002', '09000000000002'])).toBe('09000000000002');
    expect(tracking([' 0900 0000 0000 02 '])).toBe('09000000000002');
    expect(tracking([TRANSIT])).toBeUndefined();
    expect(tracking(['09000000000002', '09000000000003'])).toBeUndefined();
    expect(tracking(['SAMPLE'])).toBeUndefined();
    // A country the tracker names otherwise stays a name.
    expect(parseEquick(transitWith((rows) => rows.map((row) => ({ ...row, traceCountry: 'Sampleland' }))), TRANSIT))
      .toMatchObject({ destination_country_name: 'Sampleland' });
  });

  it('reads the tracker\'s empty result as not found, and an incomplete lookup as inconclusive', () => {
    expect(() => parseEquick(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseEquick(fixture('failed'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The answer to a request without a number.
    expect(() => parseEquick({ msg: 'success', code: 1, data: null }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseEquick(transitWith(() => []), TRANSIT)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('binds the reply to the whole number', () => {
    expect(() => parseEquick(fixture('transit'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The key echoes the number as it was sent.
    const lower = fixture('transit');
    expect(parseEquick({ ...lower, data: { [TRANSIT.toLowerCase()]: lower.data![TRANSIT]! } }, TRANSIT)).toMatchObject({ current_stage: 'in_transit' });
    expect(() => parseEquick({ ...lower, data: { [`${TRANSIT}9`]: lower.data![TRANSIT]! } }, TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseEquick(transitWith((rows) => [{ ...rows[0], traceLabelNo: DELIVERED }, ...rows.slice(1)]), TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseEquick(transitWith((rows) => [{ ...rows[0], traceLabelNo: `${TRANSIT}X` }]), TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseEquick({ ...lower, data: { [TRANSIT]: lower.data![TRANSIT]!, [TRANSIT.toLowerCase()]: [] } }, TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('drops signers and phone numbers from a scan\'s wording', () => {
    expect(equickWording('Delivered, received by SAMPLE NAME')).toBe('Delivered');
    expect(equickWording('Call +1 (555) 000-0000 to rebook')).toBe('Call to rebook');
    expect(equickWording('Scanned on 2029-12-13')).toBe('Scanned on 2029-12-13');
  });

  it('rejects a changed reply', () => {
    const row = (change: Record<string, unknown>) => transitWith((rows) => [{ ...rows[0], ...change }]);
    for (const body of [
      null,
      { msg: 'success', data: {} },
      { msg: 'success', code: '1', data: {} },
      { msg: 'success', code: 1, data: [] },
      { msg: 'success', code: 1, data: { [TRANSIT]: {} } },
      { msg: 'success', code: 1, data: Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`EQKPT90000000${String(index).padStart(2, '0')}YQ`, []])) },
      transitWith((rows) => [...rows, 'scan']),
      transitWith((rows) => Array.from({ length: 501 }, () => rows[0])),
      row({ traceLabelNo: undefined }),
      row({ traceContent: ' ' }),
      row({ traceContent: 7 }),
      row({ traceLocation: {} }),
      row({ destinationWBNo: 7 }),
      row({ traceDateTime: '2029-12-17' }),
      row({ traceDateTime: '2029-02-30 08:00:00' }),
      row({ traceDateTime: '2029-12-17 24:00:00' }),
      row({ traceDateTime: '17/12/2029 08:00:00' }),
    ]) {
      expect(() => parseEquick(body, TRANSIT), JSON.stringify(body)?.slice(0, 200)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a bot check, a rate limit and a broken reply apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(raw(body, init))).track({ number: UNKNOWN });
    await expect(lookup(JSON.stringify(fixture('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(JSON.stringify(fixture('failed')))).rejects.toMatchObject({ kind: 'indeterminate' });
    // The service answers every number with HTTP 200: a 404, a 405 or a redirect is a moved route.
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 405 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://api.equick.cn/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    // A blocked page with HTTP 200 is not a missing parcel.
    await expect(lookup('<html><title>验证码</title><body>slide to verify</body></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>登录</title><body>login</body></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('Too Many Requests', { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '10' } }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 10_000 });
    await expect(lookup('{"items":[]}')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 206 })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the empty result, and asks nothing for a number Equick does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('transit')))
      .mockResolvedValueOnce(json(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(TRANSIT)).resolves.toMatchObject({ known: true });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('LM123456785NO')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('tries once more after a failure to reach Equick, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json(fixture('transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new EquickTracker({ fetcher, recorder }).fetch(TRANSIT, { budgetMs: 2000 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'equick', step: 'retry', outcome: 'ok' }));
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
    await clock.settle(expect(carrier(fetcher).track({ number: TRANSIT }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects numbers Equick does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['LM123456785NO', 'EQKPT900000001YQ', 'EQKPT90000000011YQ', 'EQK1T9000000001YQ', 'EQKPT9000000001YX', '12345678', '1234567890', `EQK${'1'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeEquickNumber(' eqkml-9000000002yq ')).toBe(DELIVERED);
    expect(normalizeEquickNumber('900000004')).toBe('900000004');
  });

  it('routes an Equick number to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url) === EQUICK_API
      ? json(fixture('transit')) : new Response('', { status: 404 })));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: TRANSIT }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'equick', source: 'equick', result: { current_stage: 'in_transit' } });
  });
});

describe('Equick numbers', () => {
  it('claims EQK numbers, and leaves nine digits to the carrier the user picks', () => {
    for (const number of [TRANSIT, DELIVERED, UNKNOWN]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'equick', confidence: 'high' });
    }
    expect(detectCarrierMatch('900000004').candidates).not.toContain('equick');
  });
});

describe('Equick status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      if (entry.code) {
        // The Status column's labels set no stage.
        expect(entry.stage, entry.code).toBeUndefined();
        continue;
      }
      expect(equickScanStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'equick', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
  });

  it('reads a site by any code and leaves an unknown scan to the shared rules', () => {
    expect(equickStage('Departed from CAN hub')).toBe('in_transit');
    expect(equickStage('ARRIVED AT LHR AIRPORT')).toBe('in_transit');
    expect(equickStage('Arrived at depot')).toBeUndefined();
    expect(equickScanStage('Synthetic scan')).toBeNull();
    expect(statusMap.stage(null, 'synthetic scan')).toBeUndefined();
    expect(statusMap.stage('In progress', 'picked up from shipper')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'equick', providerCode: null, description: 'Synthetic scan' })).toEqual({ kind: 'unknown' });
  });
});
