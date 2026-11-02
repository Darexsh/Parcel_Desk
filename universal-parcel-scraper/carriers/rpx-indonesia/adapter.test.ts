import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, RPX_API, RpxTracker } from './adapter.js';
import { normalizeRpxNumber, parseRpx, rpxRefusal, rpxWording } from './parser.js';
import { rpxStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '700000000001';
const IN_TRANSIT = '700000000002';
const UNKNOWN = '700000000000';

type Row = Record<string, unknown>;
type Reply = Row & { data_tracking: Row[]; detail_received: Row };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const refusal = (message: string) => ({ message: JSON.stringify({ RPX: { ERROR: { MSG: message } } }), error: 'Bad Request', statusCode: 400 });

describe('RPX HTTP adapter', () => {
  it('asks the app’s lookup for the whole AWB once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new RpxTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 7000-0000 0002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${RPX_API}/${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'rpx-indonesia', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each scan’s wall clock and station, and stages it by its code', () => {
    const result = parseRpx(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Shipment received by Consignee', last_update: null, last_update_local: '2026-03-05T14:15:00',
      expected_delivery: null, weight_kg: 2.5 });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['2026-03-05T14:15:00', 'POD', 'delivered', 'Sampleton'],
      // The repeated departure is kept once.
      ['2026-03-03T23:50:00', 'SOP', 'in_transit', 'Exampleville'],
      ['2026-03-03T16:02:00', 'MDE', 'in_transit', 'Exampleville'],
      ['2026-03-03T16:00:00', 'PUP', 'accepted', 'Exampleville'],
      // A scan without a station names it "NA"; 12 AM is the start of the day.
      ['2026-02-27T00:26:00', 'WPU', 'registered', null],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
  });

  it('drops the recipient, the receiver, the delivery place, photos and coordinates, and the scans’ notes', () => {
    const result = parseRpx(fixture('delivered'), DELIVERED);
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Recipient|Porch)|SAMPLE RECEIVER|Sampletown|example\.invalid|100\.000000|By_CONS|900000000001|AUTOWEB|Print Label|Api/);
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('keeps the estimate and the newest weight given while the parcel is on its way', () => {
    const result = parseRpx(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'wording:language',
      last_status_text: 'Arrived at RPX Destination station', last_update_local: '2026-06-02T07:05:00',
      expected_delivery: '2026-06-04', weight_kg: 1.2 });
    // A code the map does not know falls to the shared wording rules.
    expect(result.events![0]).toMatchObject({ provider_code: 'ZZA', stage: 'in_transit', stage_source: 'wording:language', location: 'Sampleton' });
    expect(result.events!.at(-1)).toMatchObject({ provider_code: 'WPU', stage: 'registered',
      description: 'Shipping Manifest Accepted and Waiting For Pickup' });
    const blank = parseRpx(changed('in-transit', (body) => {
      body.detail_received.ETA = '';
      for (const row of body.data_tracking) row.TRACKING_COMMENT = '';
    }), IN_TRANSIT);
    expect(blank.expected_delivery).toBeNull();
    expect(blank).not.toHaveProperty('weight_kg');
    expect(parseRpx(changed('in-transit', (body) => { delete (body as Row).detail_received; }), IN_TRANSIT).expected_delivery).toBeNull();
  });

  it('reads a history listed oldest first newest first, as the app shows it', () => {
    const result = parseRpx(changed('delivered', (body) => { body.data_tracking.reverse(); }), DELIVERED);
    expect(result).toMatchObject({ last_update_local: '2026-03-05T14:15:00', current_stage: 'delivered' });
    expect(result.events!.at(-1)).toMatchObject({ provider_code: 'WPU' });
  });

  it('takes phone numbers out of the wording and keeps a station named without the brand', () => {
    expect(rpxWording('Call 0800 0000 0000 to reschedule.')).toBe('Call to reschedule.');
    expect(rpxWording('Departed from RPX Origin station')).toBe('Departed from RPX Origin station');
    const result = parseRpx(changed('delivered', (body) => { body.data_tracking[0]!.LOCATION = 'Sample Hub'; }), DELIVERED);
    expect(result.events![0]!.location).toBe('Sample Hub');
  });

  it('reads RPX’s own “No data found” as not found and any other refusal as inconclusive', () => {
    expect(rpxRefusal(fixture('not-found'))).toMatchObject({ kind: 'not_found' });
    expect(rpxRefusal(refusal('Signature verification failed'))).toMatchObject({ kind: 'indeterminate' });
    expect(rpxRefusal({ message: 'Bad Request', statusCode: 400 })).toMatchObject({ kind: 'schema' });
    expect(rpxRefusal({ message: '{"RPX":{}}' })).toMatchObject({ kind: 'schema' });
    expect(rpxRefusal('Bad Request')).toMatchObject({ kind: 'schema' });
  });

  it('reads the service’s own failure as inconclusive and a record without scans as no history', () => {
    expect(() => parseRpx({ statusCode: 500, message: 'Internal server error' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseRpx(changed('delivered', (body) => { body.data_tracking = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseRpx(changed('delivered', (body) => { (body as Row).data_tracking = null; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete (body as Row).data_tracking; },
      (body: Reply) => { (body as Row).data_tracking = 'scans'; },
      (body: Reply) => { body.data_tracking = Array.from({ length: 501 }, () => body.data_tracking[0]!); },
      (body: Reply) => { body.data_tracking[0] = 'scan' as never; },
      (body: Reply) => { (body as Row).detail_received = 'delivered'; },
      (body: Reply) => { body.data_tracking[0]!.TRACKING_DATE = '2026-03-05'; },
      (body: Reply) => { body.data_tracking[0]!.TRACKING_DATE = 'Feb 30, 2026'; },
      (body: Reply) => { body.data_tracking[0]!.TRACKING_DATE = 'Foo 05, 2026'; },
      (body: Reply) => { body.data_tracking[0]!.TRACKING_TIME = '14:15'; },
      (body: Reply) => { body.data_tracking[0]!.TRACKING_TIME = '13:15 PM'; },
      (body: Reply) => { delete body.data_tracking[0]!.TRACKING_TIME; },
      (body: Reply) => { body.data_tracking[0]!.TRACKING_DESC = ['Delivered']; },
      (body: Reply) => { body.data_tracking[0]!.TRACKING_DESC = ''; },
      (body: Reply) => { body.data_tracking[0]!.LOCATION = 7; },
    ]) {
      expect(() => parseRpx(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseRpx(changed('in-transit', (body) => { body.detail_received.ETA = 20260604; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseRpx([], DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a refusal, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'), { status: 400 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(refusal('Signature verification failed'), { status: 400 })).rejects.toMatchObject({ kind: 'indeterminate' });
    // The service answers an unknown route with a 404: a moved lookup, not a missing parcel.
    await expect(lookup({ message: 'ENOENT', error: 'Not Found', statusCode: 404 }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://rpx.co.id/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head></html>', { status: 400, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Server is Running</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ statusCode: 500, message: 'Internal server error' }, { status: 500 })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known AWB and the unknown-number answer, and asks nothing for a number RPX does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found'), { status: 400 }));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-05T14:15:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('70000000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers RPX does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // The reply names no AWB, so only the whole twelve digits are asked: the service
    // reads a leading zero as the same AWB.
    for (const number of ['70000000001', '7000000000011', `0${DELIVERED}`, 'RPX700000000', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeRpxNumber('7000-0000.0001')).toBe(DELIVERED);
  });

  it('tries once more after a read that hangs, inside the budget', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBe(80);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('routes an AWB filed under RPX to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'rpx-indonesia' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'rpx-indonesia', source: 'rpx-indonesia', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${RPX_API}/${DELIVERED}`)).toBe(true);
  });
});

describe('RPX status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string }[]) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(rpxStage(entry.code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'rpx-indonesia', providerCode: 'POD', description: 'Shipment received by Consignee' }))
      .toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'rpx-indonesia', providerCode: 'ZZZ', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(rpxStage('ZZZ', 'Synthetic note')).toBeNull();
    expect(rpxStage('wpu', 'Shipping Manifest Accepted and Waiting For Pickup')).toEqual({ stage: 'registered', source: 'carrier_map' });
  });
});
