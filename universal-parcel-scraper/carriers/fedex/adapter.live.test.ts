import { describe, expect, it } from 'vitest';
import type { CarrierResult } from '../../core/result/index.js';
import { TrawlClient } from '../../core/transport/index.js';
import { FedExTracker } from './adapter.js';
import { fedexApiCredentials } from './api.js';

// A real shipment supplied outside the repository, e.g.
// FEDEX_LIVE_TRACKING_NUMBER=<tracking-number> npm run test:carriers:live
// Open-source rule: never commit the number, a response, the API keys, or any
// private field it returns. The wrong-number probe below needs no browser service.
const LIVE_TRACKING_NUMBER = (process.env.FEDEX_LIVE_TRACKING_NUMBER ?? '').trim();
const API = fedexApiCredentials(process.env);

/** Only the fields the parser projects, and a history. */
function expectProjected(result: CarrierResult): void {
  expect(result.status).not.toBe('unknown');
  expect(result.last_status_text).toEqual(expect.any(String));
  expect((result.events ?? []).length).toBeGreaterThan(0);
  for (const key of Object.keys(result)) {
    expect([
      'status',
      'current_stage',
      'last_status_text',
      'last_update',
      'last_update_local',
      'expected_delivery',
      'delivered_at',
      'pickup_point',
      'delivery_carrier',
      'delivery_tracking_number',
      'events',
      'tracking_source',
      'tracking_url',
    ]).toContain(key);
  }
  for (const event of result.events ?? []) {
    expect(Object.keys(event).every((key) => [
      'description',
      'location',
      'stage',
      'time',
      'local_time',
    ].includes(key))).toBe(true);
  }
}

describe('FedEx live tracking', () => {
  it('reports the missing browser service instead of burning a direct attempt', async () => {
    await expect(new FedExTracker({ trawl: null, timeoutMs: 5_000 }).fetch('999999999999'))
      .rejects.toMatchObject({
        name: 'ChallengeError',
        message: 'FedEx challenged direct tracking; configure FLARESOLVERR_URL for browser fallback',
      });
  });

  it.runIf(Boolean(LIVE_TRACKING_NUMBER && process.env.FLARESOLVERR_URL?.trim()))(
    'normalizes a caller-supplied real shipment through the browser without retaining private response fields',
    async () => {
      const result = await new FedExTracker({ trawl: TrawlClient.fromEnvironment(), timeoutMs: 90_000 }).fetch(LIVE_TRACKING_NUMBER);
      expect(result.tracking_source).toBe('structured-web-response');
      expectProjected(result);
    },
  );

  it.runIf(Boolean(LIVE_TRACKING_NUMBER && API))(
    'normalizes a caller-supplied real shipment through the official API without retaining private response fields',
    async () => {
      const result = await new FedExTracker({ trawl: null, api: API }).fetch(LIVE_TRACKING_NUMBER);
      expect(result.tracking_source).toBe('official-api-response');
      expectProjected(result);
    },
  );
});
