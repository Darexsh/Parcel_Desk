import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../../core/errors/index.js';
import { CorreosSpainTracker } from './adapter.js';

// Live compatibility checks for the keyless localizador endpoint. Unknown codes
// answer 200 with a non-zero codError, which the adapter maps to a clean 404.
// An expedition code goes through the public tracker's search first, which
// answers 204 for one it does not know. The real-parcel cases additionally
// need a parcel the operator is authorized to query (never commit its number).
describe('Correos Spain live anonymous tracking', () => {
  it('maps a validly shaped wrong number to a clean 404', async () => {
    await expect(new CorreosSpainTracker({ timeoutMs: 15_000 }).fetch('PR000000000000000C'))
      .rejects.toMatchObject({
        name: 'NotFoundError',
        status: 404,
        message: 'Correos could not locate the shipment',
      });
  });

  it('maps an unknown expedition code to a clean 404', async () => {
    await expect(new CorreosSpainTracker({ timeoutMs: 15_000 }).fetch('PL0000000000000K'))
      .rejects.toMatchObject({ name: 'NotFoundError', status: 404 });
  });

  it.skipIf(!process.env.CORREOS_SPAIN_EXPEDITION_CODE)(
    'tracks the single parcel of a real expedition code',
    async () => {
      const result = await new CorreosSpainTracker({ timeoutMs: 15_000 }).fetch(process.env.CORREOS_SPAIN_EXPEDITION_CODE!);
      expect(result.events?.length).toBeGreaterThan(0);
    },
  );

  it.skipIf(!process.env.CORREOS_SPAIN_DELIVERED_TRACKING_NUMBER)(
    'returns identity-bound history for a real delivered parcel',
    async () => {
      const trackingNumber = process.env.CORREOS_SPAIN_DELIVERED_TRACKING_NUMBER!;
      const result = await new CorreosSpainTracker({ timeoutMs: 15_000 }).fetch(trackingNumber);
      expect(result.status).toBe('delivered');
      expect(result.current_stage).toBe('delivered');
      expect(result.events?.length).toBeGreaterThan(0);
    },
  );

  it.skipIf(!process.env.CORREOS_SPAIN_PICKUP_TRACKING_NUMBER)(
    'gives the office holding a real parcel its address',
    async () => {
      const result = await new CorreosSpainTracker({ timeoutMs: 15_000 }).fetch(process.env.CORREOS_SPAIN_PICKUP_TRACKING_NUMBER!);
      expect(result.current_stage).toBe('ready_for_pickup');
      expect(result.pickup_point?.split('\n')).toHaveLength(3);
    },
  );

  it('pins the not-found error contract used by routing cooldowns', () => {
    expect(new NotFoundError('Correos').status).toBe(404);
  });
});
