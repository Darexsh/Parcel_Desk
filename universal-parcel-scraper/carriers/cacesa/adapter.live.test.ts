import { describe, expect, it } from 'vitest';
import { CacesaTracker } from './adapter.js';

describe('CACESA live direct retrieval', () => {
  it.skipIf(!process.env.CACESA_TRACKING_NUMBER)('retrieves the parcel history', async () => {
    const result = await new CacesaTracker().fetch(process.env.CACESA_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => /[+-]0[12]:00$/.test(event.time ?? '') && event.provider_code)).toBe(true);
    expect(result.last_status_text).toBeTruthy();
  });
  it.skipIf(!process.env.CACESA_UNKNOWN_NUMBER)('identifies the not-found answer', async () => {
    await expect(new CacesaTracker().fetch(process.env.CACESA_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
