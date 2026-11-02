import { describe, expect, it } from 'vitest';
import { IntelcomTracker } from './adapter.js';

describe('Canadian Intelcom / Dragonfly live compatibility', () => {
  it.skipIf(!process.env.INTELCOM_TRACKING_NUMBER)('returns identity-bound activity', async () => {
    const result = await new IntelcomTracker().fetch(process.env.INTELCOM_TRACKING_NUMBER!);
    expect(result.last_status_text).toEqual(expect.any(String));
    expect(Boolean(result.events?.length) || (result.summary_only && result.last_update)).toBeTruthy();
  });
});
