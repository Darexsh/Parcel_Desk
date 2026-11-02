import { describe, expect, it } from 'vitest';
import { NovaPoshtaTracker } from './adapter.js';
describe('Nova Poshta live tracking', () => {
  it.skipIf(!process.env.NOVA_POSHTA_TRACKING_NUMBER)('returns Ukrainian shipment progress', async () => {
    const result = await new NovaPoshtaTracker().fetch(process.env.NOVA_POSHTA_TRACKING_NUMBER!);
    expect(result.last_status_text).toEqual(expect.any(String));
    expect(result.summary_only === true || Boolean(result.events?.length)).toBe(true);
  });
});
