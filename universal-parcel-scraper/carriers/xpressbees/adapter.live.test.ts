import { describe, expect, it } from 'vitest';
import { XpressbeesTracker } from './adapter.js';
describe('Xpressbees seller live tracking', () => {
  it.skipIf(!process.env.XPRESSBEES_TRACKING_NUMBER)('returns seller-platform history for an Xpressbees AWB', async () => {
    const result = await new XpressbeesTracker().fetch(process.env.XPRESSBEES_TRACKING_NUMBER!);
    expect(result.events?.length).toBeGreaterThan(0); expect(result.last_status_text).toEqual(expect.any(String));
  });
});
