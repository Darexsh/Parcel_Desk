import { describe, expect, it } from 'vitest';
import { DHLSessionError, DHLTracker } from './adapter.js';

describe('DHL public tracking live', () => {
  it('distinguishes an explicit no-data response from a rejected HTTP session', async () => {
    try {
      const result = await new DHLTracker({ directTimeoutMs: 20_000, trawl: null }).fetch('LF000000005DE');
      expect(result).toMatchObject({ status: 'unknown', events: [], expected_delivery: null });
    } catch (error) {
      expect(error).toBeInstanceOf(DHLSessionError);
    }
  });
});
