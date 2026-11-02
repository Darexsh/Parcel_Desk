import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, POST_LUXEMBOURG_ENDPOINT, PostLuxembourgTracker } from './adapter.js';
import { parsePostLuxembourg } from './parser.js';
import { postLuxembourgCodeStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ZZ000000014LU';
const TRANSIT = 'ZZ000000028LU';
const ABSENT = 'ZZ999999995LU';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

interface Row { eventDate?: unknown; place?: unknown; label?: unknown; eventTypeCode?: unknown; displayOrder?: unknown; category?: number }
interface Item { trackingNumber?: unknown; error?: unknown; trackedEvents?: Row[] }
interface Reply { status?: unknown; items?: Item[] }
const edited = (name: string, change: (payload: Reply, events: Row[]) => void): Reply => {
  const payload = JSON.parse(text(name)) as Reply;
  change(payload, payload.items![0]!.trackedEvents!);
  return payload;
};
const rows = (result: ReturnType<typeof parsePostLuxembourg>) =>
  result.events!.map(event => [event.local_time, event.provider_code, event.stage ?? null, event.location ?? null]);

describe('POST Luxembourg tracking adapter', () => {
  it('posts the whole number once to the tracking service, in English with the page’s client id, and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PostLuxembourgTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 000 000 014 lu ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://api.post.lu/services/trackandtrace-api/items');
    expect(init).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal), body: `{"ids":["${DELIVERED}"]}`,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Accept-Language': 'en',
        'X-IBM-Client-Id': expect.stringMatching(/^[0-9a-f-]{36}$/), 'User-Agent': 'SyntheticHost/1.0' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'post-luxembourg', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads an item sent abroad and delivered there as days, newest first', () => {
    const result = parsePostLuxembourg(JSON.parse(text('delivered')), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Final delivery', last_update: null, last_update_local: '2026-03-12', expected_delivery: null });
    expect(rows(result)).toEqual([
      ['2026-03-12', 'EMI', 'delivered', null],
      ['2026-03-12', 'EDG', 'out_for_delivery', null],
      ['2026-03-11', 'EMG', 'in_transit', null],
      ['2026-03-10', 'EDD', 'in_transit', null],
      ['2026-03-10', 'EMF', 'in_transit', 'SAMPLE EXCHANGE'],
      ['2026-03-10', 'EMD', 'in_transit', 'SAMPLE EXCHANGE'],
      ['2026-03-09', 'EMC', 'in_transit', null],
      ['2026-03-08', 'EMA', 'accepted', 'Bureau de poste Exemple'],
    ]);
    expect(result.events!.every(event => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result.pickup_point).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/category|activeStep|displayOrder/);
    // Out of order in the reply, by day and then the service's own order in the result.
    const shuffled = edited('delivered', (_, events) => { events.reverse(); });
    expect(rows(parsePostLuxembourg(shuffled, DELIVERED))).toEqual(rows(result));
    expect(parsePostLuxembourg(JSON.parse(text('in-transit')), TRANSIT)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'Departure from outward office of exchange', last_update_local: '2026-02-17' });
  });

  it('keeps the reply’s order without a display order, counts a repeated event once and reads only the text of a place', () => {
    const payload = edited('in-transit', (_, events) => {
      events.unshift({ eventDate: '2026-02-18', place: 'Bureau de distribution <b>Exemple</b>, L-9999', label: 'Arrival at delivery facility',
        eventTypeCode: 'EMG', displayOrder: null, category: 4 });
      events.unshift({ eventDate: '2026-02-18', place: null, label: 'Item out for delivery', eventTypeCode: 'EDG', displayOrder: null, category: 4 });
      events.push({ ...events.at(-1)! });
    });
    expect(rows(parsePostLuxembourg(payload, TRANSIT))).toEqual([
      ['2026-02-18', 'EDG', 'out_for_delivery', null],
      ['2026-02-18', 'EMG', 'in_transit', 'Bureau de distribution Exemple'],
      ['2026-02-17', 'EMC', 'in_transit', null],
      ['2026-02-16', 'EMA', 'accepted', 'Espace POST Exemple'],
    ]);
  });

  it('stages new codes through the shared wording rules and keeps the rest visible', () => {
    const returned = edited('in-transit', (_, events) => { events.unshift({ ...events[0]!, eventDate: '2026-02-20', eventTypeCode: 'EMX', label: 'Item returned to sender' }); });
    expect(parsePostLuxembourg(returned, TRANSIT)).toMatchObject({ status: 'exception', current_stage: 'returned',
      current_stage_source: 'wording:language', last_status_text: 'Item returned to sender' });
    const unknown = edited('in-transit', (_, events) => {
      events.unshift({ eventDate: '2026-02-20', place: null, label: 'Item weighed at counter', eventTypeCode: 'ZZQ', displayOrder: 1 });
    });
    const result = parsePostLuxembourg(unknown, TRANSIT);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Item weighed at counter' });
    expect(result.current_stage).toBeUndefined();
    expect(result.events![0]).toEqual({ local_time: '2026-02-20', description: 'Item weighed at counter', provider_code: 'ZZQ' });
  });

  it('answers only for the requested number and rejects malformed histories', () => {
    for (const payload of [null, [], {}, { status: 'DONE' }, { status: 'DONE', items: {} }, { status: 'DONE', items: [] },
      edited('delivered', reply => { reply.items![0]!.trackingNumber = 'ZZ000000028LU'; }),
      edited('delivered', reply => { reply.items![0]!.trackingNumber = undefined; }),
      edited('delivered', reply => { reply.items!.push(reply.items![0]!); }),
      edited('delivered', reply => { reply.items![0]!.trackedEvents = undefined; }),
      edited('delivered', (_, events) => { events[2]!.eventDate = '2026-03-11T10:00:00'; }),
      edited('delivered', (_, events) => { events[2]!.eventDate = '2026-02-30'; }),
      edited('delivered', (_, events) => { events[2]!.eventDate = null; }),
      edited('delivered', (_, events) => { events[2]!.eventTypeCode = null; }),
      edited('delivered', (_, events) => { events[2]!.eventTypeCode = { code: 'EMG' }; }),
      edited('delivered', (_, events) => { (events as unknown[])[2] = 'scan'; })]) {
      expect(() => parsePostLuxembourg(payload, DELIVERED), JSON.stringify(payload).slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // The service names the number in capitals.
    expect(parsePostLuxembourg(edited('delivered', reply => { reply.items![0]!.trackingNumber = 'zz000000014lu'; }), DELIVERED))
      .toMatchObject({ status: 'delivered' });
    expect(() => parsePostLuxembourg(edited('delivered', reply => { reply.status = 'IN_PROGRESS'; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePostLuxembourg(JSON.parse(text('delivered')), 'ZZ000000015LU')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('reads only the service’s not-found word without events as a missing item', () => {
    expect(() => parsePostLuxembourg(JSON.parse(text('not-found')), ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const absent = (change: (item: Item) => void) => {
      const payload = JSON.parse(text('not-found')) as Reply;
      change(payload.items![0]!);
      return payload;
    };
    for (const payload of [absent(item => { item.error = 'service.unavailable'; }), absent(item => { item.error = null; }),
      absent(item => { item.trackedEvents = (JSON.parse(text('in-transit')) as Reply).items![0]!.trackedEvents; })]) {
      expect(() => parsePostLuxembourg(payload, ABSENT), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('recognizes a known item and the not-found word, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('delivered'))).mockResolvedValueOnce(reply(text('not-found')));
    // A day alone dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-12T00:00:00' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('takes S10 codes with a valid check digit, from any country, and nothing else, without a request', async () => {
    const inbound = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered').replaceAll(DELIVERED, 'ZZ000000031DE')));
    await expect(carrier(inbound).track({ number: 'ZZ000000031DE' })).resolves.toMatchObject({ status: 'delivered' });
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ000000015LU', 'ZZ00000001LU', '123456789012', 'ABC']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('{"httpCode":0,"moreInformation":"Error"}', status));
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps block pages and malformed replies apart from missing items', async () => {
    for (const [body, kind] of [
      ['<html><head><title>Request Rejected</title></head><body>The requested URL was rejected.</body></html>', 'challenge'],
      ['<html><body>Maintenance</body></html>', 'schema'], ['', 'schema'], ['{"items":[]}', 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
      await expect(carrier(fetcher).recognize!(DELIVERED), body).rejects.toMatchObject({ kind });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(300_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
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
  });

  it('routes an item filed under POST Luxembourg to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'post-luxembourg' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'post-luxembourg', source: 'post-luxembourg', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === POST_LUXEMBOURG_ENDPOINT)).toBe(true);
  });

  it('is asked about Luxembourg S10 codes, which detection leaves with the postal fallback, and reads its links', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers(DELIVERED)[0]).toBe('post-luxembourg');
    expect(recognitionAskedCarriers('ZZ000000015LU')).not.toContain('post-luxembourg');
    expect(recognitionAskedCarriers('ZZ000000031DE')).not.toContain('post-luxembourg');
    for (const link of [`https://www.post.lu/en/particuliers/colis-courrier/track-and-trace#/search?numero=${DELIVERED}`,
      `https://www.post.lu/particuliers/colis-courrier/track-and-trace#/search/?numero=${DELIVERED}`,
      `https://www.trackandtrace.lu/?numero=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'post-luxembourg', source: 'link' });
    }
  });
});

describe('POST Luxembourg status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(postLuxembourgCodeStage(entry.code), entry.code).toBe(entry.stage);
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase())).toBe(entry.stage);
    }
    for (const code of ['constructor', 'toString', 'EZZ', '']) expect(postLuxembourgCodeStage(code), code).toBeUndefined();
    expect(statusMap.stage(null, 'final delivery')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'post-luxembourg', providerCode: 'EMA', description: 'Entry into the postal network' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
  });
});
