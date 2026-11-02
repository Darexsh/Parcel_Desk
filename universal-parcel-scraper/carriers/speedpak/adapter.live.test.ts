import { describe, expect, it } from 'vitest';
import { SpeedpakTracker } from './adapter.js';

describe('SpeedPAK live compatibility', () => {
  it.skipIf(!process.env.SPEEDPAK_TRACKING_NUMBER)('returns identity-bound history', async () => {
    const result = await new SpeedpakTracker().fetch(process.env.SPEEDPAK_TRACKING_NUMBER!);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.last_status_text).toEqual(expect.any(String));
    expect(result.events?.every(event => event.description && (event.time || event.provider_time_text))).toBe(true);
  });
});
