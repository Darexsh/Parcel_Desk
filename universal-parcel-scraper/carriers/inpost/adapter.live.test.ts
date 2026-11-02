import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../../core/errors/index.js';
import { InpostTracker } from './adapter.js';

// Live compatibility checks for the keyless inposteasy.com hub. The wrong-number
// case runs in the opt-in live suite; the real-parcel case additionally needs a
// parcel the operator is authorized to query (never commit its number).
describe('InPost live anonymous tracking', () => {
  it('maps a validly shaped wrong number to a clean 404', async () => {
    await expect(new InpostTracker({ timeoutMs: 15_000 }).fetch('000000000000000000000000'))
      .rejects.toMatchObject({
        name: 'NotFoundError',
        status: 404,
        message: 'InPost could not locate the shipment',
      });
  });

  it.skipIf(!process.env.INPOST_DELIVERED_TRACKING_NUMBER)(
    'returns identity-bound history for a real delivered parcel',
    async () => {
      const trackingNumber = process.env.INPOST_DELIVERED_TRACKING_NUMBER!;
      const result = await new InpostTracker({ timeoutMs: 15_000 }).fetch(trackingNumber);
      expect(result.status).toBe('delivered');
      expect(result.current_stage).toBe('delivered');
      expect(result.events?.length).toBeGreaterThan(0);
    },
  );

  it('pins the not-found error contract used by routing cooldowns', () => {
    expect(new NotFoundError('InPost').status).toBe(404);
  });

  it.skipIf(!process.env.INPOST_PICKUP_TRACKING_NUMBER)('adds an identity-bound point to collection history', async () => {
    const result = await new InpostTracker().fetch(process.env.INPOST_PICKUP_TRACKING_NUMBER!);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(['ready_for_pickup', 'delivered']).toContain(result.current_stage);
    expect(result.pickup_point).toBeTruthy();
  });
});
