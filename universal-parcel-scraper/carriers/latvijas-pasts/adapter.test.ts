import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, LATVIJAS_PASTS_ENDPOINT, LatvijasPastsTracker } from './adapter.js';
import { parseLatvijasPasts } from './parser.js';
import { latvijasPastsCodeStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const COLLECTED = 'ZZ000000014DE';
const ABROAD = 'ZZ000000014LV';
const ABSENT = 'ZZ000000028LV';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json; charset=UTF-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

interface Row { event_timestamp?: unknown; event_code?: unknown; event?: unknown; office?: string; country?: string; event_group_sequence_number?: unknown }
interface Reply { status?: number; data?: Row[]; info?: string }
const edited = (name: string, change: (payload: Reply) => void): Reply => {
  const payload = JSON.parse(text(name)) as Reply;
  change(payload);
  return payload;
};
const rows = (result: ReturnType<typeof parseLatvijasPasts>) =>
  result.events!.map(event => [event.time ?? event.local_time, event.provider_code, event.stage ?? null, event.location ?? null]);

describe('Latvijas Pasts tracking adapter', () => {
  it('asks the tracking service for the whole number once, in English JSON, and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('collected')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new LatvijasPastsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 000 000 014 de ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://mans.pasts.lv/tracking-api?id=${COLLECTED}&lang=en-US&include_group=true`);
    expect(init).toMatchObject({ signal: expect.any(AbortSignal), headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init?.method ?? 'GET').toBe('GET');
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'latvijas-pasts', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it("reads an item from abroad collected from a customer centre, each scan on its country's clock and once", () => {
    const result = parseLatvijasPasts(JSON.parse(text('collected')), COLLECTED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Item delivered', last_update: '2026-03-12T12:12:56+02:00', expected_delivery: null,
      pickup_point: 'Customer centre: Example' });
    expect(rows(result)).toEqual([
      ['2026-03-12T12:12:56+02:00', '37', 'delivered', 'Customer centre: Example'],
      ['2026-03-11T09:30:22+02:00', '1134', 'ready_for_pickup', 'Customer centre: Example'],
      ['2026-03-11T09:22:09+02:00', '1120', 'in_transit', 'Customer centre: Example'],
      ['2026-03-10T23:24:49+02:00', '1113', 'in_transit', 'SAMPLE EXCHANGE (PARCELS)'],
      ['2026-03-09T09:04:46+02:00', '30', 'in_transit', 'SAMPLE EXCHANGE (PARCELS)'],
      // The foreign post's events name its country and keep its clock; the repeated posting counts once.
      ['2026-03-07T08:15:00+01:00', '12', 'in_transit', 'GERMANY'],
      ['2026-03-07T03:23:00+01:00', '3', 'in_transit', 'GERMANY'],
      ['2026-03-07T03:23:00+01:00', '8', 'in_transit', 'GERMANY'],
      ['2026-03-06T09:06:00+01:00', '1', 'accepted', 'GERMANY'],
    ]);
    expect(result.events!.every(event => event.local_time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result).not.toHaveProperty('last_update_local');
    expect(JSON.stringify(result)).not.toMatch(/next_office|"901"/);
    // Waiting at the office is current before the collection.
    const waiting = edited('collected', payload => { payload.data!.shift(); });
    expect(parseLatvijasPasts(waiting, COLLECTED)).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup',
      last_status_text: 'Notification - pick-up invitation printed', pickup_point: 'Customer centre: Example' });
  });

  it('keeps a Latvian scan the autumn change of clocks makes ambiguous as a local time', () => {
    const result = parseLatvijasPasts(edited('collected', payload => {
      payload.data![0]!.event_timestamp = '2026-10-25 03:30:00.000';
    }), COLLECTED);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-10-25T03:30:00' });
    expect(result.events![0]).toMatchObject({ local_time: '2026-10-25T03:30:00', provider_code: '37' });
    expect(result.events![0]!.time).toBeUndefined();
  });

  it('reads an item sent abroad, keeps customs release apart from a return and names no pickup point for a door delivery', () => {
    const result = parseLatvijasPasts(JSON.parse(text('abroad')), ABROAD);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-02-20T16:05:00+01:00' });
    expect(result.pickup_point).toBeUndefined();
    expect(rows(result)).toEqual([
      ['2026-02-20T16:05:00+01:00', '37', 'delivered', 'FRANCE'],
      ['2026-02-20T09:17:00+01:00', '39', 'out_for_delivery', 'FRANCE'],
      ['2026-02-19T18:37:00+01:00', '30', 'in_transit', 'FRANCE'],
      ['2026-02-17T02:10:15+02:00', '8', 'in_transit', 'SAMPLE EXCHANGE (PARCELS)'],
      ['2026-02-17T00:54:00+02:00', '69', 'in_transit', 'SAMPLE EXCHANGE (PARCELS)'],
      ['2026-02-17T00:53:00+02:00', '7', 'in_transit', 'SAMPLE EXCHANGE (PARCELS)'],
      ['2026-02-17T00:52:00+02:00', '4', 'customs', 'SAMPLE EXCHANGE (PARCELS)'],
      ['2026-02-17T00:51:00+02:00', '3', 'in_transit', 'SAMPLE EXCHANGE (PARCELS)'],
      // The company's own name places nothing.
      ['2026-02-16T14:40:51+02:00', '35', 'in_transit', null],
      // At the same second, the later progress group first.
      ['2026-02-16T14:38:36+02:00', '32', 'in_transit', null],
      ['2026-02-16T14:38:36+02:00', '1', 'accepted', null],
      ['2026-02-16T10:56:06+02:00', '1114', 'registered', null],
    ]);
    // Out of order in the reply, newest first in the result.
    const shuffled = edited('abroad', payload => { payload.data!.reverse(); });
    expect(rows(parseLatvijasPasts(shuffled, ABROAD))).toEqual(rows(result));
  });

  it('stages new codes through the shared wording rules, keeps the rest visible and drops office postcodes', () => {
    const returned = edited('abroad', payload => { payload.data!.unshift({ ...payload.data![0]!, event_code: '9999', event: 'Item returned to sender' }); });
    expect(parseLatvijasPasts(returned, ABROAD)).toMatchObject({ status: 'exception', current_stage: 'returned',
      current_stage_source: 'wording:language', last_status_text: 'Item returned to sender' });
    const unknown = edited('abroad', payload => {
      payload.data!.unshift({ event_timestamp: '2026-02-21 08:00:00.000', event_code: 9998, event: 'Item weighed at counter',
        office: 'Post office: Example 9, LV-9009', event_group_sequence_number: 3 });
    });
    const result = parseLatvijasPasts(unknown, ABROAD);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Item weighed at counter' });
    expect(result.current_stage).toBeUndefined();
    expect(result.events![0]).toEqual({ time: '2026-02-21T08:00:00+02:00', description: 'Item weighed at counter', provider_code: '9998',
      location: 'Post office: Example 9' });
    // A foreign post's event names a country, never a pickup point.
    const abroad = edited('abroad', payload => {
      payload.data!.splice(1, 0, { ...payload.data![1]!, event_timestamp: '2026-02-20 12:00:00', event_code: '9997', event: 'Item ready for collection' });
    });
    const collected = parseLatvijasPasts(abroad, ABROAD);
    expect(collected).toMatchObject({ current_stage: 'delivered' });
    expect(collected.events![1]).toMatchObject({ stage: 'ready_for_pickup', location: 'FRANCE' });
    expect(collected.pickup_point).toBeUndefined();
  });

  it('answers only for the requested number and rejects malformed histories', () => {
    for (const payload of [null, [], {}, { status: 1 }, { data: {} }, { data: 'none' }, { info: 7 },
      edited('abroad', reply => { reply.data![2]!.event_timestamp = '2026-02-19T18:37:00'; }),
      edited('abroad', reply => { reply.data![2]!.event_timestamp = '2026-02-30 18:37:00'; }),
      edited('abroad', reply => { reply.data![2]!.event_timestamp = undefined; }),
      edited('abroad', reply => { reply.data![2]!.event_code = 'EMD'; }),
      edited('abroad', reply => { reply.data![2]!.event_code = { code: '30' }; }),
      edited('abroad', reply => { (reply.data as unknown[])[2] = 'scan'; })]) {
      expect(() => parseLatvijasPasts(payload, ABROAD), JSON.stringify(payload).slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseLatvijasPasts(JSON.parse(text('abroad')), 'ZZ000000015LV')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('reads only the service’s no-information notice as a missing item', () => {
    expect(() => parseLatvijasPasts(JSON.parse(text('not-found')), ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseLatvijasPasts({ status: 1, info: 'Postal item number entered incorrectly. Please check it and enter it again.' }, ABSENT))
      .toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    for (const payload of [{ status: 1, info: 'Service temporarily unavailable' },
      // The Latvian wording is not pinned: the adapter asks for English.
      { status: 1, info: 'Par pasta sūtījuma izsekošanu informācija nav pieejama. Lūdzu, mēģini vēlāk vēlreiz!' },
      { status: 1, data: [] }]) {
      expect(() => parseLatvijasPasts(payload, ABSENT), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('recognizes a known item and the no-information notice, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('abroad'))).mockResolvedValueOnce(reply(text('not-found')));
    // The newest scan's clock ranks reuse of a number.
    await expect(carrier(fetcher).recognize!(ABROAD)).resolves.toEqual({ known: true, lastActivityAt: '2026-02-20T15:05:00.000Z' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('takes S10 codes with a valid check digit, from any country, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ000000015LV', 'ZZ00000001LV', '123456789012', 'ABC']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('{"message":"Error"}', status));
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('reads the notice the closed site answers HTTP 403 with as maintenance', async () => {
    const closed = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response('Temporary closed for technical reason.', { status: 403, headers: { 'Content-Type': 'text/plain' } }));
    await expect(carrier(closed).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'maintenance', name: 'MaintenanceError' });
    await expect(carrier(closed).recognize!(ABSENT)).rejects.toMatchObject({ kind: 'maintenance' });
    const other = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response('Closed? Try again later.', { status: 403, headers: { 'Content-Type': 'text/plain' } }));
    await expect(carrier(other).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('keeps block pages, XML and malformed replies apart from missing items', async () => {
    for (const [body, kind] of [
      ['<html><head><title>ERROR: The request could not be satisfied</title></head><body>Generated by cloudfront (CloudFront)</body></html>', 'challenge'],
      ['<?xml version="1.0" encoding="UTF-8"?>\n<response><status>1</status><info>No information</info></response>', 'schema'],
      ['<html><body>Maintenance</body></html>', 'schema'], ['', 'schema'], ['{"items":[]}', 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
      await expect(carrier(fetcher).recognize!(ABROAD), body).rejects.toMatchObject({ kind });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(300_000)));
    await expect(carrier(large).track({ number: ABROAD })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('abroad')));
    await expect(carrier(flaky).track({ number: ABROAD })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('abroad')));
    await expect(carrier(immediate).track({ number: ABROAD }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: ABROAD }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: ABROAD }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes an item filed under Latvijas Pasts to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('abroad')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: ABROAD, carrier: 'latvijas-pasts' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'latvijas-pasts', source: 'latvijas-pasts', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${LATVIJAS_PASTS_ENDPOINT}?`))).toBe(true);
  });

  it('is asked about Latvian S10 codes, which detection leaves with the postal fallback, and keeps its links', () => {
    expect(detectCarrierMatch(ABROAD)).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers(ABROAD)[0]).toBe('latvijas-pasts');
    expect(recognitionAskedCarriers('ZZ000000015LV')).not.toContain('latvijas-pasts');
    expect(recognitionAskedCarriers(COLLECTED)).not.toContain('latvijas-pasts');
    expect(parseTrackingInput(`https://mans.pasts.lv/track?locale=en-US&id=${ABROAD}`))
      .toMatchObject({ trackingNumber: ABROAD, carrier: 'latvijas-pasts', source: 'link' });
  });
});

describe('Latvijas Pasts status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(latvijasPastsCodeStage(entry.code), entry.code).toBe(entry.stage);
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase())).toBe(entry.stage);
    }
    for (const code of ['constructor', 'toString', '9999', '']) expect(latvijasPastsCodeStage(code), code).toBeUndefined();
    expect(statusMap.stage(null, 'item delivered')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'latvijas-pasts', providerCode: '7', description: 'Item returned from Customs' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'latvijas-pasts', providerCode: '1134', description: 'Notification - pick-up invitation printed' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
  });
});
