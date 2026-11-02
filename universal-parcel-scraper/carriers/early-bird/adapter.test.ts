import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { classifyWording } from '../../core/status/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, EARLY_BIRD_ENDPOINT, earlyBirdRequestBody, EarlyBirdTracker } from './adapter.js';
import { normalizeEarlyBirdNumber, parseEarlyBird } from './parser.js';
import { earlyBirdWordingStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DOOR = '00373402216999999990';
const LOCKER = '00373402216999999983';
const EXTENDED = '00873402216999999995';
const LEGACY = '00373325385999999995';
const FOREIGN = '00373402217999999997';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const reply = (body: string, status = 200, headers: Record<string, string> = { 'Content-Type': 'application/json' }) =>
  new Response(body, { status, headers });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

interface Row { text?: unknown; occurredAt?: unknown }
interface Reply { type?: unknown; status: { text?: unknown; occurredAt?: unknown }; events: Row[]; action: unknown; requestId?: unknown }
const edited = (name: string, change: (payload: Reply) => void = () => {}): Reply => {
  const payload = JSON.parse(text(name)) as Reply;
  change(payload);
  return payload;
};
const rows = (result: ReturnType<typeof parseEarlyBird>) =>
  result.events!.map(event => [event.time ?? event.local_time, event.stage ?? null, event.stage_source ?? null, event.location ?? null]);

describe('Early Bird tracking adapter', () => {
  it('posts the whole number once to the tracking page’s service, in English, without a session, and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('door')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new EarlyBirdTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 0037 3402 2169 9999 9990 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(EARLY_BIRD_ENDPOINT);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ trackingNumber: DOOR, locale: 'en' });
    expect(earlyBirdRequestBody(DOOR)).toBe(init?.body);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('user-agent')).toBe('SyntheticHost/1.0');
    expect(headers.has('cookie') || headers.has('authorization')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'early-bird', step: 'direct', outcome: 'ok' }));
  });

  it('reads a home delivery newest first, with its instants and the towns its terminals name', () => {
    const result = parseEarlyBird(JSON.parse(text('door')), DOOR);
    expect(result).toEqual(expect.objectContaining({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'The package has been delivered to your door.', last_update: '2031-03-14T05:12:44.120Z',
      delivered_at: '2031-03-14T05:12:44.120Z', expected_delivery: null }));
    for (const field of ['last_update_local', 'summary_only', 'delivery_carrier', 'history_truncated', 'pickup_point']) {
      expect(result[field], field).toBeUndefined();
    }
    expect(rows(result)).toEqual([
      ['2031-03-14T05:12:44.120Z', 'delivered', 'carrier_map', null],
      ['2031-03-14T01:02:10Z', 'in_transit', 'carrier_map', 'Norrvika'],
      ['2031-03-13T20:40:00Z', 'in_transit', 'carrier_map', 'Lindhamra'],
      ['2031-03-13T18:05:31.500Z', 'accepted', 'carrier_map', null],
      ['2031-03-12T09:15:00Z', 'registered', 'carrier_map', null],
    ]);
    expect(result.events![1]!.description).toBe('Your package has arrived at the terminal in Norrvika.');
    expect(result.events!.every(event => event.local_time === undefined && event.provider_code === undefined)).toBe(true);
  });

  it('follows a failed round to the parcel locker, a new attempt keeping the stage before it', () => {
    const result = parseEarlyBird(JSON.parse(text('locker')), LOCKER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2031-05-08T16:40:12Z' });
    // A route or dock named with a digit is no town.
    expect(rows(result)).toEqual([
      ['2031-05-08T16:40:12Z', 'delivered', 'carrier_map', null],
      ['2031-05-08T09:30:00Z', 'ready_for_pickup', 'carrier_map', null],
      ['2031-05-07T22:10:00Z', 'in_transit', 'carrier_map', null],
      ['2031-05-07T08:00:00Z', 'failed_attempt', 'carrier_map', null],
      ['2031-05-07T04:55:00Z', 'failed_attempt', 'carrier_map', null],
      ['2031-05-06T12:00:00Z', 'failed_attempt', 'none', null],
      ['2031-05-06T05:45:00Z', 'failed_attempt', 'carrier_map', null],
      ['2031-05-06T01:20:00Z', 'in_transit', 'carrier_map', null],
      ['2031-05-05T19:00:00Z', 'accepted', 'carrier_map', null],
      ['2031-05-05T10:00:00Z', 'registered', 'carrier_map', null],
    ]);
    const waiting = parseEarlyBird(edited('locker', payload => { payload.events.splice(0, 2); }), LOCKER);
    expect(waiting).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(waiting.delivered_at).toBeUndefined();
    // The newest scan is the notice: the parcel keeps the failed round's stage.
    const rebooked = parseEarlyBird(edited('locker', payload => { payload.events.splice(0, 5); }), LOCKER);
    expect(rebooked).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map',
      last_status_text: 'We have scheduled a new attempt to deliver your package.', last_update: '2031-05-06T12:00:00Z' });
  });

  it('reads the earlier system’s Swedish scans with their wall clocks, inventing no offset', () => {
    const result = parseEarlyBird(JSON.parse(text('legacy')), LEGACY);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null, last_update_local: '2030-11-20T04:31:05' });
    expect(result.delivered_at).toBeUndefined();
    expect(rows(result)).toEqual([
      ['2030-11-20T04:31:05', 'delivered', 'carrier_map', null],
      ['2030-11-20T01:10:44', 'in_transit', 'carrier_map', 'Norrvika'],
      ['2030-11-19T21:02:13', 'in_transit', 'carrier_map', 'Lindhamra'],
      ['2030-11-18T13:13:27', 'registered', 'carrier_map', null],
    ]);
    expect(result.events!.every(event => event.time === undefined)).toBe(true);
  });

  it('keeps a new wording visible without a stage, and reads a repeated scan once', () => {
    const result = parseEarlyBird(edited('door', payload => {
      payload.events.unshift({ text: 'Synthetic event.', occurredAt: '2031-03-14T06:00:00Z' }, { ...payload.events[0]! });
    }), DOOR);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Synthetic event.',
      last_update: '2031-03-14T06:00:00Z' });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events![0]).toEqual({ time: '2031-03-14T06:00:00Z', description: 'Synthetic event.' });
    const unknown = parseEarlyBird(edited('door', payload => { payload.events = [{ text: 'Synthetic event.', occurredAt: '2031-03-14T06:00:00Z' }]; }), DOOR);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic event.' });
    expect(unknown.current_stage).toBeUndefined();
    const doubled = parseEarlyBird(edited('door', payload => { payload.events.push(...payload.events.map(row => ({ ...row }))); }), DOOR);
    expect(doubled.events).toHaveLength(5);
  });

  it('marks the history cut at the twenty scans the service sends', () => {
    const scans = (count: number) => edited('door', payload => {
      payload.events.splice(1, 0, ...Array.from({ length: count - 5 }, (_, index) =>
        ({ text: 'Your package has arrived at the terminal in Norrvika.', occurredAt: `2031-03-14T00:${String(59 - index).padStart(2, '0')}:00Z` })));
    });
    expect(parseEarlyBird(scans(20), DOOR)).toMatchObject({ history_truncated: true, current_stage: 'delivered' });
    expect(parseEarlyBird(scans(19), DOOR).history_truncated).toBeUndefined();
  });

  it('hands a parcel passed on to PostNord, DSV or DB Schenker to that partner, under the same number', () => {
    const result = parseEarlyBird(JSON.parse(text('handover')), DOOR);
    expect(result).toEqual({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Your package is delivered by PostNord.', last_update: null, expected_delivery: null, summary_only: true,
      delivery_carrier: 'postnord', events: [] });
    for (const url of ['https://www.dsv.com/en/tools/track-and-trace', 'https://www.dbschenker.com/app/tracking-public/']) {
      expect(parseEarlyBird(edited('handover', payload => { payload.action = { label: 'Track', url }; }), DOOR), url)
        .toMatchObject({ delivery_carrier: 'dsv', summary_only: true });
    }
    // The page follows only those three origins over HTTPS.
    for (const action of [null, {}, { label: 'Track', url: 'not a link' }, { label: 'Track', url: 'http://www.postnord.se/track' },
      { label: 'Track', url: 'https://postnord.se/track' }, { label: 'Track', url: 'https://user:secret@www.postnord.se/track' },
      { label: 'Track', url: 'https://www.postnord.se.example.invalid/track' }]) {
      expect(() => parseEarlyBird(edited('handover', payload => { payload.action = action; }), DOOR), JSON.stringify(action))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseEarlyBird(edited('handover', payload => { payload.events = [{ text: 'Synthetic', occurredAt: '2031-01-01T00:00:00Z' }]; }), DOOR))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps malformed replies apart from missing parcels', () => {
    for (const payload of [null, [], 'timeline', {}, { type: 'timeline', status: {}, events: [] }, edited('door', payload => { payload.type = 'map'; }),
      edited('door', payload => { payload.events = []; }), edited('door', payload => { (payload as { events: unknown }).events = {}; }),
      edited('door', payload => { payload.events = Array.from({ length: 201 }, (_, index) => ({ text: 'Synthetic', occurredAt: `2031-01-01T00:00:${String(index % 60).padStart(2, '0')}Z` })); })]) {
      expect(() => parseEarlyBird(payload, DOOR), JSON.stringify(payload).slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const row of [{ text: 'Synthetic' }, { occurredAt: '2031-01-01T00:00:00Z' }, { text: ' ', occurredAt: '2031-01-01T00:00:00Z' },
      { text: 'Synthetic', occurredAt: 'yesterday' }, { text: 'Synthetic', occurredAt: '2031-02-30T10:00:00' },
      { text: 'Synthetic', occurredAt: '2031-03-14T24:00:00' }, { text: 'Synthetic', occurredAt: 1_900_000_000 }]) {
      expect(() => parseEarlyBird(edited('door', payload => { payload.events[2] = row; }), DOOR), JSON.stringify(row))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads tracking_not_found as a missing parcel during retrieval and recognition', async () => {
    const absent = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('not-found'), 404));
    await expect(carrier(absent).track({ number: DOOR })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(absent).recognize!(DOOR)).resolves.toEqual({ known: false });
    const found = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('door'))).mockResolvedValueOnce(reply(text('legacy')))
      .mockResolvedValueOnce(reply(text('handover')));
    await expect(carrier(found).recognize!(DOOR)).resolves.toEqual({ known: true, lastActivityAt: '2031-03-14T05:12:44.120Z' });
    // A local clock dates the last activity without an instant, and a handover has no clock.
    await expect(carrier(found).recognize!(LEGACY)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2030-11-20T04:31:05' });
    await expect(carrier(found).recognize!(DOOR)).resolves.toEqual({ known: true, lastActivityAt: null });
    expect(found).toHaveBeenCalledTimes(3);
  });

  it('keeps a refused number, rate limits, challenges and other refusals apart from missing parcels', async () => {
    const refused = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('invalid'), 400));
    await expect(carrier(refused).track({ number: DOOR })).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(carrier(refused).recognize!(DOOR)).resolves.toEqual({ known: false });
    const limited = vi.fn<typeof fetch>().mockImplementation(async () =>
      reply('{"code":"rate_limited","message":"Synthetic","requestId":"req-synthetic"}', 429, { 'Content-Type': 'application/json', 'Retry-After': '7' }));
    await expect(carrier(limited).track({ number: DOOR })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 7000 });
    await expect(carrier(limited).recognize!(DOOR)).rejects.toMatchObject({ kind: 'rate_limited' });
    for (const [body, status, headers, kind] of [
      ['{"code":"tracking_unavailable","requestId":"req-synthetic"}', 404, {}, 'indeterminate'],
      ['{"code":"tracking_unavailable","requestId":"req-synthetic"}', 400, {}, 'indeterminate'],
      ['{"error":{"code":"rate_limited"}}', 400, {}, 'rate_limited'],
      ['{"error":"tracking_not_found"}', 404, {}, 'not_found'],
      ['{}', 429, {}, 'rate_limited'],
      ['<html><title>Too many requests</title></html>', 429, {}, 'rate_limited'],
      ['<html><title>Vercel Security Checkpoint</title></html>', 429, { 'x-vercel-mitigated': 'challenge' }, 'challenge'],
      ['<html><title>Vercel Security Checkpoint</title></html>', 200, {}, 'challenge'],
      ['{}', 200, { 'x-vercel-mitigated': 'challenge' }, 'challenge'],
      ['<html><head><title>Just a moment...</title></head></html>', 200, {}, 'challenge'],
      ['<!DOCTYPE html><html><body>404: This page could not be found.</body></html>', 404, {}, 'transport'],
      ['<html><body>Underhåll</body></html>', 200, {}, 'schema'],
      ['', 200, {}, 'schema'],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body, status, { 'Content-Type': 'text/html', ...headers }));
      await expect(carrier(fetcher).track({ number: DOOR }), `${status} ${body}`).rejects.toMatchObject({ kind });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(300_000)));
    await expect(carrier(large).track({ number: DOOR })).rejects.toThrow('unexpectedly large');
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('not-found'), status));
      await expect(carrier(fetcher).track({ number: DOOR })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DOOR)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('takes what the tracking page takes, and SSCCs only when their check digit passes, without a request for the rest', async () => {
    expect(normalizeEarlyBirdNumber(' 0037 3402 2169 9999 9990 ')).toBe(DOOR);
    expect(normalizeEarlyBirdNumber('eb12345678')).toBe('EB12345678');
    expect(normalizeEarlyBirdNumber('9990000000000000001')).toBe('9990000000000000001');
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['00373402216999999991', '1234567', 'A'.repeat(31), `${DOOR}/x`, 'EB_1234567', '']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    // The reply does not echo the number: it belongs to the number asked for.
    expect(() => parseEarlyBird(JSON.parse(text('door')), '00373402216999999991')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    // A number under another prefix is still Early Bird's to look up when filed under it.
    const any = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('not-found'), 404));
    await expect(carrier(any).track({ number: FOREIGN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(any).toHaveBeenCalledOnce();
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('door')));
    await expect(carrier(flaky).track({ number: DOOR })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('door')));
    await expect(carrier(immediate).track({ number: DOOR }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DOOR }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DOOR }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a parcel filed under Early Bird to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('door')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DOOR, carrier: 'early-bird' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'early-bird', source: 'early-bird', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === EARLY_BIRD_ENDPOINT)).toBe(true);
  });

  it('suggests Early Bird alone first for SSCCs under its GS1 prefix and asks it, with PostNord after it', () => {
    for (const number of [DOOR, EXTENDED]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['early-bird'] });
      expect(detectCarrierMatch(number).candidates, number).toContain('postnord');
      expect(recognitionAskedCarriers(number)[0], number).toBe('early-bird');
    }
    // Under another Swedish prefix, Bring's and PostNord's rules still come first.
    expect(detectCarrierMatch(FOREIGN).preferred).toEqual(['bring-posten']);
    expect(detectCarrierMatch('00873402217999999992').preferred).toEqual(['postnord']);
    for (const number of [FOREIGN, LEGACY, '00373402216999999991', DOOR.slice(2)]) {
      expect(recognitionAskedCarriers(number), number).not.toContain('early-bird');
    }
    for (const link of [`https://earlybird.se/spara-och-hjalp?id=${DOOR}`, `https://earlybird.se/en/track-and-help?id=${DOOR}`,
      `https://earlybird.se/tracking/?id=${DOOR}`, `https://track.earlybird.se/oversikt?a=${DOOR}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DOOR, carrier: 'early-bird', source: 'link' });
    }
  });
});

describe('Early Bird status vocabulary', () => {
  it('records every wording with the stage the map gives, and the notices it leaves without one', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(earlyBirdWordingStage(entry.wording), entry.wording).toBe(stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(stage);
      expect(statusMapAnswer({ carrier: 'early-bird', description: entry.wording }), entry.wording)
        .toEqual(stage ? { kind: 'mapped', stage } : expect.objectContaining({ kind: 'intentional_gap' }));
    }
    expect(earlyBirdWordingStage('  Your package has arrived   at the terminal in Norrvika. ')).toBe('in_transit');
    for (const wording of ['constructor', 'Your package has arrived at the terminal in .', 'The package has been delivered', '']) {
      expect(earlyBirdWordingStage(wording), wording).toBeUndefined();
    }
    expect(statusMap.stage('7', 'the package has been delivered to your door.')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'early-bird', description: 'Synthetic event' })).toEqual({ kind: 'unknown' });
    // The shared rules would read the promise of a delivery as one.
    const failed = 'We failed to deliver your package as planned. We will notify you as soon as possible with information on how we will ensure that your package is delivered.';
    expect(classifyWording(failed, 'in_transit').stage).not.toBe('failed_attempt');
    expect(earlyBirdWordingStage(failed)).toBe('failed_attempt');
  });
});
