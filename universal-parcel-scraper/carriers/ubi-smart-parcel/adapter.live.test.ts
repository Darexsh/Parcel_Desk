import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('UBI Smart Parcel live retrieval', () => {
  it.skipIf(!process.env.UBI_SMART_PARCEL_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const number = process.env.UBI_SMART_PARCEL_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'ubi-smart-parcel' });
    expect(answer).toMatchObject({ carrier: 'ubi-smart-parcel', source: 'ubi-smart-parcel' });
    expect(answer.attempts[0]).toMatchObject({ source: 'ubi-smart-parcel', kind: 'ok' });
    expect(answer.result.current_stage).toBeDefined();
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => (event.time || event.local_time) && event.description)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.UBI_SMART_PARCEL_UNKNOWN_NUMBER)('reads the tracker’s unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.UBI_SMART_PARCEL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.UBI_SMART_PARCEL_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
