import { describe, expect, it } from 'vitest';
import { DHLEcommerceTracker } from './adapter.js';

describe('DHL eCommerce native recognition', () => {
  it.skipIf(!process.env.DHL_ECOMMERCE_TRACKING_NUMBER)('recognizes an authorized Webtrack shipment over HTTP', async () => {
    const answer = await new DHLEcommerceTracker().recognize(process.env.DHL_ECOMMERCE_TRACKING_NUMBER!);
    expect(answer.known).toBe(true);
  });

  it('reports a synthetic regional miss without starting a browser', async () => {
    await expect(new DHLEcommerceTracker().recognize('33870000000000001')).resolves.toEqual({ known: false });
  });
});
