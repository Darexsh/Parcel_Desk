import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, REDX_API, RedxTracker } from './adapter.js';
import { normalizeRedxNumber, parseRedx, redxWording } from './parser.js';
import { redxStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '26A5A4MO1SMPL1';
const IN_TRANSIT = '261012MO1SMPL2';
const UNKNOWN = '26A1A5MO1SMPL0';

type Row = Record<string, unknown>;
type Reply = Row & { tracking: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('RedX HTTP adapter', () => {
  it('asks for the whole ID in capitals, once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new RedxTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 2610-12mo-1smpl2 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${REDX_API}${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'redx', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history at Bangladesh’s offset, newest first, without the riders or their phone numbers', () => {
    const result = parseRedx(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Parcel is delivered successfully', last_update: '2026-05-06T12:48:31+06:00',
      delivered_at: '2026-05-06T12:48:31+06:00', expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.description])).toEqual([
      // The delivery the reply lists twice is kept once.
      ['2026-05-06T12:48:31+06:00', 'agent-delivered', 'delivered', 'Parcel is delivered successfully'],
      ['2026-05-06T10:12:40+06:00', 'dispatched-to-agent', 'out_for_delivery', 'Parcel is on the way to delivery'],
      ['2026-05-06T06:35:06+06:00', 'ready-for-delivery-by-bot', 'in_transit', 'Parcel is being processed for delivery'],
      ['2026-05-05T15:05:12+06:00', 'agent-hold-returning', 'failed_attempt',
        'Parcel is On Hold : কাস্টমারের সাথে যোগাযোগ এর চেষ্টা চলছে, যোগাযোগ সম্পন্ন হওয়া মাত্রই ডেলিভারি করা হবে'],
      ['2026-05-05T10:30:00+06:00', 'dispatched-to-agent', 'out_for_delivery', 'Parcel is on the way to delivery'],
      ['2026-05-05T09:12:48+06:00', 'received-from-hub', 'in_transit', 'Parcel is received in Sample Delivery Hub'],
      ['2026-05-05T09:01:09+06:00', 'received-transfer', 'in_transit', 'Parcel is unloaded from the vehicle in Sample Delivery Hub'],
      ['2026-05-05T06:20:17+06:00', 'trip-started', 'in_transit',
        'Parcel carrying vehicle has left from Sample Central Mother Hub for Sample Delivery Hub'],
      ['2026-05-05T04:10:05+06:00', 'dispatched-to-line-haul', 'in_transit',
        'Parcel is ready for transfer from Sample Central Mother Hub to Sample Delivery Hub'],
      // Scans at the same moment keep the order the reply lists them in.
      ['2026-05-05T01:30:41+06:00', 'received-from-hub', 'in_transit', 'Parcel is received in Sample Central Mother Hub'],
      ['2026-05-05T01:30:41+06:00', 'received-transfer', 'in_transit', 'Parcel is unloaded from the vehicle in Sample Central Mother Hub'],
      ['2026-05-04T23:02:33+06:00', 'trip-started', 'in_transit', 'Parcel carrying vehicle has left from Sample Town Hub for Sample Central Mother Hub'],
      ['2026-05-04T21:45:10+06:00', 'dispatched-to-line-haul', 'in_transit', 'Parcel is ready for transfer from Sample Town Hub to Sample Central Mother Hub'],
      ['2026-05-04T21:40:02+06:00', 'received-from-seller', 'accepted', 'Parcel is picked up'],
      ['2026-05-04T14:15:20+06:00', 'pickup-pending', 'registered', 'Parcel is created successfully'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.local_time === undefined && event.location === undefined))
      .toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Rider|Bazar|Para)|_NB|8801000000001|01000000002|পার্সেলটি/);
  });

  it('reads a parcel on its way, booked in a month with two digits', () => {
    const result = parseRedx(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Parcel transitted from Sample Central Mother Hub', last_update: '2026-10-13T03:15:29+06:00', expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    // Each arrival of the vehicle the reply records stays, a few seconds apart.
    expect(result.events!.map((event) => event.provider_code)).toEqual(['received-transit', 'received-transfer', 'bulk-dropped', 'bulk-dropped',
      'trip-started', 'dispatched-to-line-haul', 'received-from-seller', 'pickup-pending']);
  });

  it('takes the person named after “by” and phone numbers out of the wording, and keeps the rest', () => {
    expect(redxWording('Parcel is on the way to delivery by Sample Rider(8801000000000)')).toBe('Parcel is on the way to delivery');
    expect(redxWording('Parcel is on the way to delivery by SAMPLE RIDER (Sample Bazar & Sample Para. Sample Ganj & Sample')).toBe('Parcel is on the way to delivery');
    expect(redxWording('Parcel is On Hold : কাস্টমার ডেলিভারির সময় পরিবর্তন করতে চেয়েছেন – অন্য দিন/জায়গায় ডেলিভারি নিবেন।'))
      .toBe('Parcel is On Hold : কাস্টমার ডেলিভারির সময় পরিবর্তন করতে চেয়েছেন – অন্য দিন/জায়গায় ডেলিভারি নিবেন।');
    expect(redxWording('Parcel is On Hold : ')).toBe('Parcel is On Hold');
    expect(redxWording('Parcel is received in Sample Hub (+880 1000-000000)')).toBe('Parcel is received in Sample Hub');
    expect(redxWording('The parcel delivery area has changed and will move to a new hub.')).toBe('The parcel delivery area has changed and will move to a new hub.');
  });

  it('stages an action the map does not know by its wording, and leaves the current stage to the newest staged scan', () => {
    const result = parseRedx(changed('in-transit', (body) => {
      body.tracking.push({ messageEn: 'Parcel is returned to the merchant', messageBn: '', status: 'returned', groupedStatus: 'returned',
        action: 'sample-returned', time: '2026-10-14T05:00:00.000Z' },
      { messageEn: 'Sample note', messageBn: '', status: 'returned', groupedStatus: 'returned', action: 'sample-note', time: '2026-10-14T06:00:00.000Z' });
    }), IN_TRANSIT);
    expect(result.events![0]).toMatchObject({ provider_code: 'sample-note', description: 'Sample note' });
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(result.events![1]).toMatchObject({ provider_code: 'sample-returned', stage: 'returned' });
    expect(result).toMatchObject({ current_stage: 'returned', last_status_text: 'Sample note', last_update: '2026-10-14T12:00:00+06:00' });
    expect(result.events![1]!.stage_source).toMatch(/^wording:/);
  });

  it('reads an unknown ID as not found and a parcel without scans as no history', () => {
    expect(() => parseRedx(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseRedx({ isError: false, tracking: [] }, DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseRedx(changed('delivered', (body) => { body.tracking = [{ ...body.tracking[0], messageEn: ' ' }]; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete body.isError; },
      (body: Reply) => { body.isError = 'false'; },
      (body: Reply) => { delete (body as Row).tracking; },
      (body: Reply) => { body.tracking = 'tracking' as never; },
      (body: Reply) => { body.tracking = Array.from({ length: 501 }, () => body.tracking[0]!); },
      (body: Reply) => { body.tracking[0] = 'scan' as never; },
      (body: Reply) => { body.tracking[0]!.messageEn = ['Parcel is created successfully']; },
      (body: Reply) => { delete body.tracking[0]!.messageEn; },
      (body: Reply) => { body.tracking[0]!.action = 7; },
      (body: Reply) => { body.tracking[0]!.time = '2026-10-12 10:02:44'; },
      (body: Reply) => { body.tracking[0]!.time = '2026-10-12T10:02:44.000+06:00'; },
      (body: Reply) => { body.tracking[0]!.time = '2026-02-30T10:02:44.000Z'; },
      (body: Reply) => { delete body.tracking[0]!.time; },
      (body: Reply) => { Object.assign(body, { isError: true, message: 'Something went wrong' }); },
      (body: Reply) => { Object.assign(body, { isError: true, body: { message: 'No parcel data found!' } }); },
    ]) {
      expect(() => parseRedx(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A scan without an action falls to the shared wording rules.
    const plain = parseRedx(changed('in-transit', (body) => { for (const row of body.tracking) delete row.action; }), IN_TRANSIT);
    expect(plain.events!.at(-1)).not.toHaveProperty('provider_code');
  });

  it('keeps an unknown ID, a moved route, a merchant-only route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // A 404 or a redirect is a moved route, never a missing parcel.
    await expect(lookup({ isError: true, message: 'No parcel data found!' }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://redx.com.bd/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ isError: true, body: { message: 'No token found!' } }, { status: 403 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head></html>',
      { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>RedX</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[400, 'transport'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known ID and the unknown-ID answer, and asks nothing for an ID RedX does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered'))).mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-05-06T06:48:31.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('26A5A4')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects IDs RedX does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['26A5A4MO1SM', '26A5A4MO1SMPL12', '16A5A4MO1SMPL1', '26A0A4MO1SMPL1', '2613A4MO1SMPL1', '26A532MO1SMPL1',
      '26A5A0MO1SMPL1', '26A5A4XX1SMPL1', '26A5A4MO1SMP_1', `26A5A4MO${'0'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeRedxNumber('26a5 a4mo 1smpl1')).toBe(DELIVERED);
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes an ID filed under RedX, or detected as a RedX tracking ID, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'redx' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'redx', source: 'redx', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 })).resolves.toMatchObject({ carrier: 'redx', source: 'redx' });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${REDX_API}${DELIVERED}`)).toBe(true);
  });
});

describe('RedX numbers', () => {
  it('claims the tracking ID layout with high confidence, months of two digits included', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN, '26A5A4MO1SMP', '26A5A4MO1SMPL']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'redx', confidence: 'high' });
    }
  });
});

describe('RedX status vocabulary', () => {
  it('stages every action seen with the stage its record gives', () => {
    const seen = (statuses.entries as { code?: string; wording: string; stage?: string; confirmedBy: string }[])
      .filter((entry) => entry.code && entry.confirmedBy === 'live');
    expect(seen.length).toBeGreaterThan(14);
    for (const entry of seen) {
      expect(statusMap.stage(entry.code!, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(redxStage(entry.code!, entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'redx', providerCode: entry.code!, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    // An action the map does not know falls to the shared wording rules.
    expect(redxStage('sample-note', 'Sample note')).toBeNull();
    expect(redxStage('', 'Parcel is delivered successfully')).toMatchObject({ stage: 'delivered' });
    expect(statusMap.stage(null, 'parcel is delivered successfully')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'redx', providerCode: 'sample-note', description: 'Sample note' })).toEqual({ kind: 'unknown' });
  });
});
