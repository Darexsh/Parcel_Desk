import { describe, expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { TrendyolTracker } from './adapter.js';

describe('Trendyol Express browser retrieval', () => {
  it.skipIf(!process.env.FLARESOLVERR_URL || !process.env.TRENDYOL_EXPRESS_TRACKING_NUMBER)('reads native history without universal providers', async () => {
    const answer = await createTracker({ providers: [], trawlUrl: process.env.FLARESOLVERR_URL })
      .track({ carrier: 'trendyol-express', number: process.env.TRENDYOL_EXPRESS_TRACKING_NUMBER! });
    expect(answer).toMatchObject({ source: 'trendyol-express', attempts: [{ source: 'trendyol-express', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.local_time && event.description)).toBe(true);
  }, 60_000);

  it.skipIf(!process.env.FLARESOLVERR_URL || !process.env.TRENDYOL_EXPRESS_UNKNOWN_NUMBER)('requires the number in the missing-shipment notice', async () => {
    await expect(new TrendyolTracker({ trawl: TrawlClient.fromEnvironment() })
      .fetch(process.env.TRENDYOL_EXPRESS_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  }, 60_000);
});
