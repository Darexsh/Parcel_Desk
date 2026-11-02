import { describe, expect, it } from 'vitest';
import { DaoTracker } from './adapter.js';

describe('DAO live direct retrieval', () => {
  it.skipIf(!process.env.DAO_TRACKING_NUMBER)('retrieves the parcel history', async () => {
    const result = await new DaoTracker().fetch(process.env.DAO_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && !event.time && /^(?:[A-Za-z]+\/)?\d+$/.test(event.provider_code ?? ''))).toBe(true);
    expect(result.last_status_text).toBeTruthy();
    expect(result.last_update).toBeNull();
  });
  it.skipIf(!process.env.DAO_UNKNOWN_NUMBER)('identifies the not-found answer', async () => {
    await expect(new DaoTracker().fetch(process.env.DAO_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
