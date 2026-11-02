import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import {
  HeppnerTracker,
  heppnerDetailUrl,
  heppnerSearchUrl,
  heppnerTrackingPageUrl,
  normalizeHeppnerCredential,
  normalizeHeppnerTrackingNumber,
  parseHeppnerCapability,
  parseHeppnerTrackingResponse,
} from './adapter.js';
import { classifyHeppnerEvent, heppnerCode } from './status.js';

// Fully synthetic provider-shaped values. Live tests deliberately use only a
// wrong-number canary because Heppner does not publish a reusable demo shipment.
const TEST_TRACKING_NUMBER = '23456789';
const TEST_POSTCODE = '75001';
const TEST_CAPABILITY = 'MjM0NTY3ODkmNzUwMDEmRlI=';

function json(relativePath: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8'));
}

const carrier = json('./carrier.json') as { capabilities: readonly string[] };

function trackingPayload(receipt: string | number = TEST_TRACKING_NUMBER): unknown {
  const payload = json('./fixtures/returned-shipment.json') as Array<Record<string, unknown>>;
  payload[0]!.receipt = receipt;
  return payload;
}

afterEach(() => vi.restoreAllMocks());

describe('Heppner anonymous tracking input', () => {
  it('normalizes the current eight-digit form and infers the countries from postcode length', () => {
    expect(normalizeHeppnerTrackingNumber('23 456 789')).toBe(TEST_TRACKING_NUMBER);
    expect(normalizeHeppnerCredential(TEST_TRACKING_NUMBER, TEST_POSTCODE)).toEqual({
      trackingNumber: TEST_TRACKING_NUMBER,
      postcode: TEST_POSTCODE,
      countries: ['FR'],
    });
    expect(normalizeHeppnerCredential(TEST_TRACKING_NUMBER, '1201')).toEqual({
      trackingNumber: TEST_TRACKING_NUMBER,
      postcode: '1201',
      countries: ['CH', 'BE', 'LU'],
    });
    expect(() => heppnerSearchUrl(TEST_TRACKING_NUMBER, TEST_POSTCODE, 'BE')).toThrow('does not match the country');
  });

  it('rejects unsupported identifiers, postcodes, and parameter injection', () => {
    for (const value of ['2345678', '234567890', '2345-6789', '2345678A', '23456789&admin=true']) {
      expect(() => normalizeHeppnerTrackingNumber(value)).toThrow('exactly 8 digits');
    }
    for (const postcode of ['750', '750010', '75A01', '75001&countryCode=CH']) {
      expect(() => normalizeHeppnerCredential(TEST_TRACKING_NUMBER, postcode))
        .toThrow('delivery postcode');
    }
  });

  it('constructs the exact official search URL and verifies the returned capability', () => {
    const search = new URL(heppnerSearchUrl(TEST_TRACKING_NUMBER, TEST_POSTCODE));
    expect(search.origin).toBe('https://myportal.heppner-group.com');
    expect(search.pathname).toBe('/api/recipient/search/expedition');
    expect(Object.fromEntries(search.searchParams)).toEqual({
      zipCode: TEST_POSTCODE,
      receipt: TEST_TRACKING_NUMBER,
      countryCode: 'FR',
    });
    expect(parseHeppnerCapability(
      ` ${TEST_CAPABILITY}\n`,
      TEST_TRACKING_NUMBER,
      TEST_POSTCODE,
    )).toBe(TEST_CAPABILITY);
    expect(heppnerDetailUrl(TEST_CAPABILITY)).toBe(
      `https://myportal.heppner-group.com/api/recipient/search/detailexpedition?expedition=${encodeURIComponent(TEST_CAPABILITY)}`,
    );
    expect(heppnerTrackingPageUrl(TEST_CAPABILITY)).toBe(
      `https://myportal.heppner-group.com/tracking/${encodeURIComponent(TEST_CAPABILITY)}`,
    );
  });

  it('rejects capabilities for another shipment or malformed base64', () => {
    const wrong = Buffer.from('99999999&75001&FR').toString('base64');
    expect(() => parseHeppnerCapability(wrong, TEST_TRACKING_NUMBER, TEST_POSTCODE))
      .toThrow('different shipment');
    const belgian = Buffer.from(`${TEST_TRACKING_NUMBER}&1000&BE`).toString('base64');
    expect(parseHeppnerCapability(belgian, TEST_TRACKING_NUMBER, '1000', 'BE')).toBe(belgian);
    expect(() => parseHeppnerCapability(belgian, TEST_TRACKING_NUMBER, '1000', 'CH'))
      .toThrow('different shipment');
    expect(() => parseHeppnerCapability('not-a-capability', TEST_TRACKING_NUMBER, TEST_POSTCODE))
      .toThrow(SchemaError);
    expect(() => parseHeppnerCapability('not-a-capability', TEST_TRACKING_NUMBER, TEST_POSTCODE))
      .toThrow('invalid tracking capability');
  });
});

describe('Heppner status vocabulary', () => {
  it('maps milestones first and code prefixes second, and ignores junk identifiers', () => {
    expect(classifyHeppnerEvent('LIVREE', 'EXPE_EN_COURS', '')).toMatchObject({ stage: 'delivered' });
    expect(classifyHeppnerEvent('', 'EXPE_EN_COURS', 'POD_XYZ')).toMatchObject({ stage: 'delivered' });
    expect(classifyHeppnerEvent('', 'ANOMALIE', '')).toMatchObject({ stage: 'exception' });
    expect(classifyHeppnerEvent('UNKNOWN_STEP', '', '')).toMatchObject({
      status: 'unknown',
      stage: 'in_transit',
      description: 'Heppner tracking update',
    });
    expect(heppnerCode('<script>alert(1)</script>')).toBe('');
    expect(heppnerCode(' pch_cfm ')).toBe('PCH_CFM');
  });

  it('reads each closing SOL_ code by its own meaning', () => {
    for (const code of ['SOL_REI', 'SOL_REO']) {
      expect(classifyHeppnerEvent('', 'EXPE_EN_COURS', code)).toMatchObject({ stage: 'returned' });
    }
    // A new address under a new reference: the goods go on, they are not returned.
    for (const step of ['MARCHANDISE_REEXPEDIEE', 'MARCHANDISE_RETOURNEE', '']) {
      expect(classifyHeppnerEvent(step, 'EXPE_EN_COURS', 'SOL_RXI')).toEqual({ status: 'in_transit', stage: 'in_transit',
        description: 'Forwarded to a new address under a new reference' });
    }
    for (const code of ['SOL_ANN', 'SOL_MAR', 'SOL_MQD']) {
      expect(classifyHeppnerEvent('', 'EXPE_EN_COURS', code)).toMatchObject({ stage: 'exception', description: 'Shipment cancelled' });
    }
    expect(classifyHeppnerEvent('ACHEMINEMENT', 'EXPE_EN_COURS', 'SOL_REC')).toMatchObject({ stage: 'in_transit' });
  });
});

describe('Heppner response normalization', () => {
  it('parses a provider-shaped timeline and excludes shipment parties and credentials', () => {
    const result = parseHeppnerTrackingResponse(trackingPayload(), TEST_TRACKING_NUMBER);

    expect(result).toMatchObject({
      status: 'exception',
      last_status_text: 'Returned to sender',
      last_update: '2026-07-01T13:21:00Z',
      expected_delivery: null,
      timezone: 'Europe/Paris',
    });
    expect(result.events).toEqual([{
      time: '2026-07-01T13:21:00Z',
      location: '',
      description: 'Returned to sender',
      stage: 'returned',
      provider_code: 'SOL_REI',
    }, {
      time: '2026-07-01T10:55:00Z',
      location: '',
      description: 'Delivery instructions required',
      stage: 'exception',
      provider_code: 'RST_PRE',
    }, {
      time: '2026-06-30T06:03:00Z',
      location: '',
      description: 'Out for delivery',
      stage: 'out_for_delivery',
      provider_code: 'MLV_RCA',
    }, {
      time: '2026-06-26T11:18:00Z',
      location: '',
      description: 'Shipment collected',
      stage: 'accepted',
      provider_code: 'PCH_CFM',
    }, {
      time: '2026-06-26T00:06:00Z',
      location: '',
      description: 'In transit',
      stage: 'in_transit',
      provider_code: 'EXP_CFM',
    }]);
    const serialized = JSON.stringify(result);
    for (const privateValue of [
      'PRIVATE SENDER',
      'PRIVATE RECIPIENT',
      'PRIVATE ORDER REFERENCE',
      'PRIVATE MERCHANDISE',
      'PRIVATE PICKUP CODE',
      'PRIVATE ADDRESS',
      'PRIVATE APPOINTMENT TOKEN',
    ]) expect(serialized).not.toContain(privateValue);
  });

  it('produces every capability carrier.json declares', () => {
    const result: CarrierResult = parseHeppnerTrackingResponse(trackingPayload(), TEST_TRACKING_NUMBER);
    const events = result.events ?? [];
    const produced = new Set([
      ...(events.length > 0 ? ['history'] : []),
      ...(events.some((event) => event.location) ? ['location'] : []),
      ...(events.some((event) => event.provider_code) ? ['provider_code'] : []),
      ...(result.expected_delivery ? ['eta'] : []),
      ...(result.expected_delivery_from ? ['eta_window'] : []),
      ...(result.sender_name ? ['sender_name'] : []),
      ...(result.pickup_point ? ['pickup_point'] : []),
      ...(result.weight_kg != null ? ['weight'] : []),
      ...(result.dimensions_text ? ['dimensions'] : []),
      ...(result.delivered_at ? ['delivered_at'] : []),
    ]);
    expect(carrier.capabilities.length).toBeGreaterThan(0);
    for (const capability of carrier.capabilities) expect([...produced]).toContain(capability);
  });

  it('rejects empty, malformed, mismatched, and incomplete payloads', () => {
    expect(() => parseHeppnerTrackingResponse([], TEST_TRACKING_NUMBER))
      .toThrow(NotFoundError);
    expect(() => parseHeppnerTrackingResponse({}, TEST_TRACKING_NUMBER))
      .toThrow('invalid tracking response');
    expect(() => parseHeppnerTrackingResponse(trackingPayload('99999999'), TEST_TRACKING_NUMBER))
      .toThrow('different shipment');
    expect(() => parseHeppnerTrackingResponse([{
      receipt: TEST_TRACKING_NUMBER,
      events: [],
    }], TEST_TRACKING_NUMBER)).toThrow('tracking history');
  });
});

describe('Heppner tracker', () => {
  it('performs the bounded official search then detail requests', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    fetcher.mockResolvedValueOnce(new Response(TEST_CAPABILITY, {
      headers: { 'Content-Type': 'text/plain' },
    }));
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(trackingPayload()), {
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(new HeppnerTracker({ timeoutMs: 1_000 }).fetch(TEST_TRACKING_NUMBER, TEST_POSTCODE))
      .resolves.toMatchObject({ status: 'exception' });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      heppnerSearchUrl(TEST_TRACKING_NUMBER, TEST_POSTCODE),
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store', redirect: 'error' });
    expect(String(fetcher.mock.calls[1]?.[0])).toBe(heppnerDetailUrl(TEST_CAPABILITY));
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('Referer'))
      .toBe(heppnerTrackingPageUrl(TEST_CAPABILITY));
  });

  it('asks each four-digit country in turn and keeps the one that holds the shipment', async () => {
    const belgian = Buffer.from(`${TEST_TRACKING_NUMBER}&1000&BE`).toString('base64');
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('NOT_FOUND', { status: 404 }))
      .mockResolvedValueOnce(new Response(belgian))
      .mockResolvedValueOnce(new Response(JSON.stringify(trackingPayload())));

    await expect(new HeppnerTracker({ fetcher, timeoutMs: 1_000 }).fetch(TEST_TRACKING_NUMBER, '1000'))
      .resolves.toMatchObject({ status: 'exception' });
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('countryCode')))
      .toEqual(['CH', 'BE', null]);
    expect(String(fetcher.mock.calls[2]?.[0])).toBe(heppnerDetailUrl(belgian));
  });

  it('reports a missing shipment only when every country says so', async () => {
    const missing = vi.fn<typeof fetch>().mockImplementation(async () => new Response('NOT_FOUND', { status: 404 }));
    await expect(new HeppnerTracker({ fetcher: missing, timeoutMs: 1_000 }).fetch(TEST_TRACKING_NUMBER, '1000'))
      .rejects.toBeInstanceOf(NotFoundError);
    expect(missing).toHaveBeenCalledTimes(3);

    const blocked = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Busy', { status: 503 }))
      .mockImplementation(async () => new Response('NOT_FOUND', { status: 404 }));
    await expect(new HeppnerTracker({ fetcher: blocked, timeoutMs: 1_000 }).fetch(TEST_TRACKING_NUMBER, '1000'))
      .rejects.not.toBeInstanceOf(NotFoundError);
    expect(blocked).toHaveBeenCalledTimes(3);
  });

  it('turns the official wrong-number response into a clean privacy-safe 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      'NOT_FOUND: PRIVATE INTERNAL PROVIDER DETAIL',
      { status: 404 },
    ));

    let error: unknown;
    try {
      await new HeppnerTracker({ timeoutMs: 1_000 }).fetch('00000000', '75001');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error).toMatchObject({
      kind: 'not_found',
      status: 404,
      provider: 'Heppner',
      message: 'Heppner could not locate the shipment',
    });
    expect(JSON.stringify(error)).not.toContain('PRIVATE INTERNAL PROVIDER DETAIL');
  });
});
