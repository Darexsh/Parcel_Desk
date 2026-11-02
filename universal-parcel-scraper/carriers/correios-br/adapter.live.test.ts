import { describe, expect, it } from 'vitest';
import { TrawlClient } from '../../core/transport/trawl.js';
import { CorreiosTracker } from './adapter.js';

describe('Correios live tracking', () => {
  // The portal sits behind Turnstile, so a lookup needs the browser service.
  it.skipIf(!process.env.CORREIOS_BR_TRACKING_NUMBER || !process.env.FLARESOLVERR_URL)('returns matching real history through the browser service', async () => {
    const tracker = new CorreiosTracker({ trawl: TrawlClient.fromEnvironment() });
    try {
      const result = await tracker.fetch(process.env.CORREIOS_BR_TRACKING_NUMBER!);
      expect(result.events?.length).toBeGreaterThan(0);
    } finally { await tracker.close(); }
  }, 60_000);
});
