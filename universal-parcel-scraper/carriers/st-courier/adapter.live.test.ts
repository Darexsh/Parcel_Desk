import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('ST Courier live retrieval', () => {
  it.skipIf(!process.env.ST_COURIER_TRACKING_NUMBER)('retrieves the history of the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.ST_COURIER_TRACKING_NUMBER!, carrier: 'st-courier' });
    expect(answer).toMatchObject({ carrier: 'st-courier', source: 'st-courier' });
    expect(answer.attempts[0]).toMatchObject({ source: 'st-courier', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is read in Indian time and kept as an instant.
    expect(answer.result.events.every((event) => event.description && !event.local_time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(event.time)))).toBe(true);
    // A delivery keeps its wording without who took the parcel.
    expect(answer.result.events.every((event) => !/^Delivered to\b/i.test(String(event.description)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.ST_COURIER_TRACKING_NUMBER)('recognizes the requested consignment', async () => {
    await expect(direct().recognize!(process.env.ST_COURIER_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.ST_COURIER_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.ST_COURIER_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
