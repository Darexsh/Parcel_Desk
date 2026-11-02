import { describe, expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

describe('Ozon guest history', () => {
  it.skipIf(!process.env.FLARESOLVERR_URL || !process.env.OZON_TRACKING_NUMBER)('reads the complete native timeline', async () => {
    const answer = await createTracker({ providers: [], trawlUrl: process.env.FLARESOLVERR_URL })
      .track({ carrier: 'ozon-logistics', number: process.env.OZON_TRACKING_NUMBER! });
    expect(answer.source).toBe('ozon-logistics');
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.time && event.provider_code && event.description)).toBe(true);
  }, 60000);
});
