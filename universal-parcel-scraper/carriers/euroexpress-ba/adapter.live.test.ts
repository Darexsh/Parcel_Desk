import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('EuroExpress live retrieval', () => {
  it.skipIf(!process.env.EUROEXPRESS_BA_TRACKING_NUMBER)('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] })
      .track({ number: process.env.EUROEXPRESS_BA_TRACKING_NUMBER!, carrier: 'euroexpress-ba' });
    expect(answer).toMatchObject({ carrier: 'euroexpress-ba', source: 'euroexpress-ba' });
    expect(answer.attempts[0]).toMatchObject({ source: 'euroexpress-ba', kind: 'ok' });
    expect(answer.result.last_status_text).toBeTruthy();
    // The tracker can keep a shipment's summary without its scans.
    if (answer.result.summary_only) expect(answer.result.events).toEqual([]);
    else expect(answer.result.events.length).toBeGreaterThan(0);
    // Each scan has an instant with its offset or the wall clock it was written with.
    expect(answer.result.events.every((event) => event.description
      && (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(String(event.time))
        || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.EUROEXPRESS_BA_TRACKING_NUMBER)('recognizes the requested shipment', async () => {
    await expect(direct().recognize!(process.env.EUROEXPRESS_BA_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.EUROEXPRESS_BA_UNKNOWN_NUMBER)('reads an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.EUROEXPRESS_BA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.skipIf(!process.env.EUROEXPRESS_BA_UNKNOWN_NUMBER)('does not recognize an unknown code', async () => {
    await expect(direct().recognize!(process.env.EUROEXPRESS_BA_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
