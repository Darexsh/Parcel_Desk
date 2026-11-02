import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import {
  ColiswebTracker,
  coliswebRequestBody,
  coliswebTrackingUrl,
  normalizeColiswebTrackingNumber,
  parseColiswebTrackingResponse,
} from './adapter.js';
import { classifyStatus } from './status.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// 10000000 is Colisweb's own documented UI example, not a real shipment.
const OFFICIAL_SYNTHETIC_NUMBER = '10000000';
const CAPABILITIES: readonly string[] = JSON.parse(
  readFileSync(path.join(here, 'carrier.json'), 'utf8'),
).capabilities;
const PRIVATE_PLACEHOLDERS = ['PRIVATE RECIPIENT', 'PRIVATE STREET'];

function successPayload(overrides: Record<string, unknown> = {}): unknown {
  const payload = JSON.parse(
    readFileSync(path.join(here, 'fixtures', 'delivered.json'), 'utf8'),
  ) as Record<string, unknown>;
  return { ...payload, ...overrides };
}

afterEach(() => vi.restoreAllMocks());

describe('Colisweb anonymous search request', () => {
  it('accepts the official digits-only format and rejects injection', () => {
    expect(normalizeColiswebTrackingNumber(' 1000 0000 ')).toBe(OFFICIAL_SYNTHETIC_NUMBER);
    for (const value of [
      '1234567',
      '1234567A',
      '10000000&admin=true',
      '1000-0000',
      '1'.repeat(33),
    ]) expect(() => normalizeColiswebTrackingNumber(value)).toThrow('at least 8 digits');
  });

  it('exposes the official endpoint and exact provider body', () => {
    expect(coliswebTrackingUrl()).toBe('https://www.colisweb.com/api/search');
    expect(coliswebRequestBody(OFFICIAL_SYNTHETIC_NUMBER)).toBe('{"value":"10000000"}');
  });
});

describe('Colisweb step mapping', () => {
  it('reads the provider spellings of the same step', () => {
    for (const value of ['pickedUp', 'picked_up', 'PACKAGE_WITHDRAWN']) {
      expect(classifyStatus(value)).toMatchObject({ status: 'in_transit', stage: 'in_transit' });
    }
  });

  it('leaves a step it does not know unmapped', () => {
    expect(classifyStatus('brand_new_step')).toEqual({
      status: 'unknown',
      description: 'Mise à jour Colisweb',
    });
  });
});

describe('Colisweb response normalization', () => {
  it('parses the provider response shape and retains only coarse shipment milestones', () => {
    const result = parseColiswebTrackingResponse(successPayload(), OFFICIAL_SYNTHETIC_NUMBER);

    expect(result).toMatchObject({
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: 'Livraison effectuée',
      last_update: '2026-08-29T14:15:00+02:00',
      expected_delivery: null,
      sender_name: 'EXAMPLE RETAILER',
      timezone: 'Europe/Paris',
    });
    expect(result.events).toEqual([
      {
        time: '2026-08-29T14:15:00+02:00',
        description: 'Livraison effectuée',
        stage: 'delivered',
      },
      {
        time: '2026-08-28T11:30:00+02:00',
        description: 'Colis pris en charge',
        stage: 'in_transit',
      },
      {
        time: '2026-08-27T08:00:00+02:00',
        description: 'Livraison confirmée',
        stage: 'registered',
      },
    ]);
    const serialized = JSON.stringify(result);
    for (const privateValue of PRIVATE_PLACEHOLDERS) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('returns every capability declared in carrier.json', () => {
    const pending = parseColiswebTrackingResponse(successPayload({
      step: 'confirmed',
      deliveredDate: null,
    }), OFFICIAL_SYNTHETIC_NUMBER);
    const checks: Record<string, () => boolean> = {
      history: () => (pending.events?.length ?? 0) > 0,
      eta: () => pending.expected_delivery != null,
      sender_name: () => Boolean(pending.sender_name),
    };
    expect(CAPABILITIES.length).toBeGreaterThan(0);
    for (const capability of CAPABILITIES) {
      expect(checks[capability], `no check for capability ${capability}`).toBeDefined();
      expect(checks[capability]!(), `capability ${capability} is declared but never returned`).toBe(true);
    }
  });

  it('maps current failure, return, and pending states conservatively', () => {
    const failure = parseColiswebTrackingResponse(successPayload({
      step: 'non_deliverable',
      deliveredDate: null,
    }), OFFICIAL_SYNTHETIC_NUMBER);
    expect(failure).toMatchObject({
      status: 'exception',
      last_status_text: 'Incident de livraison',
      expected_delivery: null,
    });
    expect(failure.events?.[0]).toMatchObject({ stage: 'exception' });
    expect(parseColiswebTrackingResponse(successPayload({
      step: 'deliveryReturned',
      deliveredDate: null,
    }), OFFICIAL_SYNTHETIC_NUMBER)).toMatchObject({ status: 'exception' });
    expect(parseColiswebTrackingResponse(successPayload({
      step: 'confirmed',
      deliveredDate: null,
    }), OFFICIAL_SYNTHETIC_NUMBER)).toMatchObject({
      status: 'pending',
      expected_delivery: '2026-08-29 13:00–15:00',
    });
  });

  it('shows the booked slot on Paris clocks while the delivery is planned', () => {
    const slot = (overrides: Record<string, unknown>) => parseColiswebTrackingResponse(successPayload({
      step: 'confirmed',
      deliveryConfirmationDate: '2026-01-02T09:00:00.000Z',
      deliveredDate: null,
      pickedUpDate: null,
      ...overrides,
    }), OFFICIAL_SYNTHETIC_NUMBER).expected_delivery;
    expect(slot({ startsAt: '2026-04-08T10:00:00Z', endsAt: '2026-04-08T12:00:00Z' }))
      .toBe('2026-04-08 12:00–14:00');
    expect(slot({ step: 'package_withdrawn', startsAt: '2026-01-15T08:00:00Z', endsAt: '2026-01-15T10:00:00Z' }))
      .toBe('2026-01-15 09:00–11:00');
    expect(slot({ startsAt: '2026-08-28T22:30:00Z', endsAt: '2026-08-29T00:30:00Z' }))
      .toBe('2026-08-29 00:30–02:30');
    for (const endsAt of [null, '2026-04-08T10:00:00Z', '2026-04-08T23:00:00Z', 'soon']) {
      expect(slot({ startsAt: '2026-04-08T10:00:00Z', endsAt })).toBe('2026-04-08');
    }
    expect(slot({ startsAt: '2026-04-08T10:00:00', endsAt: '2026-04-08T12:00:00' })).toBe('2026-04-08');
    expect(slot({ startsAt: 'soon', endsAt: '2026-04-08T12:00:00Z' })).toBeNull();
    // A slot that ended before the newest milestone has passed.
    expect(slot({
      step: 'package_withdrawn',
      pickedUpDate: '2026-04-09T07:00:00.000Z',
      startsAt: '2026-04-08T10:00:00Z',
      endsAt: '2026-04-08T12:00:00Z',
    })).toBeNull();
    expect(slot({ haveReschedule: true })).toBeNull();
    expect(slot({ inRescheduleProcess: true })).toBeNull();
    expect(slot({ step: 'brand_new_step' })).toBeNull();
    expect(slot({ step: 'package_withdrawal_failed' })).toBeNull();
  });

  it('reports an unknown step without a stage', () => {
    const result = parseColiswebTrackingResponse(successPayload({
      step: 'brand_new_step',
      deliveredDate: null,
      pickedUpDate: null,
      deliveryConfirmationDate: null,
    }), OFFICIAL_SYNTHETIC_NUMBER);
    expect(result.status).toBe('unknown');
    expect(result.current_stage).toBeUndefined();
    expect(result.events).toEqual([{ description: 'Mise à jour Colisweb' }]);
  });

  it('rejects mismatched or malformed success payloads and maps explicit not-found safely', () => {
    expect(() => parseColiswebTrackingResponse(
      successPayload({ searchValue: '99999999' }),
      OFFICIAL_SYNTHETIC_NUMBER,
    )).toThrow(SchemaError);
    expect(() => parseColiswebTrackingResponse(
      successPayload({ searchValue: '99999999' }),
      OFFICIAL_SYNTHETIC_NUMBER,
    )).toThrow('different shipment');
    expect(() => parseColiswebTrackingResponse({}, OFFICIAL_SYNTHETIC_NUMBER))
      .toThrow('incomplete tracking details');
    expect(() => parseColiswebTrackingResponse({
      error: 'Shipment not found with private provider details',
    }, OFFICIAL_SYNTHETIC_NUMBER)).toThrow(NotFoundError);
  });
});

describe('Colisweb tracker', () => {
  it('sends the bounded official POST request and parses success', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify(successPayload()),
      { headers: { 'Content-Type': 'application/json' } },
    ));

    await expect(new ColiswebTracker({ timeoutMs: 1_000 }).fetch(OFFICIAL_SYNTHETIC_NUMBER))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher.mock.calls[0]?.[0]).toBe(coliswebTrackingUrl());
    const init = fetcher.mock.calls[0]?.[1];
    expect(init).toMatchObject({
      method: 'POST',
      body: coliswebRequestBody(OFFICIAL_SYNTHETIC_NUMBER),
      cache: 'no-store',
      redirect: 'error',
    });
    const headers = new Headers(init?.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Origin')).toBe('https://www.colisweb.com');
  });

  it('keeps the observed empty-500 wrong-number response distinct from a clean 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));

    const failure = await new ColiswebTracker().fetch('99999999').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IndeterminateError);
    expect(failure).not.toBeInstanceOf(NotFoundError);
    expect(failure).toMatchObject({
      name: 'IndeterminateError',
      provider: 'Colisweb',
      message: 'Colisweb returned an empty HTTP 500 for the shipment lookup',
      kind: 'indeterminate',
      status: 502,
    });
  });

  it('maps an explicit provider 404 to a privacy-safe tracking error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private details', { status: 404 }));
    await expect(new ColiswebTracker().fetch('99999999')).rejects.toMatchObject({
      name: 'NotFoundError',
      provider: 'Colisweb',
      message: 'Colisweb could not locate the shipment',
      kind: 'not_found',
      status: 404,
    });
  });
});
