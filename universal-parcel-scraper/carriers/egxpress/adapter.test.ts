import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { adapter, EGXPRESS_API, EgxpressTracker } from './adapter.js';
import { normalizeEgxpressNumber, parseEgxpress } from './parser.js';
import { egxpressStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'FED2026040283472915';
const UNKNOWN = 'FED2001040668235714';
type Row = Record<string, unknown>;
type Reply = Row & { trackInfo: { shipmentInformation: Row; trackList: Row[] }[] };
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/domestic.json', import.meta.url), 'utf8')) as Reply;
const changed = (change: (body: Reply) => void) => { const body = fixture(); change(body); return body; };
const missing = () => ({ code: -1, description: 'Status Not Found for This AWBNo.', trackInfo: [] });
const response = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const events = (result: ReturnType<typeof parseEgxpress>) => result.events!.map((event) => [event.local_time,
  event.description, event.provider_code, event.stage, event.location]);
const CHALLENGE = '<html><title>Just a moment...</title><script>window._cf_chl_opt={};</script></html>';
const PERSONAL = /SYNTHETIC (?:RECIPIENT|SENDER|ACCOUNT|MERCHANT|CONTENTS|INSTRUCTIONS|PARTNER)|Example Road|98765012345678|815\.25/i;

describe('EGXPRESS domestic HTTP adapter', () => {
  it('reads the official single-waybill guest request through the supplied transport and user agent', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new EgxpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' fed20260402 83472915 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [request, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(request));
    expect(url.origin + url.pathname).toBe(EGXPRESS_API);
    expect([...url.searchParams]).toEqual([['_trackingID', NUMBER]]);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', cache: 'no-store', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(init!.headers).not.toHaveProperty('Cookie');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'egxpress', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
    expect(inspect([recorder.step.mock.calls, recorder.lookup.mock.calls], { depth: 10 })).not.toMatch(PERSONAL);
  });

  it('keeps the whole dated history and local clocks while dropping personal and commercial fields', () => {
    const result = parseEgxpress(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-04-04T15:21:00', expected_delivery: null });
    expect(events(result)).toEqual([
      ['2026-04-04T15:21:00', 'Delivered', 'POD', 'delivered', 'Sample Destination'],
      ['2026-04-04T08:42:00', 'With Delivery Courier', 'OFD', 'out_for_delivery', 'Sample Destination'],
      ['2026-04-03T07:02:00', 'Arrived at Hub', 'AH', 'in_transit', 'Sample Destination'],
      ['2026-04-03T01:13:00', 'Sent to Sample Destination', 'DF', 'in_transit', 'Sample Hub'],
    ]);
    expect(result.events!.every((event) => !event.time && !event.time_zone)).toBe(true);
    expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('summary_only');
    expect(result).not.toHaveProperty('history_truncated');
    expect(JSON.stringify(result)).not.toMatch(PERSONAL);
    expect(result).not.toHaveProperty('weight_kg');
    expect(result).not.toHaveProperty('sender_name');
    expect(result).not.toHaveProperty('receiver_name');
  });

  it('uses each scan’s own code rather than applying the delivery summary to the history', () => {
    const transit = changed((body) => { body.trackInfo[0]!.trackList.shift(); body.trackInfo[0]!.shipmentInformation.lastStatus = 'Delivered'; });
    expect(parseEgxpress(transit, NUMBER)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery',
      last_status_text: 'With Delivery Courier', last_update_local: '2026-04-04T08:42:00' });
    const worded = changed((body) => { body.trackInfo[0]!.trackList[0]!.status = 'X42'; body.trackInfo[0]!.trackList[0]!.remarks = 'Return to sender initiated'; });
    expect(parseEgxpress(worded, NUMBER).events![0]).toMatchObject({ provider_code: 'X42', stage_source: expect.stringMatching(/^wording:/) });
    const unknown = changed((body) => { body.trackInfo[0]!.trackList[0]!.status = 'X42'; body.trackInfo[0]!.trackList[0]!.remarks = 'Synthetic routing note'; });
    expect(parseEgxpress(unknown, NUMBER)).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic routing note' });
    expect(parseEgxpress(unknown, NUMBER).events![0]).not.toHaveProperty('stage');
  });

  it('keeps source order at a tied local clock and distinguishes a day from a midnight scan', () => {
    const tied = changed((body) => { body.trackInfo[0]!.trackList[1]!.transTime = '15:21'; });
    expect(parseEgxpress(tied, NUMBER).events!.slice(0, 2).map((event) => event.provider_code)).toEqual(['POD', 'OFD']);
    const midnight = changed((body) => { body.trackInfo[0]!.trackList[0]!.transTime = '00:00'; });
    expect(parseEgxpress(midnight, NUMBER).events!.find((event) => event.provider_code === 'POD')!.local_time).toBe('2026-04-04T00:00:00');
    const day = changed((body) => { body.trackInfo[0]!.trackList[0]!.transTime = ''; });
    expect(parseEgxpress(day, NUMBER).events!.find((event) => event.provider_code === 'POD')!.local_time).toBe('2026-04-04');
    expect(parseEgxpress(day, NUMBER)).toMatchObject({ current_stage: 'delivered', last_update_local: '2026-04-04' });
  });

  it('requires the full explicit unknown signature and never turns empty success or error codes into absence', () => {
    expect(() => parseEgxpress(missing(), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const body of [
      { code: -1, description: 'Tracking unavailable', trackInfo: [] },
      { code: -1, description: 'Status Not Found for This AWBNo.' },
      { code: -1, description: 'Status Not Found for This AWBNo.', trackInfo: fixture().trackInfo },
      { code: 101, trackInfo: [] },
      { code: '-1', description: 'Status Not Found for This AWBNo.', trackInfo: [] },
    ]) expect(() => parseEgxpress(body, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseEgxpress({ code: 101, description: 'SUCCESS', trackInfo: [] }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    expect(() => parseEgxpress(changed((body) => { body.trackInfo[0]!.trackList = []; }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
  });

  it('binds the answer to the entire returned waybill before applying display limits', () => {
    for (const id of [UNKNOWN, `${NUMBER}${' '.repeat(500)}X`, `${NUMBER},${UNKNOWN}`]) {
      expect(() => parseEgxpress(changed((body) => { body.trackInfo[0]!.shipmentInformation.awbNo = id; }), NUMBER))
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(parseEgxpress(changed((body) => { body.trackInfo[0]!.shipmentInformation.awbNo = ` ${NUMBER.toLowerCase()} `; }), NUMBER).events).toHaveLength(4);
    expect(() => parseEgxpress(changed((body) => { body.trackInfo.push(body.trackInfo[0]!); }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects changed schemas, non-scalar fields, invalid calendars and invalid clocks', () => {
    for (const change of [
      (body: Reply) => { body.trackInfo[0]!.shipmentInformation.awbNo = ['another']; },
      (body: Reply) => { delete body.trackInfo[0]!.shipmentInformation.awbNo; },
      (body: Reply) => { body.trackInfo[0]!.trackList[0] = 'scan' as never; },
      (body: Reply) => { body.trackInfo[0]!.trackList[0]!.status = {}; },
      (body: Reply) => { body.trackInfo[0]!.trackList[0]!.status = ''; },
      (body: Reply) => { body.trackInfo[0]!.trackList[0]!.remarks = ['note']; },
      (body: Reply) => { body.trackInfo[0]!.trackList[0]!.location = {}; },
      (body: Reply) => { body.trackInfo[0]!.trackList[0]!.transdate = '31/02/2026'; },
      (body: Reply) => { body.trackInfo[0]!.trackList[0]!.transdate = '2026-04-04'; },
      (body: Reply) => { body.trackInfo[0]!.trackList[0]!.transdate = '01/01/0001'; },
      (body: Reply) => { body.trackInfo[0]!.trackList[0]!.transTime = '24:00'; },
      (body: Reply) => { body.trackInfo[0]!.trackList[0]!.transTime = '15:60'; },
      (body: Reply) => { body.trackInfo[0]!.trackList[0]!.transTime = '03:21 PM'; },
      (body: Reply) => { body.trackInfo[0]!.trackList[0]!.transTime = 1500; },
      (body: Reply) => { body.trackInfo[0]!.trackList = Array.from({ length: 1001 }, () => body.trackInfo[0]!.trackList[0]!); },
    ]) expect(() => parseEgxpress(changed(change), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const body of [null, [], {}, { code: 101, description: 'SUCCESS', trackInfo: [null] }]) {
      expect(() => parseEgxpress(body, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('marks a retained portion of a long history instead of silently calling it complete', () => {
    const long = changed((body) => {
      body.trackInfo[0]!.trackList = Array.from({ length: 201 }, (_, i) => ({ status: 'AH', remarks: 'Arrived at Hub',
        location: 'Sample Hub', transdate: '03/04/2026', transTime: `${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}` })).reverse();
    });
    expect(parseEgxpress(long, NUMBER)).toMatchObject({ history_truncated: true, last_update_local: '2026-04-03T03:20:00' });
    expect(parseEgxpress(long, NUMBER).events).toHaveLength(200);
  });

  it('keeps HTML checks, moved endpoints, malformed replies and unknown shipments apart without retrying them', async () => {
    for (const [body, init, kind] of [
      [missing(), {}, 'not_found'],
      [CHALLENGE, {}, 'challenge'],
      ['<html><title>Server error</title></html>', {}, 'schema'],
      ['{"remarks":"SYNTHETIC RECIPIENT",', {}, 'schema'],
      ['', { status: 404 }, 'transport'],
      ['', { status: 410 }, 'transport'],
      ['', { status: 302, headers: { Location: '/' } }, 'transport'],
      [{ error: 'Synthetic validation failure' }, { status: 400 }, 'schema'],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(body, init));
      await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s while removing recipient details from error and recorder diagnostics', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture(), { status, headers: { 'Retry-After': '23' } }));
      const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
      const error: unknown = await new EgxpressTracker({ fetcher, recorder }).fetch(NUMBER).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ kind, status, retryAfterMs: 23_000 });
      expect(inspect([error, recorder.step.mock.calls, recorder.lookup.mock.calls], { depth: 15 })).not.toMatch(PERSONAL);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('recognizes a dated known shipment, a positive unknown and no other number shape', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(fixture())).mockResolvedValueOnce(response(missing()))
      .mockResolvedValueOnce(response(CHALLENGE));
    await expect(carrier(fetcher).recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-04-04T15:21:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(fetcher).recognize!('987654321')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects out-of-scope inputs and pre-aborted calls without reaching the carrier', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['987654321', 'FED20260402', 'FED2026040283472915X', `${'X'.repeat(65)}${NUMBER}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: NUMBER }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeEgxpressNumber(` ${NUMBER.toLowerCase()} `)).toBe(NUMBER);
  });

  it('retries only a failed connection within one shared budget and stops when cancellation ends it', async () => {
    fakeBudgetClock();
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: 50, reply: () => response(fixture()) }]);
    const answered = carrier(recovered.fetcher).track({ number: NUMBER }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answered).resolves.toMatchObject({ status: 'delivered' });
    expect(recovered.ended).toEqual([200, 250]);
    const start = performance.now();
    const hanging = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(hanging.fetcher).track({ number: NUMBER }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(hanging.ended.map((at) => at - start)).toEqual([60, 120]);
    const controller = new AbortController();
    const cancelled = delayedFetcher([{ afterMs: Infinity }, { afterMs: 1, reply: () => response(fixture()) }]);
    const pending = expect(carrier(cancelled.fetcher).track({ number: NUMBER }, { signal: controller.signal, budgetMs: 400 })).rejects.toThrow();
    controller.abort(new Error('cancelled'));
    await pending;
    expect(cancelled.fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('EGXPRESS status vocabulary', () => {
  it('records every explicit code with its stage and leaves new codes to wording', () => {
    for (const entry of statuses.entries as { code: string; wording?: string; stage: string }[]) {
      expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording ?? ''))).toBe(entry.stage);
      expect(egxpressStage(entry.code, entry.wording ?? '')).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMap.stage('UNSEEN', 'synthetic routing note')).toBeUndefined();
  });
});
