import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../../core/errors/index.js';
import { UPSTracker } from './adapter.js';
import { UPSApiClient, upsApiCredentials } from './api.js';

// The deployment's developer.ups.com app and a real shipment, both supplied
// outside the repository, e.g.
// UPS_CLIENT_ID=… UPS_CLIENT_SECRET=… UPS_LIVE_TRACKING_NUMBER=<tracking-number> npm run test:carriers:live -- carriers/ups
// Open-source rule: never commit the credentials, the number, a response, or
// any private field it returns.
const CREDENTIALS = upsApiCredentials(process.env);
const LIVE_TRACKING_NUMBER = (process.env.UPS_LIVE_TRACKING_NUMBER ?? '').trim();

describe('UPS live Track API', () => {
  it.runIf(CREDENTIALS !== null)('accepts the credentials and answers a well-formed number', async () => {
    // A synthetic number: UPS answers it, or says it has no tracking for it.
    const answer = await new UPSApiClient(CREDENTIALS!).track('1Z999AA10123456784', AbortSignal.timeout(20_000), 20_000)
      .catch((error: unknown) => error);
    if (answer instanceof Error) expect(answer).toBeInstanceOf(NotFoundError);
    else expect(answer).toMatchObject({ trackResponse: expect.any(Object) });
  });

  it.runIf(CREDENTIALS !== null && Boolean(LIVE_TRACKING_NUMBER))(
    'normalizes a caller-supplied real shipment without retaining private response fields',
    async () => {
      const result = await new UPSTracker({ api: CREDENTIALS, trawl: null, timeoutMs: 30_000 }).fetch(LIVE_TRACKING_NUMBER);
      expect(result.tracking_source).toBe('official-api-response');
      expect(result.status).not.toBe('unknown');
      expect((result.events ?? []).length).toBeGreaterThan(0);
      for (const key of Object.keys(result)) {
        expect([
          'status',
          'current_stage',
          'current_stage_source',
          'last_status_text',
          'last_update',
          'expected_delivery',
          'delivered_at',
          'destination_country',
          'service_name',
          'delivery_carrier',
          'delivery_tracking_number',
          'events',
          'tracking_source',
          'tracking_url',
        ]).toContain(key);
      }
      for (const event of result.events ?? []) {
        expect(Object.keys(event).every((key) => [
          'time',
          'local_time',
          'provider_time_text',
          'location',
          'description',
          'provider_code',
          'stage',
          'stage_source',
        ].includes(key))).toBe(true);
      }
    },
  );
});
