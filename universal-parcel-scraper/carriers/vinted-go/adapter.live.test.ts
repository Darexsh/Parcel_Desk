import { describe, expect, it } from 'vitest';
import { VintedGoTracker } from './adapter.js';

describe('Vinted Go live direct retrieval', () => {
  it.skipIf(!process.env.VINTED_GO_TRACKING_NUMBER)('retrieves the parcel history', async () => {
    const result = await new VintedGoTracker().fetch(process.env.VINTED_GO_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => /Z$/.test(event.time ?? '') && event.provider_code)).toBe(true);
    expect(result.last_status_text).toBeTruthy();
  });
  it.skipIf(!process.env.VINTED_GO_UNKNOWN_NUMBER)('identifies the not-found answer', async () => {
    await expect(new VintedGoTracker().fetch(process.env.VINTED_GO_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
