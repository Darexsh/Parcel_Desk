import { describe, expect, it } from 'vitest';
import { EkartTracker } from './adapter.js';
describe('Ekart live tracking', () => {
  it.skipIf(!process.env.EKART_TRACKING_NUMBER)('returns ecommerce tracking history', async () => {
    const result = await new EkartTracker().fetch(process.env.EKART_TRACKING_NUMBER!);
    expect(result.events?.length).toBeGreaterThan(0); expect(result.last_status_text).toEqual(expect.any(String));
  });
});
