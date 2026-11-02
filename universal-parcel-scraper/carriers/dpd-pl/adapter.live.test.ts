import { describe, expect, it } from 'vitest';
import { DpdPlTracker } from './adapter.js';

describe('DPD Poland live direct retrieval', () => {
  it.skipIf(!process.env.DPD_PL_TRACKING_NUMBER)('retrieves the package history in English', async () => {
    const result = await new DpdPlTracker().fetch(process.env.DPD_PL_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.last_status_text).toBeTruthy();
  });
  it.skipIf(!process.env.DPD_PL_UNKNOWN_NUMBER)('identifies the explicit no-trace answer', async () => {
    await expect(new DpdPlTracker().fetch(process.env.DPD_PL_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
