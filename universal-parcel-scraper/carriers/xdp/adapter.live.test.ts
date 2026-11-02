import { describe, expect, it } from 'vitest';
import { XdpTracker } from './adapter.js';

const postcode = process.env.XDP_POSTCODE;

describe('XDP live direct retrieval', () => {
  it.skipIf(!process.env.XDP_TRACKING_NUMBER || !postcode)('retrieves the consignment history', async () => {
    const result = await new XdpTracker().fetch(process.env.XDP_TRACKING_NUMBER!, postcode);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && !event.time && event.provider_code)).toBe(true);
    expect(result.last_status_text).toBeTruthy();
  });
  it.skipIf(!process.env.XDP_UNKNOWN_NUMBER || !postcode)('identifies the not-found answer', async () => {
    await expect(new XdpTracker().fetch(process.env.XDP_UNKNOWN_NUMBER!, postcode)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
