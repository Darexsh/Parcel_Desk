import { describe, expect, it } from 'vitest';
import { ToptransTracker } from './adapter.js';

describe('TOPTRANS live direct retrieval', () => {
  it.skipIf(!process.env.TOPTRANS_TRACKING_NUMBER)('retrieves the shipment history', async () => {
    const result = await new ToptransTracker().fetch(process.env.TOPTRANS_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.time && event.description)).toBe(true);
    expect(result.last_status_text).toBeTruthy();
  });
  it.skipIf(!process.env.TOPTRANS_PIECE_NUMBER)('retrieves a shipment by one of its piece numbers', async () => {
    const result = await new ToptransTracker().fetch(process.env.TOPTRANS_PIECE_NUMBER!);
    expect(result.canonical_tracking_number).toMatch(/^\d{11}$/);
    expect(result.events!.length).toBeGreaterThan(0);
  });
  it.skipIf(!process.env.TOPTRANS_UNKNOWN_NUMBER)('identifies the not-found answer', async () => {
    await expect(new ToptransTracker().fetch(process.env.TOPTRANS_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
