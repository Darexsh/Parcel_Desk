import { describe, expect, it } from 'vitest';
import { EcmsExpressTracker } from './adapter.js';

describe('ECMS Express live tracking', () => {
  it.skipIf(!process.env.ECMS_EXPRESS_TRACKING_NUMBER)('solves a fresh challenge and retrieves matching history', async () => {
    const tracker = new EcmsExpressTracker();
    try {
      const result = await tracker.fetch(process.env.ECMS_EXPRESS_TRACKING_NUMBER!);
      expect(result.events!.length).toBeGreaterThan(0);
      expect(result.events!.every(event => event.local_time && event.description)).toBe(true);
    } finally { await tracker.close(); }
  });
  it.skipIf(!process.env.ECMS_EXPRESS_UNKNOWN_NUMBER)('recognizes an explicit empty lookup after verification', async () => {
    const tracker = new EcmsExpressTracker();
    try { await expect(tracker.fetch(process.env.ECMS_EXPRESS_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' }); }
    finally { await tracker.close(); }
  });
});
