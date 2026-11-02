import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Bringer Parcel Xpress live retrieval', () => {
  it.skipIf(!process.env.BRINGER_PARCEL_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.BRINGER_PARCEL_TRACKING_NUMBER!, carrier: 'bringer-parcel' });
    expect(answer).toMatchObject({ carrier: 'bringer-parcel', source: 'bringer-parcel' });
    expect(answer.attempts[0]).toMatchObject({ source: 'bringer-parcel', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is an instant in UTC, with its code or parcel status.
    expect(answer.result.events.every((event) => event.description && event.provider_code
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(event.time)))).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.BRINGER_PARCEL_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.BRINGER_PARCEL_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.BRINGER_PARCEL_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.BRINGER_PARCEL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
