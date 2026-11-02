import { describe, expect, it } from 'vitest';
import { GLSSpainTracker } from './adapter.js';

const postcode = process.env.GLS_ES_POSTCODE;

describe('GLS Spain live direct retrieval', () => {
  it.skipIf(!process.env.GLS_ES_TRACKING_NUMBER || !postcode)('retrieves the shipment history', async () => {
    const result = await new GLSSpainTracker().fetch(process.env.GLS_ES_TRACKING_NUMBER!, postcode);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => /Z$/.test(event.time ?? '') && event.provider_code)).toBe(true);
    expect(result.last_status_text).toBeTruthy();
  });
  it.skipIf(!process.env.GLS_ES_UNKNOWN_NUMBER || !postcode)('identifies the not-found answer', async () => {
    await expect(new GLSSpainTracker().fetch(process.env.GLS_ES_UNKNOWN_NUMBER!, postcode)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
