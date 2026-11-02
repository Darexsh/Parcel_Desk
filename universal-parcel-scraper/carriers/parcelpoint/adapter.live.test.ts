import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A scan's clock: an instant to the minute in UTC.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/;

describe('ParcelPoint live retrieval', () => {
  it.skipIf(!process.env.PARCELPOINT_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.PARCELPOINT_TRACKING_NUMBER!, carrier: 'parcelpoint' });
    expect(answer).toMatchObject({ carrier: 'parcelpoint', source: 'parcelpoint' });
    expect(answer.attempts[0]).toMatchObject({ source: 'parcelpoint', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && event.provider_code && INSTANT.test(String(event.time)))).toBe(true);
    expect(answer.result.current_stage).toBeTruthy();
  }, 45_000);

  it.skipIf(!process.env.PARCELPOINT_BOOKING_CODE)('opens a parcel by its booking code', async () => {
    const result = await direct().track({ number: process.env.PARCELPOINT_BOOKING_CODE! });
    expect(result.events!.length).toBeGreaterThan(0);
  }, 45_000);

  it.skipIf(!process.env.PARCELPOINT_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.PARCELPOINT_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
