import { describe, expect, it } from 'vitest';
import { AmazonShippingHistoryExpiredError, AmazonShippingNotFoundError, AmazonShippingTracker } from './adapter.js';

const LIVE_TRACKING_NUMBER = process.env.AMAZON_SHIPPING_LIVE_TRACKING_NUMBER ?? '';

describe('Amazon Shipping live anonymous tracking', () => {
  it('maps the official valid-shaped wrong-number response to a clean 404', async () => {
    await expect(new AmazonShippingTracker().fetch('FR0000000000')).rejects.toMatchObject({
      name: 'AmazonShippingNotFoundError',
      message: 'Amazon Shipping could not locate the shipment',
      status: 404,
    });
  });

  it.runIf(Boolean(LIVE_TRACKING_NUMBER))(
    'normalizes a caller-supplied real shipment without retaining private response fields',
    async () => {
      if (process.env.AMAZON_SHIPPING_EXPECT_NOT_FOUND === 'true') {
        await expect(new AmazonShippingTracker().fetch(LIVE_TRACKING_NUMBER)).rejects.toBeInstanceOf(AmazonShippingNotFoundError);
        return;
      }
      if (process.env.AMAZON_SHIPPING_EXPECT_EXPIRED === 'true') {
        await expect(new AmazonShippingTracker().fetch(LIVE_TRACKING_NUMBER)).rejects.toBeInstanceOf(AmazonShippingHistoryExpiredError);
        return;
      }
      const result = await new AmazonShippingTracker().fetch(LIVE_TRACKING_NUMBER);
      expect(result.status).not.toBe('unknown');
      expect(result.current_stage).toEqual(expect.any(String));
      expect(result.last_status_text).toEqual(expect.any(String));
      // TBA, TBC and TBM numbers name no zone: their clocks stay wall-clock readings.
      const zoned = !/^TB/i.test(LIVE_TRACKING_NUMBER);
      const delivered = result.current_stage === 'delivered';
      expect(Object.keys(result).sort()).toEqual([
        'current_stage',
        ...(zoned && delivered ? ['delivered_at'] : []),
        'events',
        'expected_delivery',
        'last_status_text',
        'last_update',
        ...(!zoned && result.events?.[0]?.local_time ? ['last_update_local'] : []),
        'status',
        ...(zoned ? ['timezone'] : []),
      ]);
      if (delivered) expect(result.expected_delivery).toBeNull();
      for (const event of result.events ?? []) {
        expect(Object.keys(event).every((key) => [
          'description',
          'local_time',
          'location',
          'provider_code',
          'provider_time_text',
          'stage',
          'time',
        ].includes(key))).toBe(true);
      }
    },
  );
});
