import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, MESSENGER_API, MESSENGER_ORIGIN, MessengerTracker } from './adapter.js';
import { messengerWording, normalizeMessengerNumber, parseMessenger } from './parser.js';
import { messengerStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ABCD0001';
const WAITING = 'ABCD0002';
const LONG = 'ABCDE0000000001';
type Row = Record<string, unknown>;
type Reply = Row & { trackingEvents: Row[] };
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string): Reply => JSON.parse(text(name)) as Reply;
const edited = (name: string, change: (payload: Reply) => void): Reply => {
  const payload = fixture(name);
  change(payload);
  return payload;
};
const reply = (body: string | null, status = 200, type = 'application/json') => new Response(body, { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
// The page the API's servlet container serves when its request filter fails.
const SERVLET = '<!doctype html><html lang="en"><head><title>HTTP Status 500 – Internal Server Error</title></head><body></body></html>';

describe('Messenger tracking adapter', () => {
  it('asks the tracker for the whole number in capitals once, from the tracking page’s origin, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new MessengerTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' abcd-0001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${MESSENGER_API}${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json, text/plain, */*', Origin: MESSENGER_ORIGIN, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'messenger-cz', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a door delivery newest first from epoch clocks, keeping a repeated scan once and no names', () => {
    const result = parseMessenger(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'uzavřena', last_update: '2026-09-15T10:21:00+02:00', expected_delivery: null,
      delivered_at: '2026-09-15T10:20:00+02:00', service_name: 'Expres' });
    expect(result.events!.map((event) => [event.time, event.description, event.stage ?? null])).toEqual([
      ['2026-09-15T10:21:00+02:00', 'uzavřena', null],
      ['2026-09-15T10:20:00+02:00', 'doručena', 'delivered'],
      ['2026-09-15T08:00:00+02:00', 'avizované doručení', null],
      ['2026-09-15T07:45:00+02:00', 'vyzvednuta z depa', 'out_for_delivery'],
      ['2026-09-15T07:30:00+02:00', 'vyskladněna', 'in_transit'],
      ['2026-09-14T12:10:00+02:00', 'doručena do depa', 'in_transit'],
      ['2026-09-14T09:40:00+02:00', 'vyzvednuta', 'accepted'],
      ['2026-09-14T08:06:00+02:00', 'přiřazena', 'registered'],
      ['2026-09-14T08:05:00+02:00', 'přijata', 'registered'],
    ]);
    expect(result).not.toHaveProperty('pickup_point');
    expect(result).not.toHaveProperty('expected_delivery_from');
    expect(JSON.stringify(result)).not.toMatch(/Sample|Kurýr|Vzorová|Ukázková|000 00|\+420|CZK|"lat"/);
  });

  it('reads a parcel waiting at an AlzaBox from wall clocks, in Slovakia where a scan names it, oldest first', () => {
    const result = parseMessenger(fixture('in-transit'), WAITING);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map',
      last_status_text: 'připravena k výdeji', last_update: '2026-10-26T09:15:00+01:00',
      expected_delivery: '2026-10-26T18:00:00+01:00', expected_delivery_from: '2026-10-26T08:00:00+01:00',
      pickup_point: 'AlzaBox Sample Point 001\nVzorová 10\nBratislava', service_name: 'Standard' });
    expect(result.events!.map((event) => [event.time, event.description, event.stage])).toEqual([
      ['2026-10-26T09:15:00+01:00', 'připravena k výdeji', 'ready_for_pickup'],
      // The hour the clocks repeat reads as its first occurrence.
      ['2026-10-25T02:30:00+02:00', 'doručena do depa', 'in_transit'],
      ['2026-10-24T18:30:00+02:00', 'vyzvednuta', 'accepted'],
      ['2026-10-24T16:00:00+02:00', 'přijata', 'registered'],
    ]);
    expect(result).not.toHaveProperty('delivered_at');
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Shop|Stop|note)|Ukážková|\+421|example\.com/);
  });

  it('keeps an offset the reply gives, and names a pickup point only while the parcel waits there or was collected from it', () => {
    const offset = parseMessenger(edited('in-transit', (payload) => {
      payload.trackingEvents[3]!.date = '2026-10-26T08:15:00Z';
      payload.trackingEvents[2]!.date = '2026-10-25T01:30:00.000+01:00';
    }), WAITING);
    expect(offset.events!.slice(0, 2).map((event) => event.time)).toEqual(['2026-10-26T08:15:00Z', '2026-10-25T01:30:00+01:00']);
    const collected = parseMessenger(edited('in-transit', (payload) => {
      payload.trackingEvents.push({ date: '2026-10-27T16:40:00', note: 'doručena (Sample Recipient)' });
      payload.state = 'doručena (Sample Recipient)';
    }), WAITING);
    expect(collected).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-10-27T16:40:00+01:00', expected_delivery: null,
      pickup_point: 'AlzaBox Sample Point 001\nVzorová 10\nBratislava' });
    expect(collected).not.toHaveProperty('expected_delivery_from');
    const moving = parseMessenger(edited('in-transit', (payload) => { payload.trackingEvents.pop(); }), WAITING);
    expect(moving).toMatchObject({ current_stage: 'in_transit' });
    expect(moving).not.toHaveProperty('pickup_point');
  });

  it('lets the state settle a delivery or a return the scans have not reached, and stage a history without one', () => {
    const delivered = parseMessenger(edited('in-transit', (payload) => { payload.state = 'doručena'; }), WAITING);
    expect(delivered).toMatchObject({ current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'připravena k výdeji' });
    expect(delivered).not.toHaveProperty('delivered_at');
    const returning = parseMessenger(edited('in-transit', (payload) => { payload.state = 'vrací se zpět ()'; }), WAITING);
    expect(returning).toMatchObject({ status: 'exception', current_stage: 'returned' });
    // An earlier state does not step the parcel back.
    expect(parseMessenger(edited('in-transit', (payload) => { payload.state = 'přiřazena'; }), WAITING))
      .toMatchObject({ current_stage: 'ready_for_pickup' });
    const unstaged = parseMessenger(edited('in-transit', (payload) => {
      payload.trackingEvents = [{ date: '2026-10-24T16:00:00', note: 'Synthetic notice (Sample Person)' }];
      payload.state = 'v procesu';
    }), WAITING);
    expect(unstaged).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Synthetic notice' });
    expect(unstaged.events![0]).not.toHaveProperty('stage');
  });

  it('reads a consignment without scans from its state alone', () => {
    const summary = parseMessenger(edited('delivered', (payload) => { payload.trackingEvents = []; }), DELIVERED);
    expect(summary).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'doručena', last_update: '2026-09-15T10:21:00+02:00', delivered_at: '2026-09-15T10:20:00+02:00',
      summary_only: true, events: [] });
    expect(() => parseMessenger(edited('delivered', (payload) => { payload.trackingEvents = []; payload.state = null; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseMessenger(edited('delivered', (payload) => { delete (payload as Row).trackingEvents; payload.state = 'Synthetic'; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('keeps a documented state’s name and drops the people and phone numbers around other text', () => {
    expect(messengerWording('doručena (Sample Recipient)')).toBe('doručena');
    expect(messengerWording('Doručena do depa Sample Town')).toBe('Doručena do depa');
    expect(messengerWording('přiřazena Kurýr(000) Sample Courier')).toBe('přiřazena');
    expect(messengerWording('nedoručena - Sample Reason')).toBe('nedoručena');
    // A word that only opens with a state's name is not that state.
    expect(messengerWording('doručenaX')).toBe('doručenaX');
    expect(messengerWording('Synthetic notice (Sample Person), call +420 000 000 000.')).toBe('Synthetic notice, call.');
    expect(messengerWording('(Sample Person)')).toBe('');
  });

  it('binds the reply to the whole number asked and rejects changed replies', () => {
    expect(() => parseMessenger(fixture('delivered'), WAITING))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Messenger answered for another consignment' }));
    expect(() => parseMessenger(edited('delivered', (payload) => { payload.trackingCode = `${DELIVERED}0000000`; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseMessenger([fixture('delivered'), fixture('in-transit')], DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Messenger returned several consignments for the number' }));
    expect(parseMessenger(edited('delivered', (payload) => { payload.trackingCode = 'abcd0001'; }), DELIVERED).events).toHaveLength(9);
    expect(() => parseMessenger(null, DELIVERED)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const change of [
      (payload: Reply) => { delete payload.trackingCode; },
      (payload: Reply) => { payload.trackingCode = 1234; },
      (payload: Reply) => { payload.trackingEvents = 'scans' as never; },
      (payload: Reply) => { payload.trackingEvents = Array.from({ length: 501 }, () => payload.trackingEvents[0]!); },
      (payload: Reply) => { payload.trackingEvents[0] = 'scan' as never; },
      (payload: Reply) => { delete payload.trackingEvents[0]!.note; },
      (payload: Reply) => { payload.trackingEvents[0]!.note = ['uzavřena']; },
      (payload: Reply) => { payload.trackingEvents[0]!.note = '(Sample Person)'; },
      (payload: Reply) => { delete payload.trackingEvents[0]!.date; },
      (payload: Reply) => { payload.trackingEvents[0]!.date = '15. 9. 2026 10:21'; },
      (payload: Reply) => { payload.trackingEvents[0]!.date = '2026-02-30T10:21:00'; },
      (payload: Reply) => { payload.trackingEvents[0]!.date = '2026-09-15T24:00:00'; },
      (payload: Reply) => { payload.trackingEvents[0]!.date = 1789460460; },
      (payload: Reply) => { payload.trackingEvents[0]!.date = 1789460460000.5; },
      (payload: Reply) => { payload.state = { name: 'doručena' }; },
    ]) {
      expect(() => parseMessenger(edited('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads the tracker’s empty answer as not found, and keeps a browser check, a moved route and a broken reply apart', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: DELIVERED });
    await expect(lookup(new Response(null, { status: 204 }))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(reply('null'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(reply(''))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(reply(CHECK, 200, 'text/html'))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(reply(CHECK, 403, 'text/html'))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(reply('<html><title>Messenger</title></html>', 200, 'text/html'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(reply(SERVLET, 500, 'text/html'))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(new Response(null, { status: 302, headers: { Location: 'https://tracking.messenger.cz/' } })))
      .rejects.toMatchObject({ kind: 'transport' });
  });

  it('takes eight or fifteen letters and digits, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ABCD001', 'ABCD00001', 'ABCDEFGH', `${LONG}0`, 'ABCD_001', 'ABCD0000000001']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeMessengerNumber('abcd 0001')).toBe(DELIVERED);
    expect(normalizeMessengerNumber('abcde-0000000001')).toBe(LONG);
  });

  it('keeps a rate limit with its retry window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [302, 'transport'], [404, 'transport'], [405, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)('keeps HTTP %s as %s, without a retry', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('{}', status));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('routes a number filed under Messenger, or opened from its tracking link, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'messenger-cz' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'messenger-cz', source: 'messenger-cz', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === `${MESSENGER_API}${DELIVERED}`)).toBe(true);
    for (const link of [`https://tracking.messenger.cz/${DELIVERED}`, `https://tracking.messenger.cz/consignment/${DELIVERED}`]) {
      expect(parseTrackingInput(link)).toMatchObject({ trackingNumber: DELIVERED, carrier: 'messenger-cz', source: 'link' });
    }
  });

  it('is not claimed or asked by number alone: eight characters are shared by many carriers', () => {
    expect(detectCarrierMatch(DELIVERED).carrier).not.toBe('messenger-cz');
    expect(recognitionAskedCarriers(DELIVERED)).not.toContain('messenger-cz');
    expect(recognitionAskedCarriers('13572468')).not.toContain('messenger-cz');
  });
});

type Entry = { code?: string; wording: string; stage?: string; confirmedBy: string };

describe('Messenger status vocabulary', () => {
  it('maps every documented state to the stage recorded for it, and leaves the rest out on purpose', () => {
    for (const entry of statuses.entries as Entry[]) {
      const wording = normalizeStatusWording(entry.wording);
      expect(statusMap.stage(null, wording), entry.wording).toBe(entry.stage);
      expect(messengerStage(entry.wording)?.stage, entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'messenger-cz', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual(entry.stage ? { kind: 'mapped', stage: entry.stage } : expect.objectContaining({ kind: 'intentional_gap' }));
    }
    expect(messengerStage('Stornována')).toEqual({ stage: 'exception', source: 'carrier_map' });
    expect(messengerStage('Synthetic notice')).toBeNull();
    expect(statusMapAnswer({ carrier: 'messenger-cz', providerCode: null, description: 'Synthetic notice' })).toEqual({ kind: 'unknown' });
  });
});
