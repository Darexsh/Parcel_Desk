import { describe, expect, it } from 'vitest';
import { GebruederWeissTracker } from './adapter.js';

const postcode = process.env.GEBRUEDER_WEISS_POSTCODE;

describe('Gebrüder Weiss live direct retrieval', () => {
  it.skipIf(!process.env.GEBRUEDER_WEISS_TRACKING_NUMBER || !postcode)('retrieves the shipment history', async () => {
    const result = await new GebruederWeissTracker().fetch(process.env.GEBRUEDER_WEISS_TRACKING_NUMBER!, postcode);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => (event.time || event.local_time) && event.provider_code)).toBe(true);
    expect(result.last_status_text).toBeTruthy();
  });
  it.skipIf(!process.env.GEBRUEDER_WEISS_UNKNOWN_NUMBER || !postcode)('identifies the not-found answer', async () => {
    await expect(new GebruederWeissTracker().fetch(process.env.GEBRUEDER_WEISS_UNKNOWN_NUMBER!, postcode)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
