import { describe, expect, it, vi } from 'vitest';
import { carrierInfo } from '../../core/catalog/index.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { ninjaVanCountry, ninjaVanTrackingUrl } from '../../core/detection/ninjaVan.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import fixture from './fixtures/returned.json' with { type: 'json' };
import deliveredFixture from './fixtures/delivered.json' with { type: 'json' };
import { NinjaVanTracker, adapter } from './adapter.js';
import { normalizeNinjaVanNumber, parseNinjaVan, parseNinjaVanNotFound } from './parser.js';
import { InvalidInputError } from '../../core/errors/index.js';

const NUMBER = 'NLMYA00000000';
const clone = () => structuredClone(fixture);
const countries = ['sg', 'my', 'id', 'ph', 'th', 'vn'] as const;

describe('Ninja Van parser', () => {
  it('keeps the latest public scan and completed return, hiding later internal routing', () => {
    const result = normalizeCarrierResult(parseNinjaVan(clone(), NUMBER));
    expect(result.status).toBe('exception');
    expect(result.current_stage).toBe('returned');
    expect(result.last_status_text).toBe('Returned to sender');
    expect(result.last_update).toBe('2026-04-02T09:00:00Z');
    expect(result.delivered_at).toBeUndefined();
    expect(result.expected_delivery).toBeNull();
    expect(result.events).toHaveLength(5);
    expect(result.events?.[0]).toMatchObject({ provider_code: 'DELIVERY_SUCCESS', stage: 'returned', provider_leg: 'return' });
    expect(result.events?.at(-1)).toMatchObject({ provider_code: 'RTS', stage: 'exception', provider_leg: 'return' });
    expect(result.events?.every(event => !['ADDED_TO_SHIPMENT', 'PARCEL_ROUTING_SCAN'].includes(event.provider_code ?? ''))).toBe(true);
  });

  it('keeps movement on the return leg in transit until explicit sender delivery', () => {
    const payload = clone();
    payload.events = payload.events.slice(0, 6);
    payload.granular_status = 'En Route to Sorting Hub';
    payload.status = 'Transit';
    const result = parseNinjaVan(payload, NUMBER);
    expect(result.current_stage).toBe('in_transit');
    expect(result.status).toBe('in_transit');
    expect(result.events?.[0]?.provider_leg).toBe('return');
    expect(result.delivered_at).toBeUndefined();
  });

  it('accepts recipient delivery only without a return marker', () => {
    const payload = clone();
    payload.events = payload.events.slice(1, 7);
    const delivered = payload.events.at(-1)!;
    delivered.data = { is_rts: false };
    payload.granular_status = 'Completed';
    const result = parseNinjaVan(payload, NUMBER);
    expect(result.current_stage).toBe('delivered');
    expect(result.delivered_at).toBe('2026-04-02T09:00:00Z');
    expect(result.events?.[0]?.provider_leg).toBeUndefined();
  });

  it('reads the delivery window while the order moves, as the public page shows it', () => {
    const moving = (window: Record<string, unknown>) => {
      const payload: Record<string, unknown> = { ...clone(), status: 'Transit', granular_status: 'Arrived at Sorting Hub',
        delivery_timeslot: '09 AM to 10 PM', ...window };
      payload.events = clone().events.slice(1, 6);
      return normalizeCarrierResult(parseNinjaVan(payload, NUMBER));
    };
    expect(moving({})).toMatchObject({ expected_delivery: '2026-04-04', expected_delivery_from: '2026-04-02' });
    // A one-day window takes its timeslot's clocks; an unknown or reversed timeslot keeps the day.
    const oneDay = (window: Record<string, unknown>) => moving({ delivery_start_date: '2026-04-03', delivery_end_date: '2026-04-03', ...window });
    expect(oneDay({})).toMatchObject({ expected_delivery_from: '2026-04-03T09:00:00+08:00', expected_delivery: '2026-04-03T22:00:00+08:00' });
    expect(oneDay({ delivery_timeslot: '12 PM to 03 PM' }))
      .toMatchObject({ expected_delivery_from: '2026-04-03T12:00:00+08:00', expected_delivery: '2026-04-03T15:00:00+08:00' });
    for (const delivery_timeslot of ['Anytime', '06 PM to 09 AM', '13 PM to 03 PM', '9:30 AM to 12 PM']) {
      expect(oneDay({ delivery_timeslot }).expected_delivery).toBe('2026-04-03');
      expect(oneDay({ delivery_timeslot }).expected_delivery_from).toBeUndefined();
    }
    // A timeslot that ended before the newest scan keeps its day.
    const today = (delivery_timeslot: string) => moving({ delivery_start_date: '2026-04-02', delivery_end_date: '2026-04-02', delivery_timeslot });
    expect(today('09 AM to 12 PM').expected_delivery).toBe('2026-04-02');
    expect(today('09 AM to 12 PM').expected_delivery_from).toBeUndefined();
    expect(today('06 PM to 10 PM')).toMatchObject({ expected_delivery_from: '2026-04-02T18:00:00+08:00', expected_delivery: '2026-04-02T22:00:00+08:00' });
    // The server moves an overdue window's start up to the lookup day, so a start after the end is no estimate.
    for (const window of [{ delivery_timeslot: '' }, { status: 'Pending' }, { status: 'On Hold' },
      { delivery_start_date: '2026-04-05', delivery_end_date: '2026-04-03' },
      { delivery_start_date: '2026-03-30', delivery_end_date: '2026-04-01' }, { delivery_end_date: '2026-02-30' }, { delivery_start_date: null }]) {
      expect(moving(window).expected_delivery).toBeNull();
      expect(moving(window).expected_delivery_from).toBeUndefined();
    }
    const delivered = clone();
    delivered.events = delivered.events.slice(1, 7);
    delivered.events.at(-1)!.data = { is_rts: false };
    expect(parseNinjaVan({ ...delivered, status: 'Transit', delivery_timeslot: '09 AM to 10 PM' }, NUMBER).expected_delivery).toBeNull();
  });

  it('drops the delivery window once the parcel heads back to the sender', () => {
    const payload: Record<string, unknown> = { ...clone(), status: 'Transit', granular_status: 'En Route to Sorting Hub',
      delivery_timeslot: '09 AM to 10 PM', delivery_start_date: '2026-04-02', delivery_end_date: '2026-04-04' };
    payload.events = clone().events.slice(0, 6);
    const result = normalizeCarrierResult(parseNinjaVan(payload, NUMBER));
    expect(result.events?.[0]?.provider_leg).toBe('return');
    expect(result.expected_delivery).toBeNull();
    expect(result.expected_delivery_from).toBeUndefined();
  });

  it('dates the delivery window in the route country', () => {
    const late = (number: string) => {
      const payload: Record<string, unknown> = { ...clone(), tracking_id: number, status: 'Transit', delivery_timeslot: '09 AM to 10 PM',
        delivery_start_date: '2026-03-31', delivery_end_date: '2026-04-01' };
      const events = clone().events.slice(1, 3);
      events.at(-1)!.time = '2026-04-01T16:30:00Z';
      payload.events = events;
      return parseNinjaVan(payload, number).expected_delivery;
    };
    expect(late(NUMBER)).toBeNull();
    expect(late('NLVNA00000000')).toBe('2026-04-01');
  });

  const oneDayOn = (country: string) => {
    const number = `NL${country.toUpperCase()}A00000000`;
    const payload: Record<string, unknown> = { ...clone(), tracking_id: number, status: 'Transit', delivery_timeslot: '03 PM to 06 PM',
      delivery_start_date: '2026-04-03', delivery_end_date: '2026-04-03' };
    payload.events = clone().events.slice(1, 6);
    return parseNinjaVan(payload, number);
  };

  it.each([['sg', '+08:00'], ['my', '+08:00'], ['ph', '+08:00'], ['th', '+07:00'], ['vn', '+07:00']] as const)(
    'reads a one-day timeslot on the %s route\'s clock', (country, offset) => {
      expect(oneDayOn(country)).toMatchObject({
        expected_delivery_from: `2026-04-03T15:00:00${offset}`, expected_delivery: `2026-04-03T18:00:00${offset}` });
    });

  it('keeps the day of a one-day window in Indonesia, whose three zones the reply does not tell apart', () => {
    const result = oneDayOn('id');
    expect(result.expected_delivery).toBe('2026-04-03');
    expect(result.expected_delivery_from).toBeUndefined();
  });

  it('does not call ambiguous return delivery a recipient delivery', () => {
    const payload = clone();
    delete (payload.events.at(-2)!.data as { is_rts?: boolean }).is_rts;
    const result = parseNinjaVan(payload, NUMBER);
    expect(result.current_stage).toBe('exception');
    expect(result.delivered_at).toBeUndefined();
  });

  it('keeps an unresolved newest clock without borrowing the older scan time', () => {
    const payload = clone();
    payload.events.at(-2)!.time = '2026-02-30T09:00:00Z';
    const result = parseNinjaVan(payload, NUMBER);
    expect(result.status).toBe('exception');
    expect(result.last_update).toBeNull();
    expect(result.events?.[0]).toMatchObject({ provider_time_text: '2026-02-30T09:00:00Z' });
    expect(result.events?.[0]?.time).toBeUndefined();
  });

  it('requires the returned parcel and all visible scans to belong to the request', () => {
    const wrong = clone();
    wrong.tracking_id = 'NLMYA99999999';
    expect(() => parseNinjaVan(wrong, NUMBER)).toThrowError();
    const crossOrder = clone();
    crossOrder.events[2]!.order_id = 99999;
    expect(() => parseNinjaVan(crossOrder, NUMBER)).toThrowError();
    const noScans = clone();
    noScans.events = [];
    expect(() => parseNinjaVan(noScans, NUMBER)).toThrowError();
  });

  it('distinguishes exact absent ID from a generic 404', () => {
    const exact = { error: { code: 150002, title: 'Not Found', message: `order by tracking id ${NUMBER} not found.` } };
    expect(() => parseNinjaVanNotFound(exact, NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseNinjaVanNotFound({ error: { code: 150002, title: 'Not Found', message: 'Unable to fetch order details' } }, NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseNinjaVanNotFound({ error: { ...exact.error, message: 'order by tracking id NLMYA99999999 not found.' } }, NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('requires a supported whole country-bearing parcel format', () => {
    expect(normalizeNinjaVanNumber('nlmya 00000000')).toBe(NUMBER);
    expect(normalizeNinjaVanNumber('nl.my.a 0000-0000')).toBe(NUMBER);
    for (const country of countries) {
      for (const number of [`NL${country.toUpperCase()}A00000000`, `NV${country.toUpperCase()}TEST00000000`]) {
        expect(normalizeNinjaVanNumber(number)).toBe(number);
        expect(ninjaVanCountry(number)).toBe(country);
      }
    }
    expect(ninjaVanCountry('NJVTT00000000000')).toBe('id');
    for (const number of ['DX149431', '1234567890123456', 'NLMYA0000', 'NVSGSTAMP000000000', 'NLUSA00000000', 'NLIDA00000000&country=my']) {
      expect(() => normalizeNinjaVanNumber(number)).toThrow(InvalidInputError);
    }
  });

  it('validates hidden scans and retains explicit clocks and carrier stage provenance', () => {
    const payload = structuredClone(deliveredFixture);
    const result = parseNinjaVan(payload, payload.tracking_id);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_update: '2026-04-02T10:00:00+08:00', delivered_at: '2026-04-02T10:00:00+08:00' });
    expect(result.events?.[0]).toMatchObject({ stage: 'delivered', stage_source: 'carrier_map' });
    const crossOrder = clone();
    crossOrder.events[3]!.order_id = 99999;
    expect(() => parseNinjaVan(crossOrder, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(JSON.stringify(result)).not.toContain('instructions');
  });

  it('marks a bounded projection as incomplete and retains the newest scan', () => {
    const payload = structuredClone(deliveredFixture);
    const transit = payload.events[0]!;
    payload.events = [...Array.from({ length: 101 }, () => structuredClone(transit)), payload.events.at(-1)!];
    const result = parseNinjaVan(payload, payload.tracking_id);
    expect(result.history_truncated).toBe(true);
    expect(result.events).toHaveLength(100);
    expect(result.events?.[0]?.provider_code).toBe('DELIVERY_SUCCESS');
  });

  it.each(['2026-04-02T10:00:00+14:01', '2026-04-02T10:00:00', '2026-13-02T10:00:00Z'])('retains an unresolved newest clock %s', time => {
    const payload = structuredClone(deliveredFixture);
    payload.events.at(-1)!.time = time;
    const result = parseNinjaVan(payload, payload.tracking_id);
    expect(result.last_update).toBeNull();
    expect(result.delivered_at).toBeUndefined();
    expect(result.events?.[0]).toMatchObject({ provider_time_text: time });
  });
});

describe('Ninja Van adapter', () => {
  it('uses the official single-order request and returns a normalized parcel', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async (url, init) => {
      calls += 1;
      const request = new URL(String(url));
      expect(request.origin).toBe('https://walrus.ninjavan.co');
      expect(request.pathname).toBe('/my/dash/1.2/public/orders');
      expect(request.searchParams.get('tracking_id')).toBe(NUMBER);
      expect(init?.signal).toBeDefined();
      return Response.json(clone());
    };
    const result = normalizeCarrierResult(await new NinjaVanTracker({ fetcher }).fetch(NUMBER));
    expect(result.current_stage).toBe('returned');
    expect(calls).toBe(1);
  });

  it('recognizes exact absence and leaves a generic negative inconclusive', async () => {
    const exact = { error: { code: 150002, title: 'Not Found', message: `order by tracking id ${NUMBER} not found.` } };
    const unknown = adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {},
      fetcher: async () => Response.json(exact, { status: 404 }) });
    await expect(unknown.recognize?.(NUMBER)).resolves.toEqual({ known: false });
    const generic = adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {},
      fetcher: async () => Response.json({ error: { code: 150002, title: 'Not Found', message: 'Unable to fetch order details' } }, { status: 404 }) });
    await expect(generic.recognize?.(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(generic.recognize?.('DX149431')).resolves.toEqual({ known: false });
  });

  it.each(countries)('routes %s parcel IDs and HTTP recognition to the same official country client', async country => {
    const number = `NV${country.toUpperCase()}TEST00000000`;
    const payload = { ...structuredClone(deliveredFixture), tracking_id: number };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(payload));
    const instance = adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {}, userAgent: 'ParcelTest/1.0', fetcher });
    expect((await instance.track({ number, countryHint: 'US' })).current_stage).toBe('delivered');
    await expect(instance.recognize!(number)).resolves.toMatchObject({ known: true, lastActivityAt: '2026-04-02T02:00:00.000Z' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetcher.mock.calls) {
      const request = new URL(String(url));
      expect(request.pathname).toBe(`/${country}/dash/1.2/public/orders`);
      expect([...request.searchParams]).toEqual([['tracking_id', number]]);
      const headers = new Headers(init?.headers);
      expect(headers.get('User-Agent')).toBe('ParcelTest/1.0');
      expect(headers.has('Authorization') || headers.has('Cookie')).toBe(false);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('routes Indonesian domestic IDs without interpreting a purchase ID as a shipment', async () => {
    const number = 'NJVTT00000000000';
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ ...structuredClone(deliveredFixture), tracking_id: number }));
    const tracker = new NinjaVanTracker({ fetcher });
    await tracker.fetch(number);
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).pathname).toBe('/id/dash/1.2/public/orders');
    expect(() => tracker.fetch('1234567890123456')).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects mismatched identity and empty histories during recognition', async () => {
    const number = 'NVSGTEST00000000';
    for (const payload of [{ ...structuredClone(deliveredFixture), tracking_id: NUMBER }, { ...structuredClone(deliveredFixture), events: [] }]) {
      const instance = adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {}, fetcher: async () => Response.json(payload) });
      await expect(instance.recognize!(number)).rejects.toMatchObject({ kind: payload.events.length ? 'schema' : 'indeterminate' });
    }
  });

  it('preserves challenge, rate limit and malformed JSON failures', async () => {
    const tracker = (response: Response) => new NinjaVanTracker({ fetcher: async () => response });
    await expect(tracker(new Response('<html><title>Just a moment</title><script src="/cdn-cgi/challenge-platform/a"></script></html>')).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(tracker(new Response('Limited', { status: 429, headers: { 'Retry-After': '30' } })).fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(tracker(new Response('<html>Broken</html>')).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('does no I/O after cancellation or exhausted budget and aborts a slow regional request', async () => {
    const unused = vi.fn<typeof fetch>();
    await expect(new NinjaVanTracker({ fetcher: unused }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    await expect(new NinjaVanTracker({ fetcher: unused }).fetch(NUMBER, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(unused).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      await new Promise<void>(resolve => init?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      init?.signal?.throwIfAborted();
      return Response.json({});
    });
    await expect(new NinjaVanTracker({ fetcher: slow }).fetch('NLPHA00000000', { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(slow.mock.calls.length).toBeLessThanOrEqual(1);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });
});

describe('Ninja Van catalog and recognition eligibility', () => {
  it.each(countries)('keeps %s regional detection, HTTP eligibility and public links aligned', country => {
    const number = `NL${country.toUpperCase()}A00000000`;
    expect(detectCarrierMatch(number).candidates).toContain('ninja-van');
    const candidate = `NV${country.toUpperCase()}TEST00000000`;
    expect(detectCarrierMatch(candidate)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(recognitionCandidates(candidate).some(candidate => candidate.carrier === 'ninja-van')).toBe(true);
    const host = country === 'id' ? 'www.ninjaxpress.co' : 'www.ninjavan.co';
    expect(ninjaVanTrackingUrl(number)).toBe(`https://${host}/en-${country}/tracking?id=${number}`);
    expect(carrierInfo('ninja-van').trackingUrl?.(number)).toBe(ninjaVanTrackingUrl(number));
    expect(ninjaVanTrackingUrl(`${number.slice(0, 4).toLowerCase()}. ${number.slice(4)}`)).toBe(ninjaVanTrackingUrl(number));
  });

  it('keeps custom shipper and stamp IDs outside direct recognition', () => {
    expect(ninjaVanCountry('DX149431')).toBeUndefined();
    expect(ninjaVanCountry('NVSGSTAMP000000000')).toBeUndefined();
    expect(detectCarrierMatch('NVSGSTAMP000000000').candidates).not.toContain('ninja-van');
  });

  it('reads Indonesian Ninja Xpress links as this regional carrier', () => {
    expect(parseTrackingInput('https://www.ninjaxpress.co/en-id/tracking?id=NJVTT00000000000')).toMatchObject({
      carrier: 'ninja-van', trackingNumber: 'NJVTT00000000000',
    });
  });
});
