import { describe, expect, it } from 'vitest';
import { SafexpressTracker } from './adapter.js';

describe('Safexpress live tracking', () => {
  it.skipIf(!process.env.SAFEXPRESS_TRACKING_NUMBER)('returns dated matching waybill history', async () => {
    const result = await new SafexpressTracker().fetch(process.env.SAFEXPRESS_TRACKING_NUMBER!);
    expect(result.events?.some(event => event.time || event.local_time)).toBe(true);
    expect(result.summary_only).not.toBe(true);
  });

  it.skipIf(!process.env.SAFEXPRESS_UNKNOWN_NUMBER)('keeps an empty reply inconclusive', async () => {
    await expect(new SafexpressTracker().fetch(process.env.SAFEXPRESS_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'indeterminate' });
  });
});
