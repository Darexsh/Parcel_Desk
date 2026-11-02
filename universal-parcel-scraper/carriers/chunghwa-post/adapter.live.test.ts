import { describe, expect, it } from 'vitest';
import { ChunghwaPostTracker } from './adapter.js';

describe('Chunghwa Post live international tracking', () => {
  it.skipIf(!process.env.CHUNGHWA_POST_TRACKING_NUMBER)('solves the current image and retrieves matching international history', async () => {
    const tracker = new ChunghwaPostTracker();
    try {
      const result = await tracker.fetch(process.env.CHUNGHWA_POST_TRACKING_NUMBER!);
      expect(result.events!.length).toBeGreaterThan(0);
      expect(result.events!.every(event => event.local_time)).toBe(true);
    } finally { await tracker.close(); }
  });
  it.skipIf(!process.env.CHUNGHWA_POST_UNKNOWN_NUMBER)('distinguishes the explicit unknown-item response', async () => {
    const tracker = new ChunghwaPostTracker();
    try { await expect(tracker.fetch(process.env.CHUNGHWA_POST_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' }); }
    finally { await tracker.close(); }
  });
});
