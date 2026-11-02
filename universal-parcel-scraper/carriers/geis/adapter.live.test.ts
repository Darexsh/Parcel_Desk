import { describe, expect, it } from 'vitest';
import { GeisTracker } from './adapter.js';

describe('Geis live direct retrieval', () => {
  it.skipIf(!process.env.GEIS_TRACKING_NUMBER)('retrieves the consignment history', async () => {
    const result = await new GeisTracker().fetch(process.env.GEIS_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => (event.time || event.local_time) && event.description)).toBe(true);
    expect(result.last_status_text).toBeTruthy();
  });
  it.skipIf(!process.env.GEIS_UNKNOWN_NUMBER)('identifies the not-found answer', async () => {
    await expect(new GeisTracker().fetch(process.env.GEIS_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
