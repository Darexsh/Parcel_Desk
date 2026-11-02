import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NoHistoryError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { adapter, SENDLE_API, SENDLE_CHALLENGE, SENDLE_LOOKUP, sendleProofHolds, SendleTracker, solveSendleChallenge } from './adapter.js';
import { normalizeSendleNumber, parseSendle, parseSendleChallenge } from './parser.js';
import { sendleCategoryStage, sendleStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const BOOKED = 'QSS990000001';
const ORDER = 'QS990001';
const MOVING = 'QSS990000002';
const UNKNOWN = 'QSS990000003';

type Row = Record<string, unknown>;
type Parcel = Row & { events: Row[] };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const value = (name: string) => (JSON.parse(text(name)) as { value: Row }).value;
const found = (name: string, change: (parcel: Parcel, lookup: Row) => void = () => {}) => {
  const lookup = value(name);
  change(lookup.result as Parcel, lookup);
  return lookup;
};
const envelope = (body: unknown) => JSON.stringify({ status: 'success', value: body });
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
/** A service that hands out the fixture's challenge, then answers the lookup with `lookup`. */
const service = (lookup: () => Response) => vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url).endsWith('/api/mutation')
  ? reply(text('challenge')) : lookup()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const scan = (date: unknown, description: unknown, message?: unknown) => ({ date, description, ...(message === undefined ? {} : { message }) });
const sha = (input: string) => createHash('sha256').update(input).digest();

describe('Sendle HTTP adapter', () => {
  it('asks for a challenge, answers it as the page does and looks up the whole number in capitals, through the supplied transport', async () => {
    const fetcher = service(() => reply(text('booked')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SendleTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' qss 990-000-001 ', { budgetMs: 5000.5 }))
      .resolves.toMatchObject({ current_stage: 'registered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[challengeUrl, challengeInit], [lookupUrl, lookupInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect([challengeUrl, lookupUrl]).toEqual([`${SENDLE_API}/api/mutation`, `${SENDLE_API}/api/action`]);
    expect(JSON.parse(String(challengeInit.body))).toEqual({ path: SENDLE_CHALLENGE, args: {}, format: 'json' });
    const asked = JSON.parse(String(lookupInit.body)) as { path: string; args: Record<string, string>; format: string };
    expect(asked).toMatchObject({ path: SENDLE_LOOKUP, format: 'json',
      args: { reference: BOOKED, challengeId: 'j9sample0challenge0id0000000001', nonce: expect.any(String) } });
    // The nonce is the page's: the first base-36 counter whose hash has the zero bits asked.
    const { salt } = value('challenge') as { salt: string };
    expect(sendleProofHolds(sha(`${salt}:${asked.args.nonce}`), 8)).toBe(true);
    const first = Array.from({ length: parseInt(asked.args.nonce!, 36) }, (_, counter) => counter.toString(36))
      .find((nonce) => sendleProofHolds(sha(`${salt}:${nonce}`), 8));
    expect(first).toBeUndefined();
    for (const init of [challengeInit, lookupInit]) {
      expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
        'Content-Type': 'application/json', Origin: 'https://www.sendle.com', Referer: 'https://www.sendle.com/', 'User-Agent': 'SyntheticHost/1.0',
      } });
    }
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'sendle', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a booked label by the tracker’s status, on its wall clock to the second, without the order number', () => {
    const result = parseSendle(value('booked'), BOOKED);
    expect(result).toEqual({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'Order Created', last_update: null, last_update_local: '2026-04-13T16:05:41', expected_delivery: null,
      events: [{ local_time: '2026-04-13T16:05:41', description: 'Order Created', stage: 'registered', stage_source: 'carrier_map' }] });
    expect(JSON.stringify(result)).not.toContain(ORDER);
  });

  it('takes the order number from the booking e-mail and names the label’s number for it', () => {
    expect(parseSendle(value('booked'), ORDER)).toMatchObject({ current_stage: 'registered', canonical_tracking_number: BOOKED });
    expect(() => parseSendle(found('booked', (parcel) => { parcel.orderNumber = 'QS990009'; }), ORDER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // Without the label's number there is none to name.
    expect(parseSendle(found('booked', (parcel) => { parcel.trackingNumber = null; }), ORDER)).not.toHaveProperty('canonical_tracking_number');
  });

  it('refines a parcel in transit by its newest scan, reads the line under a scan for its stage only, and counts a repeated scan once', () => {
    const result = parseSendle(value('in-transit'), MOVING);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'wording:language',
      last_status_text: 'In transit', last_update: null, last_update_local: '2026-04-16T07:27:27' });
    expect(result.events!.map((event) => [event.local_time, event.description, event.stage])).toEqual([
      ['2026-04-16T07:27:27', 'In transit', 'out_for_delivery'],
      ['2026-04-15T22:38:09', 'Arrived at sorting facility', 'in_transit'],
      ['2026-04-14T09:22:00', 'Picked up', 'accepted'],
      ['2026-04-13T16:05:41', 'Order Created', 'registered'],
    ]);
    const json = JSON.stringify(result);
    for (const excluded of ['SAMPLE DEPOT', 'SAMPLE SENDER', 'Out for delivery', 'QS990002']) expect(json).not.toContain(excluded);
    // A scan staged as registered, or not at all, leaves the tracker's in transit.
    for (const events of [[scan('2026-04-16T07:27:27', 'Order Created')], [scan('2026-04-16T07:27:27', 'Sample Status Note')]]) {
      expect(parseSendle(found('in-transit', (parcel) => { parcel.events = events; }), MOVING))
        .toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    }
  });

  it('keeps the tracker’s status over its scans, and its newest staged scan when the status names no milestone', () => {
    const delivered = parseSendle(found('in-transit', (parcel) => {
      parcel.statusCategory = 'delivered';
      parcel.events = [scan('2026-04-16T09:00:00+10:00', 'Delivered', 'Left at SAMPLE PLACE'), ...parcel.events];
    }), MOVING);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_update: '2026-04-16T09:00:00+10:00', delivered_at: '2026-04-16T09:00:00+10:00' });
    expect(delivered).not.toHaveProperty('last_update_local');
    for (const [category, stage] of [['cancelled', 'exception'], ['returned', 'returned'], ['received', 'registered']] as const) {
      expect(parseSendle(found('in-transit', (parcel) => { parcel.statusCategory = category; }), MOVING), category)
        .toMatchObject({ current_stage: stage, current_stage_source: 'carrier_map' });
    }
    for (const category of ['unknown', 'sample_status']) {
      expect(parseSendle(found('in-transit', (parcel) => { parcel.statusCategory = category; }), MOVING), category)
        .toMatchObject({ current_stage: 'out_for_delivery', current_stage_source: 'wording:language' });
      const unstaged = parseSendle(found('in-transit', (parcel) => {
        parcel.statusCategory = category;
        parcel.events = [scan('2026-04-16T07:27:27', 'Sample Status Note')];
      }), MOVING);
      expect(unstaged, category).toMatchObject({ status: 'unknown', last_status_text: 'Sample Status Note' });
      expect(unstaged, category).not.toHaveProperty('current_stage');
    }
  });

  it('reads a status without scans as a summary, and a parcel with neither as no history', () => {
    expect(parseSendle(found('booked', (parcel) => { parcel.events = []; }), ORDER)).toEqual({ status: 'pending', current_stage: 'registered',
      current_stage_source: 'carrier_map', provider_code: 'label', last_status_text: 'Booked', last_update: null, expected_delivery: null,
      canonical_tracking_number: BOOKED, summary_only: true, events: [] });
    expect(() => parseSendle(found('booked', (parcel) => { parcel.events = []; parcel.statusCategory = 'unknown'; }), BOOKED)).toThrow(NoHistoryError);
    // Rows without wording or a clock place nothing.
    expect(() => parseSendle(found('booked', (parcel) => {
      parcel.statusCategory = 'unknown';
      parcel.events = [scan('2026-04-13T16:05:41', ''), scan(null, 'Order Created'), scan('', 'Order Created')];
    }), BOOKED)).toThrow(NoHistoryError);
  });

  it('keeps an offset the reply states, keeps a wall clock without one, and checks every clock', () => {
    const result = parseSendle(found('booked', (parcel) => {
      parcel.events = [scan('2026-04-14T09:22+10:00', 'Picked up'), scan('2026-04-13T23:00:00Z', 'Sample Status Note'), scan('2026-04-13T16:05', 'Order Created')];
    }), BOOKED);
    expect(result.events!.map((event) => [event.time, event.local_time])).toEqual([
      ['2026-04-14T09:22:00+10:00', undefined], ['2026-04-13T23:00:00Z', undefined], [undefined, '2026-04-13T16:05:00']]);
    expect(result).toMatchObject({ last_update: '2026-04-14T09:22:00+10:00' });
    for (const date of ['2026-04-13T24:00:00', '2026-02-30T08:00:00', '2026-04-13 16:05:41', '2026-04-13', '13/04/2026 16:05', '2026-04-13T16:05:41+1000', 7]) {
      expect(() => parseSendle(found('booked', (parcel) => { parcel.events = [scan(date, 'Order Created')]; }), BOOKED), String(date))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads only the tracker’s unknown-number answer as not found, and keeps its other answers apart', () => {
    expect(() => parseSendle(value('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseSendle({ status: 'rate_limited', retryAfterSeconds: 30 }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'rate_limited', retryAfterMs: 30_000 }));
    expect(() => parseSendle({ status: 'rate_limited' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'rate_limited', retryAfterMs: undefined }));
    expect(() => parseSendle({ status: 'check_failed' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseSendle({ status: 'invalid_reference' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const lookup of [{ status: 'sample' }, {}, null, [], 'found']) {
      expect(() => parseSendle(lookup, UNKNOWN), JSON.stringify(lookup)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads only the parcel that names the whole number asked, and rejects a changed reply', () => {
    for (const number of ['QSS9900000011', 'QSS990000009', '']) {
      expect(() => parseSendle(found('booked', (parcel) => { parcel.trackingNumber = number; }), BOOKED), number)
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    for (const change of [
      (parcel: Parcel) => { parcel.trackingNumber = 7; },
      (parcel: Parcel) => { parcel.statusCategory = 7; },
      (parcel: Parcel) => { parcel.statusCategory = ''; },
      (parcel: Parcel) => { parcel.statusCategory = 'Sample Status'; },
      (parcel: Parcel) => { (parcel as Row).events = null; },
      (parcel: Parcel) => { (parcel as Row).events = ['scan']; },
      (parcel: Parcel) => { parcel.events = [scan('2026-04-13T16:05:41', 7)]; },
      (parcel: Parcel) => { parcel.events = [scan('2026-04-13T16:05:41', 'Order Created', 7)]; },
      (parcel: Parcel) => { parcel.events = Array.from({ length: 501 }, () => scan('2026-04-13T16:05:41', 'Order Created')); },
      (_parcel: Parcel, lookup: Row) => { delete lookup.result; },
    ]) expect(() => parseSendle(found('booked', change), BOOKED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps the newest hundred scans of a long history and says it cut the rest', () => {
    const result = parseSendle(found('booked', (parcel) => {
      parcel.events = Array.from({ length: 120 }, (_, index) => scan(`2026-04-10T${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00`,
        'Sample Status Note')).reverse();
    }), BOOKED);
    expect(result.events).toHaveLength(100);
    expect(result).toMatchObject({ history_truncated: true, last_update_local: '2026-04-10T01:59:00' });
  });

  it('keeps an unknown number, a failed call, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(service(() => reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(envelope({ status: 'check_failed' }))).rejects.toMatchObject({ kind: 'challenge' });
    // The service answers a failed call with HTTP 200 and a request id.
    await expect(lookup(JSON.stringify({ status: 'error', errorMessage: '[Request ID: 0000000000000000] Server Error' })))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(text('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.sendle.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    // The tracking page, or an empty body, in place of the reply.
    await expect(lookup('<!doctype html><html><head><title>Sendle</title></head></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(JSON.stringify({ status: 'success' }))).rejects.toMatchObject({ kind: 'schema' });
    // A challenge the adapter cannot read, or one too costly to answer, is no lookup.
    for (const [challenge, kind] of [[{ challengeId: 'j9sample0challenge0id0000000001', salt: 'sample', difficulty: 21 }, 'challenge'],
      [{ challengeId: 'j9sample0challenge0id0000000001', salt: 'sample', difficulty: 8.5 }, 'schema'],
      [{ challengeId: '', salt: 'sample', difficulty: 8 }, 'schema'], [{ salt: 'sample', difficulty: 8 }, 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(envelope(challenge)));
      await expect(carrier(fetcher).track({ number: UNKNOWN }), JSON.stringify(challenge)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: BOOKED })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    });

  it('refuses numbers Sendle does not issue, and pre-aborted or spent lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['QSS99000000', 'QSS9900000001', 'QS99000', 'QS9900001', 'QSX990000001', 'S12345', 'SAMPLETRACKING', `QSS${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: BOOKED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: BOOKED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect([normalizeSendleNumber('qss 990.000.001'), normalizeSendleNumber(' qs-990001 ')]).toEqual([BOOKED, ORDER]);
  });

  it('starts over with a new challenge when a call fails to connect or hangs, inside the budget', async () => {
    fakeBudgetClock();
    const flaky = service(() => reply(text('booked')));
    flaky.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(carrier(flaky).track({ number: BOOKED })).resolves.toMatchObject({ current_stage: 'registered' });
    expect(flaky.mock.calls.map(([url]) => String(url).slice(SENDLE_API.length))).toEqual(['/api/mutation', '/api/mutation', '/api/action']);
    const started = performance.now();
    const slow = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(slow.fetcher).track({ number: BOOKED }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(slow.fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(slow.ended.map((at) => at - started)).toEqual([60, 120]);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(256 * 1024 + 1)));
    await expect(carrier(large).track({ number: BOOKED })).rejects.toThrow('unexpectedly large');
  });

  it('answers a challenge as the page does, and stops when the lookup ends or its time runs out', async () => {
    const signal = new AbortController().signal;
    const nonce = await solveSendleChallenge('sample-salt', 12, signal, performance.now() + 10_000);
    expect(sendleProofHolds(sha(`sample-salt:${nonce}`), 12)).toBe(true);
    expect(await solveSendleChallenge('sample-salt', 0, signal, performance.now() + 10_000)).toBe('0');
    // The page's bit check: whole zero bytes, then the leading bits of the next.
    expect([sendleProofHolds(Uint8Array.of(0, 0x0f), 12), sendleProofHolds(Uint8Array.of(0, 0x1f), 12), sendleProofHolds(Uint8Array.of(0, 0), 17)])
      .toEqual([true, false, false]);
    await expect(solveSendleChallenge('sample-salt', 20, AbortSignal.abort(new Error('cancelled')), performance.now() + 10_000)).rejects.toThrow('cancelled');
    await expect(solveSendleChallenge('sample-salt', 20, signal, performance.now() - 1)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(solveSendleChallenge('sample-salt', 21, signal, performance.now() + 10_000)).rejects.toMatchObject({ kind: 'challenge' });
    expect(parseSendleChallenge(value('challenge'))).toEqual({ challengeId: 'j9sample0challenge0id0000000001', salt: '0123456789abcdef0123456789abcdef', difficulty: 8 });
  });

  it('recognizes a number the tracker knows, and not one it does not know or Sendle does not issue', async () => {
    await expect(carrier(service(() => reply(text('booked')))).recognize!(BOOKED))
      .resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-04-13T16:05:41' });
    await expect(carrier(service(() => reply(text('not-found')))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('QSS99000000')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(carrier(service(() => reply(envelope({ status: 'rate_limited', retryAfterSeconds: 30 })))).recognize!(BOOKED))
      .rejects.toMatchObject({ kind: 'rate_limited' });
  });
});

describe('Sendle status vocabulary', () => {
  it('maps every status and wording it recorded to the stage recorded for it, and leaves the one without a milestone out', () => {
    for (const entry of statuses.entries as { code?: string; wording?: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.code) {
        expect(sendleCategoryStage(entry.code), entry.code).toBe(entry.stage);
        expect(statusMap.stage(entry.code, ''), entry.code).toBe(entry.stage);
        continue;
      }
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording!)), entry.wording).toBe(entry.stage);
      expect(sendleStage(entry.wording!), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMap.gaps).toEqual([{ code: 'unknown', note: expect.any(String) }]);
    for (const wording of ['constructor', 'toString', 'Sample Status Note']) expect(sendleStage(wording), wording).toBeNull();
    // A scan that only says the parcel moves takes the stage of the line under it; any other keeps its own.
    expect(sendleStage('In transit', 'Out for delivery')).toEqual({ stage: 'out_for_delivery', source: 'wording:language' });
    expect(sendleStage('Sample Status Note', 'Picked up')).toEqual({ stage: 'accepted', source: 'wording:language' });
    expect(sendleStage('In transit', 'Sample Status Note')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(sendleStage('Delivered', 'Picked up by the recipient')).toEqual({ stage: 'delivered', source: 'carrier_map' });
  });
});
