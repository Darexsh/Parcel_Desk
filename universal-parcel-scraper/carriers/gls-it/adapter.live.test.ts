import { describe, expect, it } from 'vitest';
import { GLSItalyTracker } from './adapter.js';

describe('GLS Italy live direct retrieval', () => {
  it.skipIf(!process.env.GLS_IT_TRACKING_NUMBER)('retrieves the shipment history', async () => {
    const result = await new GLSItalyTracker().fetch(process.env.GLS_IT_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    // Timed scans carry Italian time; a scan with only a date keeps it.
    expect(result.events!.every(event => /[+-]0[12]:00$/.test(String(event.time ?? '')) || /^\d{4}-\d{2}-\d{2}$/.test(String(event.local_time ?? '')))).toBe(true);
    expect(result.last_status_text).toBeTruthy();
  });
  it.skipIf(!process.env.GLS_IT_UNKNOWN_NUMBER)('identifies the not-found answer', async () => {
    await expect(new GLSItalyTracker().fetch(process.env.GLS_IT_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
