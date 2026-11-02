import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimitedError, retryAfterMsOf } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, fetchPostNL, parsePostNLDomesticResponse, parsePostNLTrackingResponse, PostNLTracker } from './adapter.js';
import { postNLStatus, statusMap } from './status.js';

const folder = path.dirname(fileURLToPath(import.meta.url));
const carrier = JSON.parse(
  readFileSync(path.join(folder, 'carrier.json'), 'utf8'),
) as { capabilities: string[] };

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(folder, 'fixtures', name), 'utf8'));
}

const POSTNL_WRONG_NUMBER = 'LT000000000NL';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PostNL transient failures', () => {
  beforeEach(() => vi.useFakeTimers());

  it.each(['authentication', 'tracking'])('recovers from a rate-limited %s request', async (step) => {
    const responses = [
      jsonResponse({ access_token: 'visitor-token' }),
      jsonResponse({ data: { items: [{ item: POSTNL_WRONG_NUMBER, events: [{ category: 'Processing', datetime_local: '2026-08-30T12:00:00Z', country_code: 'NL' }] }] } }),
    ];
    responses.splice(step === 'authentication' ? 0 : 1, 0, new Response('', {
      status: 429, headers: { 'Retry-After': '6' },
    }));
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!);
    const result = fetchPostNL(POSTNL_WRONG_NUMBER);
    await vi.advanceTimersByTimeAsync(5_999);
    expect(fetcher).toHaveBeenCalledTimes(step === 'authentication' ? 1 : 2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ status: 'in_transit', events: [{ stage: 'accepted' }] });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const trackingRequests = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/tracking-items'));
    for (const [, init] of trackingRequests) {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer visitor-token' });
      expect(JSON.parse(String(init?.body))).toEqual({ items: [POSTNL_WRONG_NUMBER], language_code: 'en' });
    }
  });
});

describe('PostNL wrong-number handling', () => {
  it('maps the explicit barcode-not-found item to a privacy-safe 404', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ access_token: 'visitor-token' }))
      .mockResolvedValueOnce(jsonResponse({
        status: 'success',
        data: {
          items: [{
            item: POSTNL_WRONG_NUMBER,
            message: 'The shipment barcode was not found. Private upstream details',
            events: [],
          }],
        },
      }));

    try {
      await fetchPostNL(POSTNL_WRONG_NUMBER);
      throw new Error('Expected the lookup to fail');
    } catch (error) {
      expect(error).toMatchObject({ name: 'NotFoundError', status: 404, kind: 'not_found' });
      expect(String(error)).toContain('PostNL could not locate the shipment');
      expect(String(error)).not.toContain('Private upstream details');
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [, init] = fetcher.mock.calls[1]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      items: [POSTNL_WRONG_NUMBER],
      language_code: 'en',
    });
  });

  it('rejects an answer describing a different shipment', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ access_token: 'visitor-token' }))
      .mockResolvedValueOnce(jsonResponse({
        data: { items: [{ item: 'LT111111111NL', events: [] }] },
      }));

    await expect(fetchPostNL(POSTNL_WRONG_NUMBER)).rejects.toThrow('different or ambiguous shipment');
  });

  it('refuses a visitor token that is missing or implausibly long', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ access_token: '' }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'x'.repeat(16_385) }));

    await expect(fetchPostNL(POSTNL_WRONG_NUMBER)).rejects.toThrow('invalid visitor token');
    await expect(fetchPostNL(POSTNL_WRONG_NUMBER)).rejects.toThrow('invalid visitor token');
  });

  it('uses the environment fetcher the factory hands the tracker', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'visitor-token' }))
      .mockResolvedValueOnce(jsonResponse({
        data: { items: [{ item: POSTNL_WRONG_NUMBER, events: [{ category: 'Processing', datetime_local: '2026-08-30T12:00:00Z', country_code: 'NL' }] }] },
      }));
    const global = vi.spyOn(globalThis, 'fetch');

    await expect(new PostNLTracker({ fetcher }).fetch(POSTNL_WRONG_NUMBER))
      .resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(global).not.toHaveBeenCalled();
  });
});

describe('PostNL recognition', () => {
  const SERIES = '181011000000000017';

  it('asks the international tracker about the recognized series only', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'visitor-token' }))
      .mockResolvedValueOnce(jsonResponse({
        data: { items: [{ item: SERIES, events: [{ category: 'Processing', datetime_local: '2026-08-30T12:00:00Z', country_code: 'NL' }] }] },
      }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'visitor-token' }))
      .mockResolvedValueOnce(jsonResponse({
        data: { items: [{ item: SERIES, message: 'The shipment barcode was not found.', events: [] }] },
      }));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });

    for (const number of [POSTNL_WRONG_NUMBER, '3SABCD000000017', '182011000000000017']) {
      await expect(instance.recognize!(number), number).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    await expect(instance.recognize!(SERIES)).resolves.toEqual({ known: true, lastActivityAt: '2026-08-30T10:00:00.000Z' });
    await expect(instance.recognize!(SERIES)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});

describe('PostNL visitor token', () => {
  const tracked = () => jsonResponse({
    data: { items: [{ item: POSTNL_WRONG_NUMBER, events: [{ category: 'Processing', datetime_local: '2026-08-30T12:00:00Z', country_code: 'NL' }] }] },
  });
  const tokenCalls = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>) => fetcher.mock.calls.filter(([url]) => String(url).endsWith('/auth/token')).length;
  const bearers = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>) => fetcher.mock.calls
    .filter(([url]) => String(url).endsWith('/tracking-items'))
    .map(([, init]) => (init?.headers as Record<string, string>).Authorization);

  it('is minted once for a tracker\'s lookups and again shortly before it expires', async () => {
    let now = Date.parse('2026-10-20T08:00:00Z');
    let minted = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).endsWith('/auth/token')
      ? jsonResponse({ access_token: `visitor-token-${++minted}`, expires_in: 86_400, token_type: 'Bearer' }) : tracked());
    const tracker = new PostNLTracker({ fetcher, now: () => new Date(now) });

    await tracker.fetch(POSTNL_WRONG_NUMBER);
    now += 23 * 3_600_000;
    await tracker.fetch(POSTNL_WRONG_NUMBER);
    expect(tokenCalls(fetcher)).toBe(1);
    now += 3_600_000 - 4 * 60_000;
    await tracker.fetch(POSTNL_WRONG_NUMBER);
    expect(tokenCalls(fetcher)).toBe(2);
    expect(bearers(fetcher)).toEqual(['Bearer visitor-token-1', 'Bearer visitor-token-1', 'Bearer visitor-token-2']);
  });

  it('serves one lookup when the reply gives no lifetime', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).endsWith('/auth/token')
      ? jsonResponse({ access_token: 'visitor-token' }) : tracked());
    const tracker = new PostNLTracker({ fetcher });

    await tracker.fetch(POSTNL_WRONG_NUMBER);
    await tracker.fetch(POSTNL_WRONG_NUMBER);
    expect(tokenCalls(fetcher)).toBe(2);
  });

  it('is replaced once when PostNL refuses the shared one, and dropped when it refuses a new one', async () => {
    let minted = 0;
    const refused = new Set<string>();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url).endsWith('/auth/token')) return jsonResponse({ access_token: `visitor-token-${++minted}`, expires_in: 86_400 });
      return refused.has((init?.headers as Record<string, string>).Authorization ?? '') ? new Response('', { status: 401 }) : tracked();
    });
    const tracker = new PostNLTracker({ fetcher });

    await expect(tracker.fetch(POSTNL_WRONG_NUMBER)).resolves.toMatchObject({ status: 'in_transit' });
    refused.add('Bearer visitor-token-1');
    await expect(tracker.fetch(POSTNL_WRONG_NUMBER)).resolves.toMatchObject({ status: 'in_transit' });
    expect(bearers(fetcher)).toEqual(['Bearer visitor-token-1', 'Bearer visitor-token-1', 'Bearer visitor-token-2']);
    refused.add('Bearer visitor-token-2').add('Bearer visitor-token-3');
    // The shared token is replaced once; the new one is refused too and the lookup fails.
    await expect(tracker.fetch(POSTNL_WRONG_NUMBER)).rejects.toMatchObject({ status: 401 });
    await expect(tracker.fetch(POSTNL_WRONG_NUMBER)).resolves.toMatchObject({ status: 'in_transit' });
    expect(bearers(fetcher).slice(3)).toEqual(['Bearer visitor-token-2', 'Bearer visitor-token-3', 'Bearer visitor-token-4']);
    expect(tokenCalls(fetcher)).toBe(4);
  });
});

describe('official PostNL status categories', () => {
  it.each([
    ['Pre-advised', 'pending', 'registered'],
    ['Preparing', 'pending', 'registered'],
    ['Processing', 'in_transit', 'accepted'],
    ['Departed', 'in_transit', 'in_transit'],
    ['Arrived', 'in_transit', 'in_transit'],
    ['In transit', 'in_transit', 'in_transit'],
    ['Transit', 'in_transit', 'in_transit'],
    ['Customs', 'in_transit', 'customs'],
    ['Out for delivery', 'out_for_delivery', 'out_for_delivery'],
    ['Pick-up point', 'out_for_delivery', 'ready_for_pickup'],
    ['Delivered', 'delivered', 'delivered'],
    // PostNL's own spelling, kept next to the corrected one.
    ['Unsuccesfull', 'exception', 'failed_attempt'],
    ['Unsuccessful', 'exception', 'failed_attempt'],
    ['Undelivered', 'exception', 'failed_attempt'],
    ['Returned', 'exception', 'returned'],
    ['Exception', 'exception', 'exception'],
  ] as const)('maps %s to %s / %s', async (category, status, stage) => {
    expect(postNLStatus(category)).toEqual({ status, stage });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ access_token: 'visitor-token' }))
      .mockResolvedValueOnce(jsonResponse({
        data: {
          items: [{
            item: POSTNL_WRONG_NUMBER,
            events: [{
              category,
              datetime_local: '2026-08-30T12:00:00Z',
              status_description: `${category} event`,
            }],
          }],
        },
      }));

    await expect(fetchPostNL(POSTNL_WRONG_NUMBER)).resolves.toMatchObject({
      status,
      current_stage: stage,
      events: [{ stage }],
    });
  });

  it('leaves an unfamiliar category and the shipment status unknown', () => {
    expect(postNLStatus('Handed to partner')).toBeUndefined();
    const result = parsePostNLTrackingResponse({
      data: {
        items: [{
          item: POSTNL_WRONG_NUMBER,
          events: [{ category: 'Handed to partner', datetime_local: '2026-08-30T12:00:00Z' }],
        }],
      },
    }, POSTNL_WRONG_NUMBER);
    expect(result.status).toBe('unknown');
    expect(result.current_stage).toBeUndefined();
    expect(result.events?.[0]?.stage).toBeUndefined();
  });
});

describe('PostNL declared capabilities and privacy', () => {
  const delivered = parsePostNLTrackingResponse(fixture('delivered.json'), 'LX123456785NL');
  const checks: Record<string, (result: CarrierResult) => boolean> = {
    history: (result) => (result.events?.length ?? 0) > 0,
    location: (result) => (result.events ?? []).some((event) => Boolean(event.location)),
    eta: (result) => Boolean(result.expected_delivery),
    eta_window: (result) => Boolean(result.expected_delivery_from),
    pickup_point: (result) => Boolean(result.pickup_point),
    weight: (result) => result.weight_kg != null,
    dimensions: (result) => Boolean(result.dimensions_text),
    delivered_at: (result) => Boolean(result.delivered_at),
    provider_code: (result) => (result.events ?? []).some((event) => Boolean(event.provider_code)),
  };

  it.each([
    ['CH', 'CH'], [' fi ', 'FI'], ['Switzerland', undefined], [123, undefined], [null, undefined],
  ])('projects only a structured destination code: %s', (destination_code, expected) => {
    const result = parsePostNLTrackingResponse({ data: { items: [{
      item: 'LX123456785NL', destination_code,
      events: [{ category: 'Processing', country_code: 'NL' }],
    }] } }, 'LX123456785NL');
    expect(result.destination_country).toBe(expected);
    expect(result.delivery_carrier).toBeUndefined();
    expect(result.status).toBe('in_transit');
  });

  it('never treats a transit scan country as the shipment destination', () => {
    const result = parsePostNLTrackingResponse({ data: { items: [{ item: 'LX123456785NL',
      events: [{ category: 'Arrived', country_code: 'CH', country_name: 'Switzerland' }],
    }] } }, 'LX123456785NL');
    expect(result.destination_country).toBeUndefined();
  });

  it('keeps the journey and the country of each scan', () => {
    expect(delivered).toMatchObject({
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: 'Shipment delivered',
      last_update: '2026-09-03T10:12:00+02:00',
      // PostNL's international tracker publishes no estimate.
      expected_delivery: null,
      delivered_at: '2026-09-03T10:12:00+02:00',
    });
    // Each scan keeps its category with its status number, which the parcel app's review reads.
    expect(delivered.events?.map((event) => [event.stage, event.location, event.provider_code])).toEqual([
      ['delivered', 'Netherlands', '37/delivered'],
      ['out_for_delivery', 'Netherlands', '74/out for delivery'],
      ['customs', 'Netherlands', '6060/customs'],
      ['registered', 'CN', '1233/pre-advised'],
    ]);
  });

  it('reads each scan in its own country\'s zone, not as the UTC PostNL labels it', () => {
    expect(delivered.events?.map((event) => event.time)).toEqual([
      '2026-09-03T10:12:00+02:00', '2026-09-03T06:40:00+02:00', '2026-09-01T19:05:00+02:00', '2026-08-28T11:00:00+08:00',
    ]);
    const multiZone = parsePostNLTrackingResponse({ data: { items: [{ item: 'LX123456785NL',
      events: [{ category: 'Processing', datetime_local: '2026-09-02T08:00:00Z', country_code: 'US' }],
    }] } }, 'LX123456785NL');
    // A country with several zones cannot be resolved; the provider's text is kept.
    expect(multiZone.events?.[0]).toMatchObject({ local_time: '2026-09-02T08:00:00' });
    expect(multiZone.events?.[0]).not.toHaveProperty('time');
    expect(multiZone.last_update).toBeNull();
  });

  it.each(carrier.capabilities)('declares %s and a fixture proves it', (capability) => {
    const check = checks[capability];
    expect(check, `unknown capability ${capability}`).toBeTypeOf('function');
    expect(check!(delivered)).toBe(true);
  });

  it('drops the recipient and the signature', () => {
    const projected = JSON.stringify(delivered);
    for (const value of ['Made Up Recipient', 'Example Street 1', 'proof-of-delivery']) {
      expect(projected).not.toContain(value);
    }
  });
});

describe('PostNL ambiguity and clock safety', () => {
  const number = 'LX123456785NL';
  const payload = (events: Record<string, unknown>[]) => ({ data: { items: [{ item: number, events }] } });

  it.each([
    ['Processing', 'The item is out for delivery', 'out_for_delivery'],
    ['Processing', 'The item is at the local sorting centre', 'in_transit'],
    ['Processing', 'The item has arrived at the domestic sorting centre', 'in_transit'],
    ['Processing', 'The item is on transport to the local sorting centre', 'in_transit'],
    ['Processing', 'The item is at the local delivery office', 'in_transit'],
    ['Transit', 'Consignment received at the PostNL Acceptance Centre', 'accepted'],
    // An item scan that can follow the acceptance centre by days.
    ['Transit', 'The item is received by PostNL', 'in_transit'],
    ['Transit', 'The shipment is handed over in bulk final acceptance of the item to be confirmed', 'accepted'],
    ['Transit', 'The item is on transport to the country of destination', 'in_transit'],
    ['Arrived', 'Consignment received at the PostNL Acceptance Centre', 'in_transit'],
    ['Processing', 'Driver is en route to the pickup location', 'in_transit'],
    ['Undelivered', 'Undeliverable item, has been returned to shipper', 'returned'],
    ['Undelivered', 'The item has been returned and arrived at PostNL', 'returned'],
    ['Undelivered', 'The item cannot be delivered and will be returned', 'failed_attempt'],
    ['Customs', 'The item is released by customs', 'in_transit'],
    ['Customs', 'The item is not released by customs', 'customs'],
    ['Customs', 'The item will be released by customs', 'customs'],
    ['Processing', 'The item will be out for delivery', 'accepted'],
    ['Processing', 'Not out for delivery', 'accepted'],
    ['Future category', 'The item is out for delivery', undefined],
  ])('refines only the observed category and exact label: %s / %s', (category, description, stage) => {
    const result = parsePostNLTrackingResponse(payload([{ category, status_description: description }]), number);
    expect(result.events?.[0]?.stage).toBe(stage);
    expect(result.current_stage).toBe(stage);
  });

  it.each([
    [37, '37/processing'], ['3054', '3054/processing'], [' 74 ', '74/processing'], [-1, undefined], [1.5, undefined], ['B24', undefined], [null, undefined],
  ])('keeps only a numeric scan code as the provider code: %j', (status, expected) => {
    const result = parsePostNLTrackingResponse(payload([{ category: 'Processing', status }]), number);
    expect(result.events?.[0]?.provider_code).toBe(expected);
  });

  it('keeps a scan without a category under its status number alone', () => {
    const result = parsePostNLTrackingResponse(payload([{ category: ' ', status: 37, status_description: 'Synthetic scan' }]), number);
    expect(result.events?.[0]).toMatchObject({ provider_code: '37', description: 'Synthetic scan' });
  });

  it('reads incorrect as not found only for a 3S layout the endpoint reads, and asks the postcode a 3S barcode it lacks', () => {
    const response = (item: string, message: string) => ({ status: 'success', data: { items: [{ item, message, events: [] as unknown[] }] } });
    const fifteen = '3SABCD123456789';
    expect(() => parsePostNLTrackingResponse(response(fifteen, 'The shipment barcode was incorrect.'), fifteen)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePostNLTrackingResponse(response(fifteen, 'Synthetic note'), fifteen)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // Parcel EU barcodes are thirteen characters, and the endpoint calls all of them incorrect.
    for (const unreadable of ['3SABCD1234567', '3SABC123456789']) {
      expect(() => parsePostNLTrackingResponse(response(unreadable, 'The shipment barcode was incorrect.'), unreadable)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    // A 3S barcode sent within the Netherlands is on the domestic tracker only.
    for (const domestic of [fifteen, '3SABCD1234567']) {
      expect(() => parsePostNLTrackingResponse(response(domestic, 'The shipment barcode was not found.'), domestic))
        .toThrow(expect.objectContaining({ kind: 'input_required', field: 'postcode' }));
    }
    expect(() => parsePostNLTrackingResponse(response('3SABC123456789', 'The shipment barcode was not found.'), '3SABC123456789'))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('refuses duplicate matching identities and an echo with empty history', () => {
    const value = payload([{ category: 'Processing' }]);
    value.data.items.push(value.data.items[0]!);
    expect(() => parsePostNLTrackingResponse(value, number)).toThrow('ambiguous shipment');
    expect(() => parsePostNLTrackingResponse(payload([]), number)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    const unrelated = payload([{ category: 'Processing' }]);
    unrelated.data.items.unshift({ item: 'LX000000005NL', events: [{ category: 'Delivered' }] });
    expect(parsePostNLTrackingResponse(unrelated, number).status).toBe('in_transit');
  });

  it.each([
    ['US', '2026-09-02T08:00:00Z', '2026-09-02T08:00:00'],
    ['ES', '2026-09-02T08:00:00Z', '2026-09-02T08:00:00'],
    ['PT', '2026-09-02T08:00:00Z', '2026-09-02T08:00:00'],
    ['NL', '2026-03-29T02:30:00Z', '2026-03-29T02:30:00'],
    ['NL', '2026-10-25T02:30:00Z', '2026-10-25T02:30:00'],
  ])('retains unresolved local digits for %s / %s without a delivery instant', (country_code, datetime_local, local_time) => {
    const result = parsePostNLTrackingResponse(payload([
      { category: 'Delivered', country_code, datetime_local },
      { category: 'Delivered', country_code: 'NL', datetime_local: '2026-09-01T10:00:00Z' },
    ]), number);
    expect(result.events?.[0]).toMatchObject({ local_time, stage: 'delivered' });
    expect(result.events?.[0]).not.toHaveProperty('time');
    expect(result.events?.[1]?.time).toBe('2026-09-01T10:00:00+02:00');
    expect(result.last_update).toBeNull();
    expect(result.last_update_local).toBe(local_time);
    expect(result.delivered_at).toBeUndefined();
  });

  it('reads PostNL\'s own records on Amsterdam time and precise customs stamps as UTC', () => {
    // Newest first, as PostNL lists them: only these readings keep that order.
    const result = parsePostNLTrackingResponse(payload([
      { category: 'Transit', country_code: 'NL', datetime_local: '2026-03-11T19:29:53.2942876Z', status_description: 'Item is nested to commercial bag' },
      { category: 'Transit', country_code: 'NL', datetime_local: '2026-03-11T19:49:00Z', status_description: 'Consignment received at the PostNL Acceptance Centre' },
      { category: 'Transit', country_code: 'NL', datetime_local: '2026-03-05T11:14:24.1629877Z', status_description: 'Pre-declaration of the item has been received by customs' },
      { category: 'Preparing', country_code: null, datetime_local: '2026-03-05T12:01:00Z', status_description: 'The item is ready for shipment' },
      { category: 'Pre-advised', country_code: null, datetime_local: '2026-03-05T10:01:00Z', status_description: 'The item is pre-advised to PostNL' },
    ]), number);
    expect(result.events?.map((event) => event.time)).toEqual([
      '2026-03-11T19:29:53.294Z', '2026-03-11T19:49:00+01:00', '2026-03-05T11:14:24.162Z',
      '2026-03-05T12:01:00+01:00', '2026-03-05T10:01:00+01:00',
    ]);
    // Summer time, with nothing dated around it.
    const summer = parsePostNLTrackingResponse(payload([
      { category: 'Pre-advised', country_code: '', country_name: null, datetime_local: '2026-09-14T15:20:00Z' },
    ]), number);
    expect(summer).toMatchObject({ last_update: '2026-09-14T15:20:00+02:00', current_stage: 'registered' });
  });

  it('reads the label\'s creation and the processing record without a country as UTC', () => {
    const result = parsePostNLTrackingResponse(payload([
      { category: 'Transit', country_code: 'NL', status: 101, datetime_local: '2026-03-12T16:12:00Z', status_description: 'The item is processed at the PostNL sorting center' },
      { category: 'Transit', country_code: null, status: 3033, datetime_local: '2026-03-12T09:58:00Z', status_description: 'The item is being processed' },
      { category: 'Transit', country_code: 'NL', status: 173, datetime_local: '2026-03-12T10:53:00Z', status_description: 'Consignment received at the PostNL Acceptance Centre' },
      { category: 'Pre-advised', country_code: null, status: 1233, datetime_local: '2026-03-06T02:31:00Z', status_description: 'The item is pre-advised to PostNL' },
      { category: 'Pre-advised', country_code: null, status: 2001, datetime_local: '2026-03-01T18:13:00Z', status_description: 'The shipping label has been created' },
    ]), number);
    // On Amsterdam time the processing record would come before the acceptance listed under it.
    expect(result.events?.map((event) => event.time)).toEqual([
      '2026-03-12T16:12:00+01:00', '2026-03-12T09:58:00Z', '2026-03-12T10:53:00+01:00',
      '2026-03-06T02:31:00+01:00', '2026-03-01T18:13:00Z',
    ]);
  });

  it.each([
    ['one of its dated neighbours', '2026-03-05T12:30:00Z', new Date('2026-03-12T00:00:00Z')],
    ['the lookup, beyond an hour of clock skew', '2026-03-05T12:01:00Z', new Date('2026-03-05T09:59:00Z')],
  ])('keeps a record local when its Amsterdam reading contradicts %s', (_label, datetime_local, readAt) => {
    const result = parsePostNLTrackingResponse(payload([
      { category: 'Transit', country_code: 'NL', datetime_local: '2026-03-05T11:14:24.1629877Z' },
      { category: 'Preparing', country_code: null, datetime_local },
    ]), number, readAt);
    expect(result.events?.[1]).toMatchObject({ local_time: datetime_local.slice(0, 19) });
    expect(result.events?.[1]).not.toHaveProperty('time');
  });

  it('keeps malformed current clock text separate from older dated scans', () => {
    const result = parsePostNLTrackingResponse(payload([
      { category: 'Delivered', country_code: 'NL', datetime_local: '2026-02-30T12:00:00Z' },
      { category: 'Processing', country_code: 'NL', datetime_local: '2026-02-28T12:00:00Z' },
    ]), number);
    expect(result.events?.[0]).toMatchObject({ provider_time_text: '2026-02-30T12:00:00Z' });
    expect(result.last_update).toBeNull();
    expect(result.delivered_at).toBeUndefined();
  });

  it.each(['+02:00', '-05:00', '+0130'])('preserves an unexpected nonzero offset %s without reinterpreting its clock', offset => {
    const datetime_local = `2026-09-02T08:00:00${offset}`;
    const result = parsePostNLTrackingResponse(payload([
      { category: 'Delivered', country_code: 'NL', datetime_local },
      { category: 'Processing', country_code: 'NL', datetime_local: '2026-09-01T10:00:00Z' },
    ]), number);
    expect(result.events?.[0]).toMatchObject({ provider_time_text: datetime_local, stage: 'delivered' });
    expect(result.events?.[0]).not.toHaveProperty('time');
    expect(result.events?.[0]).not.toHaveProperty('local_time');
    expect(result.events?.[1]?.time).toBe('2026-09-01T10:00:00+02:00');
    expect(result.last_update).toBeNull();
    expect(result.last_update_local).toBeUndefined();
    expect(result.delivered_at).toBeUndefined();
  });

  it('does not manufacture midnight from a calendar day', () => {
    const result = parsePostNLTrackingResponse(payload([{ category: 'Processing', country_code: 'NL', datetime_local: '2026-09-02' }]), number);
    expect(result.events?.[0]).toMatchObject({ provider_time_text: '2026-09-02' });
    expect(result.events?.[0]).not.toHaveProperty('time');
    expect(result.events?.[0]).not.toHaveProperty('local_time');
  });

  it('does not use an inconsistent country label to resolve a multi-zone country code', () => {
    const result = parsePostNLTrackingResponse(payload([{ category: 'Processing', country_code: 'US',
      country_name: 'Netherlands', datetime_local: '2026-09-02T08:00:00Z' }]), number);
    expect(result.events?.[0]).toMatchObject({ local_time: '2026-09-02T08:00:00' });
    expect(result.events?.[0]).not.toHaveProperty('time');
  });

  it('bounds the projected history and refuses excessive input', () => {
    const scans = Array.from({ length: 101 }, () => ({ category: 'Processing' }));
    expect(parsePostNLTrackingResponse(payload(scans), number).events).toHaveLength(100);
    expect(() => parsePostNLTrackingResponse(payload(Array(501).fill(scans[0])), number)).toThrow('excessive');
  });
});

describe('PostNL complete lookup budget', () => {
  it('stops on caller cancellation and on a deadline during authentication', async () => {
    const unused = vi.fn<typeof fetch>();
    await expect(new PostNLTracker({ fetcher: unused }).fetch(POSTNL_WRONG_NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(unused).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      await new Promise<void>(resolve => init?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      init?.signal?.throwIfAborted();
      return jsonResponse({ access_token: 'visitor-token' });
    });
    await expect(new PostNLTracker({ fetcher: slow }).fetch(POSTNL_WRONG_NUMBER, { budgetMs: 20.5 })).rejects.toMatchObject({ kind: 'transport' });
    expect(slow).toHaveBeenCalledOnce();
  });

  it('cancels a rate-limit delay before starting another request', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '6' } }));
    const pending = new PostNLTracker({ fetcher }).fetch(POSTNL_WRONG_NUMBER, { signal: abort.signal });
    const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1);
    abort.abort();
    await rejected;
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('fails at once when PostNL asks for a wait longer than the lookup has left', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).endsWith('/tracking-items')
      ? new Response('', { status: 429, headers: { 'Retry-After': '46' } }) : jsonResponse({ access_token: 'visitor-token' }));
    const started = performance.now();
    const error = await new PostNLTracker({ fetcher }).fetch(POSTNL_WRONG_NUMBER, { budgetMs: 25_000 }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'rate_limited', message: 'PostNL tracking refused the request with HTTP 429, asking to wait 46 s', retryAfterMs: 46_000 });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/tracking-items'))).toHaveLength(1);
  });

  it.each([
    ['120', 'tracking', 'PostNL tracking refused the request with HTTP 429, asking to wait 120 s', 120_000],
    [null, 'authentication', 'PostNL authentication refused the request with HTTP 429, without saying how long to wait', undefined],
  ])('says how long PostNL asked to wait when it refuses a request as too many (Retry-After %s)', async (header, step, message, wait) => {
    const refusal = () => new Response('', { status: 429, headers: header === null ? {} : { 'Retry-After': header } });
    const fetcher = vi.fn<typeof fetch>(async (url) => step === 'authentication' || String(url).endsWith('/tracking-items')
      ? refusal() : jsonResponse({ access_token: 'visitor-token' }));
    const error = await new PostNLTracker({ fetcher }).fetch(POSTNL_WRONG_NUMBER).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error).toMatchObject({ kind: 'rate_limited', status: 429, message, retryAfterMs: wait });
    expect(retryAfterMsOf(error)).toBe(wait);
  });

  it.each([404, 410])('treats HTTP %s as endpoint failure rather than parcel absence', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Unavailable', { status }));
    await expect(new PostNLTracker({ fetcher }).fetch(POSTNL_WRONG_NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('PostNL domestic tracker', () => {
  const barcode = '3SABCD123456789';
  const observations = [
    { observationDate: '2026-05-12T08:38:33+02:00', observationCode: 'J05', description: 'Driver is en route' },
    { observationDate: '2026-05-12T07:48:27+02:00', observationCode: 'J01', description: 'Shipment has been sorted' },
    { observationDate: '2026-05-11T22:42:53+02:00', observationCode: 'B01', description: 'Shipment received by PostNL' },
    { observationDate: '2026-05-11T17:09:57.117+02:00', observationCode: 'A01', description: 'Shipment expected, but not yet arrived or processed at PostNL' },
  ];
  const collo = (fields: Record<string, unknown> = {}) => ({
    barcode, isDelivered: false, deliveryDate: null, statusPhase: { index: 3, message: 'Driver is en route' }, observations,
    recipient: { names: { personName: 'Synthetic Person' }, address: { street: 'Synthetic Street', postalCode: '1234AB', town: 'SYNTHETIC TOWN' } },
    sender: { names: { companyName: 'Synthetic Shop' } }, ...fields,
  });
  const reply = (...entries: Record<string, unknown>[]) => ({ colli: Object.fromEntries(entries.map((entry) => [String(entry.barcode), entry])) });
  const domesticUrl = (url: unknown) => String(url).startsWith('https://jouw.postnl.nl/');
  const notFound = { data: { items: [{ item: barcode, message: 'The shipment barcode was not found.', events: [] }] } };

  it('reads the observations and their stages without the recipient or sender', () => {
    const result = parsePostNLDomesticResponse(reply(collo()), barcode);
    expect(result).toMatchObject({
      status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'Driver is en route', last_update: '2026-05-12T08:38:33+02:00',
    });
    expect(result.events?.map((event) => [event.provider_code, event.stage])).toEqual([
      ['J05', 'out_for_delivery'], ['J01', 'in_transit'], ['B01', 'accepted'], ['A01', 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Synthetic|1234AB/);
    // The sorting scan and the pre-advice before PostNL has the shipment, by the labels the domestic tracker gives them.
    expect(statusMap.stage('J06', 'shipment sorted in sorting centre')).toBe('in_transit');
    expect(statusMap.stage('J01', 'Shipment has been sorted')).toBe('in_transit');
    expect(statusMap.stage('M02', 'Not yet processed by PostNL')).toBe('registered');
    expect(statusMap.stage('X01', 'Shipment is ready for transport to the country of destination')).toBe('in_transit');
  });

  it('dates the delivery the observations leave out, and only when PostNL says it happened', () => {
    const delivered = parsePostNLDomesticResponse(reply(collo({
      isDelivered: true, deliveryDate: '2026-05-12T11:21:20+02:00', statusPhase: { index: 4, message: 'Shipment in letterbox' },
    })), barcode);
    expect(delivered).toMatchObject({ status: 'delivered', delivered_at: '2026-05-12T11:21:20+02:00', last_status_text: 'Shipment in letterbox' });
    expect(delivered.events?.[0]).toEqual({ time: '2026-05-12T11:21:20+02:00', description: 'Shipment in letterbox', stage: 'delivered', stage_source: 'carrier_map' });
    // Delivered without a date: no delivery time is guessed from the driver's last scan.
    const undated = parsePostNLDomesticResponse(reply(collo({ isDelivered: true, statusPhase: { index: 4, message: 'Shipment in letterbox' } })), barcode);
    expect(undated).toMatchObject({ status: 'delivered', last_update: '2026-05-12T08:38:33+02:00' });
    expect(undated.delivered_at).toBeUndefined();
    // The phase alone, as for a parcel waiting at a pick-up point, is not a delivery.
    expect(parsePostNLDomesticResponse(reply(collo({ statusPhase: { index: 4, message: 'Synthetic phase' } })), barcode).status).toBe('out_for_delivery');
  });

  it('keeps an announced parcel as a summary, and a parcel without scans as no history', () => {
    const announced = { index: 0, message: 'Shipment expected, but not yet arrived or processed at PostNL' };
    expect(parsePostNLDomesticResponse(reply(collo({ observations: [], statusPhase: announced })), barcode))
      .toMatchObject({ status: 'pending', current_stage: 'registered', summary_only: true, events: [] });
    expect(() => parsePostNLDomesticResponse(reply(collo({ observations: [], statusPhase: { index: 2, message: 'Synthetic phase' } })), barcode))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('reads an empty reply as unknown rather than absent, and refuses another barcode or a changed shape', () => {
    expect(() => parsePostNLDomesticResponse({ colli: {} }, barcode)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    expect(() => parsePostNLDomesticResponse(reply(collo({ barcode: '3SABCD123456780' })), barcode)).toThrow('different or ambiguous');
    expect(() => parsePostNLDomesticResponse({ colli: [] }, barcode)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePostNLDomesticResponse(reply(collo({ observations: {} })), barcode)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePostNLDomesticResponse(reply(collo({ observations: [null] })), barcode)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('asks the domestic tracker first with a Dutch postcode, sent without its space', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(reply(collo())));
    const tracker = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(tracker.track({ number: barcode, postcode: '1234 ab' }, {})).resolves.toMatchObject({ status: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]![0])).toBe(`https://jouw.postnl.nl/track-and-trace/api/trackAndTrace/${barcode}-NL-1234AB?language=en`);
  });

  it("asks the domestic tracker with another country's postcode given with that country, as PostNL's page does", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse(reply(collo())));
    const tracker = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    for (const [postcode, postcodeCountry, key] of [['28001', 'es', 'ES-28001'], ['00-950', 'PL', 'PL-00950'], ['1234 ab', 'NL', 'NL-1234AB']]) {
      await expect(tracker.track({ number: barcode, postcode, postcodeCountry }, {})).resolves.toMatchObject({ status: 'out_for_delivery' });
      expect(String(fetcher.mock.lastCall![0])).toBe(`https://jouw.postnl.nl/track-and-trace/api/trackAndTrace/${barcode}-${key}?language=en`);
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('asks the international tracker when the domestic one finds nothing, and keeps the postcode out of errors', async () => {
    const intl = jsonResponse({ data: { items: [{ item: barcode, events: [{ category: 'Processing', datetime_local: '2026-05-11T12:00:00Z', country_code: 'NL' }] }] } });
    const found = vi.fn<typeof fetch>().mockImplementation(async (url) => (domesticUrl(url) ? jsonResponse({ colli: {} })
      : String(url).endsWith('/token') ? jsonResponse({ access_token: 'visitor-token' }) : intl));
    await expect(new PostNLTracker({ fetcher: found }).fetch(barcode, {}, '1234AB')).resolves.toMatchObject({ status: 'in_transit' });
    expect(found).toHaveBeenCalledTimes(3);

    const absent = vi.fn<typeof fetch>().mockImplementation(async (url) => (domesticUrl(url) ? jsonResponse({ colli: {} })
      : String(url).endsWith('/token') ? jsonResponse({ access_token: 'visitor-token' }) : jsonResponse(notFound)));
    await expect(new PostNLTracker({ fetcher: absent }).fetch(barcode, {}, '1234AB'))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });

    const failing = vi.fn<typeof fetch>().mockImplementation(async (url) => (domesticUrl(url) ? new Response('', { status: 500 })
      : String(url).endsWith('/token') ? jsonResponse({ access_token: 'visitor-token' }) : jsonResponse(notFound)));
    const error = await new PostNLTracker({ fetcher: failing }).fetch(barcode, {}, '1234AB').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: 'UpstreamHttpError', status: 500 });
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('1234AB');
  });

  it('skips the domestic tracker without a Dutch postcode, and says which postcode it needs', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url).endsWith('/token')
      ? jsonResponse({ access_token: 'visitor-token' }) : jsonResponse(notFound)));
    const tracker = new PostNLTracker({ fetcher });
    await expect(tracker.fetch(barcode)).rejects.toMatchObject({ kind: 'input_required', field: 'postcode' });
    await expect(tracker.fetch(barcode, {}, '10115')).rejects.toMatchObject({ kind: 'input_required', reason: 'postcode_mismatch' });
    await expect(tracker.fetch(barcode, {}, '10115', 'NL')).rejects.toMatchObject({ kind: 'input_required', reason: 'postcode_mismatch' });
    await expect(tracker.fetch(barcode, {}, '10/115', 'DE')).rejects.toMatchObject({ kind: 'input_required', reason: 'postcode_mismatch' });
    expect(fetcher.mock.calls.some(([url]) => domesticUrl(url))).toBe(false);
  });
});
