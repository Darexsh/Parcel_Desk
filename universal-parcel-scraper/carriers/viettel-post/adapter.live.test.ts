import { describe, expect, it } from 'vitest';
import { ViettelPostTracker } from './adapter.js';

const number = process.env.VIETTEL_POST_TRACKING_NUMBER;
const unknown = process.env.VIETTEL_POST_UNKNOWN_NUMBER;
describe('Viettel Post live legacy record', () => {
  it.skipIf(!number)('returns a bound partial record after local OCR', async () => {
    const tracker = new ViettelPostTracker();
    try { const result = await tracker.fetch(number!); expect(result.summary_only).toBe(true); expect(result.last_status_text).toEqual(expect.any(String)); }
    finally { await tracker.close(); }
  }, 40_000);
  it.skipIf(!unknown)('reports a valid empty lookup after verification as unknown', async () => {
    const tracker = new ViettelPostTracker();
    try { await expect(tracker.fetch(unknown!)).rejects.toMatchObject({ kind: 'not_found' }); }
    finally { await tracker.close(); }
  }, 40_000);
});
