import { describe, expect, it } from 'vitest';
import { IntexTracker } from './adapter.js';

describe('INTEX Paketdienst live direct retrieval', () => {
  it.skipIf(!process.env.INTEX_PAKETDIENST_TRACKING_NUMBER)('retrieves the shipment history', async () => {
    const result = await new IntexTracker().fetch(process.env.INTEX_PAKETDIENST_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.time && event.description)).toBe(true);
    expect(result.last_status_text).toBeTruthy();
  });
  it.skipIf(!process.env.INTEX_PAKETDIENST_UNKNOWN_NUMBER)('identifies the not-found answer', async () => {
    await expect(new IntexTracker().fetch(process.env.INTEX_PAKETDIENST_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
