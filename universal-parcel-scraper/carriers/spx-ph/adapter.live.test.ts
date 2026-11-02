import { describe, expect, it } from 'vitest';
import { SpxPhTracker } from './adapter.js';
describe('SPX Philippines live tracking', () => {
  it.skipIf(!process.env.SPX_PH_TRACKING_NUMBER)('returns Philippine single-parcel history', async () => {
    const result = await new SpxPhTracker().fetch(process.env.SPX_PH_TRACKING_NUMBER!);
    expect(result.events?.length).toBeGreaterThan(0); expect(result.last_status_text).toEqual(expect.any(String));
  });
});
