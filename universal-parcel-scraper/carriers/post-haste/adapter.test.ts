import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer, STATUS_MAPS } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { NZ_COURIERS_API } from '../nz-couriers/adapter.js';
import { statusMap as nzCouriersMap } from '../nz-couriers/status.js';
import { adapter, POST_HASTE_API, PostHasteTracker } from './adapter.js';
import { parsePostHaste, postHasteQuery } from './parser.js';
import { statusMap } from './status.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'ZZZZ 01234566';
const IN_TRANSIT = '01234567';
const UNKNOWN = '00000000000000000000';

type Row = Record<string, unknown>;
type Item = Row & { trackingEvents: Row[] };
type Reply = Row & { consignmentItems: Item[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply, scans: Row[]) => void) => {
  const reply = fixture(name);
  change(reply, reply.consignmentItems[0]!.trackingEvents);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const empty = () => new Response(null, { status: 204 });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const VALIDATION = { errors: { query: ['The field query must be a string or array type with a minimum length of \'6\'.'] },
  type: 'https://httpstatuses.com/400', title: 'REQUEST_VALIDATION_ERROR', status: 400 };

describe('Post Haste HTTP adapter', () => {
  it('asks the Freightways lookup under Post Haste’s name once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PostHasteTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch('zzzz-01234566', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(POST_HASTE_API).toBe(NZ_COURIERS_API.replace('/NZCouriers/', '/PostHaste/'));
    // The ticket number loses its leading zeros, as on the group's tracking pages.
    expect(String(url)).toBe(`${POST_HASTE_API}?searchType=TK&ticketProductCode=ZZZZ&query=1234566`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.method ?? 'GET').toBe('GET');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'post-haste', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('asks for a ticket with a product code of two to four letters, and for a charge label or SSCC alone', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => empty());
    for (const number of ['ZZ 01234567', 'zzz-01234567', '01234567', UNKNOWN]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'not_found', provider: 'Post Haste' });
    }
    // A ticket the lookup does not hold may be a customer printed label's consignment number, asked whole.
    expect(fetcher.mock.calls.map(([url]) => String(url).slice(POST_HASTE_API.length))).toEqual([
      '?searchType=TK&ticketProductCode=ZZ&query=1234567',
      '?query=ZZ01234567',
      '?searchType=TK&ticketProductCode=ZZZ&query=1234567',
      '?query=ZZZ01234567',
      '?query=1234567',
      `?query=${UNKNOWN}`,
    ]);
  });

  it('reads a customer printed label by its consignment number, after the sender’s account', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(reply(changed('delivered', (body) => { body.shortConsignmentId = '0000000 ZZZ123456'; })));
    await expect(carrier(fetcher).track({ number: 'zzz 123456' })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url).slice(POST_HASTE_API.length)))
      .toEqual(['?searchType=TK&ticketProductCode=ZZZ&query=123456', '?query=ZZZ123456']);
    // A ticket too short once its zeros go, or a code longer than a ticket's, is asked whole alone.
    const whole = vi.fn<typeof fetch>().mockImplementation(async () => empty());
    for (const number of ['ZZZZ 00012345', 'ZZZZZ 01234567']) {
      await expect(carrier(whole).track({ number }), number).rejects.toMatchObject({ kind: 'not_found' });
    }
    expect(whole.mock.calls.map(([url]) => String(url).slice(POST_HASTE_API.length))).toEqual(['?query=ZZZZ00012345', '?query=ZZZZZ01234567']);
  });

  it('keeps a delivered ticket without the signatory, the photo, the tag or the postcode', () => {
    const result = parsePostHaste(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-10T23:45:12.500Z', delivered_at: '2026-03-10T23:45:12.500Z',
      expected_delivery: null });
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage ?? null, event.location ?? null])).toEqual([
      ['2026-03-10T23:45:12.500Z', 'D', 'delivered', 'Sample Hills, Sample District'],
      ['2026-03-10T19:30:21.004Z', 'ONBD', 'out_for_delivery', null],
      ['2026-03-09T03:10:00Z', 'P', 'accepted', 'Sample Park, Sample City'],
      ['2026-03-08T20:00:00Z', 'LC', 'registered', null],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Signer|example\.invalid|A0000000000|Authority|0000"|SAMPLETON|SMH|00-000|barcode|New Zealand"/);
  });

  it('names New Zealand Couriers as the delivery carrier when it made the newest scan, with the estimate', () => {
    const result = parsePostHaste(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Out for Delivery',
      last_update: '2026-02-18T18:05:09.310Z', expected_delivery: '2026-02-19', delivery_carrier: 'nz-couriers' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.provider_code, event.stage ?? null])).toEqual([
      ['ONBD', 'out_for_delivery'], ['STAT/RZDEL', 'in_transit'], ['P', 'accepted'], ['LC', 'registered'],
    ]);
    expect(parsePostHaste(changed('in-transit', (_body, scans) => { scans.at(-1)!.carrierName = 'PostHaste'; }), IN_TRANSIT))
      .not.toHaveProperty('delivery_carrier');
  });

  it('counts a consignment only when it names the whole number asked', () => {
    expect(parsePostHaste(changed('delivered', (body) => { body.shortConsignmentId = 'zzzz 1234566'; }), 'ZZZZ01234566').events).toHaveLength(4);
    expect(parsePostHaste(changed('in-transit', (body) => { body.shortConsignmentId = '1234567'; }), IN_TRANSIT).events).toHaveLength(4);
    // The ticket's layout fits a customer printed label's consignment number too.
    expect(parsePostHaste(changed('delivered', (body) => { body.shortConsignmentId = '0000000 ZZZZ01234566'; }), DELIVERED).events).toHaveLength(4);
    for (const [shortId, number] of [
      ['ZZZ 01234566', DELIVERED],
      ['ZZZZ 01234568', DELIVERED],
      ['01234566', DELIVERED],
      // A customer printed label whose consignment number is the label asked.
      ['0000000 01234567', IN_TRANSIT],
      ['ZZZZ 01234567', IN_TRANSIT],
      ['01234568', IN_TRANSIT],
    ] as const) {
      expect(() => parsePostHaste(changed('delivered', (body) => { body.shortConsignmentId = shortId; }), number), shortId)
        .toThrow(expect.objectContaining({ kind: 'indeterminate', provider: 'Post Haste', message: 'Post Haste answered for another consignment' }));
    }
  });

  it('reads a consignment without scans as no history, and rejects a changed reply', () => {
    expect(() => parsePostHaste(changed('delivered', (body) => { body.consignmentItems = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError', provider: 'Post Haste' }));
    for (const change of [
      (body: Reply) => { delete body.shortConsignmentId; },
      (body: Reply) => { body.consignmentItems = 'parcels' as never; },
      (_body: Reply, scans: Row[]) => { scans[1]!.createdOn = '2026-03-09T03:10:00'; },
      (_body: Reply, scans: Row[]) => { scans[1]!.location = 'Sample Park'; },
    ]) {
      expect(() => parsePostHaste(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema', provider: 'Post Haste' }));
    }
  });

  it('keeps an unknown number, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(empty())).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup({ message: 'Not Found' }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://posthaste.co.nz/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(VALIDATION, { status: 400 })).rejects.toMatchObject({ kind: 'invalid_input', message: 'Post Haste refused the number' });
    await expect(lookup('<html><title>Bad Request</title></html>', { status: 400 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><script src="https://sample.awswaf.com/challenge.js"></script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge', message: 'Post Haste answered with a browser check' });
    await expect(lookup('<html><title>Post Haste</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('declares no recognition', () => {
    expect(carrier(vi.fn<typeof fetch>()).recognize).toBeUndefined();
  });

  it('rejects numbers Post Haste does not print and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // An all-zero label or ticket, a ticket too short once its zeros go that is too short for a consignment
    // number, a code of one letter or with a digit, a nine-digit label, letters before nine digits (another
    // carrier's layout, such as Purolator's PIN) and an SSCC that fails its check digit.
    for (const number of ['00000000', 'ZZ 00000000', 'ZZZZ 00123', 'Z 01234567', 'E60 1234567', '123456789', 'ZZZ123456789',
      '1234567', '0000000 01234567', '00000000000000000011', 'SAMPLETRACKING', `ZZ${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input', provider: 'Post Haste' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(postHasteQuery('zzzz 01234566')).toEqual({ kind: 'ticket', number: 'ZZZZ01234566', code: 'ZZZZ', query: '1234566' });
    expect(postHasteQuery('0123-4567')).toEqual({ kind: 'label', number: '01234567', query: '1234567' });
  });

  it('gives its one read the whole budget and ends a hanging read inside it', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a number filed under Post Haste to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'post-haste' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'post-haste', source: 'post-haste', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(POST_HASTE_API))).toBe(true);
  });
});

describe('Post Haste status vocabulary', () => {
  it('uses New Zealand Couriers’ map of the group’s scan types', () => {
    expect(statusMap).toBe(nzCouriersMap);
    expect(STATUS_MAPS['post-haste']).toBe(nzCouriersMap);
    expect(statusMapAnswer({ carrier: 'post-haste', providerCode: 'D', description: 'Delivered' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'post-haste', providerCode: 'STAT/HLDFR8', description: 'Held Freight Office' }))
      .toMatchObject({ kind: 'intentional_gap' });
  });
});
