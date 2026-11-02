import { describe, expect, it } from 'vitest';
import { HuahanTracker } from './adapter.js';

describe('HuaHan live guest tracking', () => {
  it.skipIf(!process.env.HUAHAN_TRACKING_NUMBER)('verifies the public question and retrieves matching history', async () => {
    const result = await new HuahanTracker().fetch(process.env.HUAHAN_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time)).toBe(true);
  });
  it.skipIf(!process.env.HUAHAN_UNKNOWN_NUMBER)('recognizes explicit absence after verification', async () => {
    await expect(new HuahanTracker().fetch(process.env.HUAHAN_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
