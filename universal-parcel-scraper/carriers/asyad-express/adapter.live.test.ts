import { describe, expect, it } from 'vitest';
import { AsyadExpressTracker } from './adapter.js';

describe('Asyad Express guest retrieval', () => {
  it.skipIf(!process.env.ASYAD_EXPRESS_TRACKING_NUMBER)('reads express history', async () => {
    const result = await new AsyadExpressTracker().fetch(process.env.ASYAD_EXPRESS_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.description && event.local_time)).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.OMAN_POST_TRACKING_NUMBER)('reads the postal fallback with identity-bound history', async () => {
    const result = await new AsyadExpressTracker().fetch(process.env.OMAN_POST_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.history_truncated).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.ASYAD_EXPRESS_UNKNOWN_NUMBER)('requires both systems to confirm absence', async () => {
    await expect(new AsyadExpressTracker().fetch(process.env.ASYAD_EXPRESS_UNKNOWN_NUMBER!)).rejects.toHaveProperty('kind', 'not_found');
  }, 30_000);
});
