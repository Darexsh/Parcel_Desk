import { describe, expect, it } from 'vitest';
import { TrawlClient } from '../../core/transport/index.js';
import { RoyalMailTracker } from './adapter.js';

// A real shipment supplied outside the repository, e.g.
// ROYAL_MAIL_LIVE_TRACKING_NUMBER=SG999999999GB npm run test:carriers:live
// Open-source rule: never commit the number, a response, or any private
// field it returns. The wrong-number probe below needs no browser service.
const LIVE_TRACKING_NUMBER = (process.env.ROYAL_MAIL_LIVE_TRACKING_NUMBER ?? '').trim();

describe('Royal Mail live browser tracking', () => {
  it('reports the missing browser service instead of burning a direct attempt', async () => {
    await expect(new RoyalMailTracker({ trawl: null, timeoutMs: 5_000 }).fetch('SG999999999GB'))
      .rejects.toMatchObject({
        name: 'ChallengeError',
        message: 'Royal Mail challenged direct tracking; configure FLARESOLVERR_URL for browser fallback',
      });
  });

  it.runIf(Boolean(LIVE_TRACKING_NUMBER))(
    'normalizes a caller-supplied real shipment without retaining private response fields',
    async () => {
      const result = await new RoyalMailTracker({ executablePath: process.env.TRACKING_CHROMIUM_PATH,
        browserWsEndpoint: process.env.ROYAL_MAIL_BROWSER_WS_ENDPOINT,
        trawl: TrawlClient.fromEnvironment(), timeoutMs: 60_000, fullHistory: true }).fetch(LIVE_TRACKING_NUMBER);
      expect(result.status).not.toBe('unknown');
      expect(result.last_status_text).toEqual(expect.any(String));
      expect(result.events?.length).toBeGreaterThan(0);
      expect(result.events?.some(event => event.time)).toBe(true);
      expect(result.summary_only).not.toBe(true);
      for (const key of Object.keys(result)) {
        expect([
          'status',
          'current_stage',
          'last_status_text',
          'last_update',
          'delivered_at',
          'expected_delivery',
          'destination_country',
          'events',
          'tracking_source',
          'tracking_url',
          'summary_only',
        ]).toContain(key);
      }
      for (const event of result.events ?? []) {
        expect(Object.keys(event).every((key) => [
          'description',
          'location',
          'provider_code',
          'stage',
          'stage_source',
          'time',
          'provider_time_text',
        ].includes(key))).toBe(true);
      }
    },
    80_000,
  );
  it.runIf(Boolean((process.env.TRACKING_CHROMIUM_PATH || process.env.ROYAL_MAIL_BROWSER_WS_ENDPOINT) && process.env.ROYAL_MAIL_UNKNOWN_NUMBER))(
    'keeps an unknown reference inconclusive rather than inventing history', async () => {
      await expect(new RoyalMailTracker({ executablePath: process.env.TRACKING_CHROMIUM_PATH,
        browserWsEndpoint: process.env.ROYAL_MAIL_BROWSER_WS_ENDPOINT, fullHistory: true })
        .fetch(process.env.ROYAL_MAIL_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    }, 65_000,
  );
});
