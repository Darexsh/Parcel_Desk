import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('eCourier live retrieval', () => {
  it.skipIf(!process.env.ECOURIER_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.ECOURIER_TRACKING_NUMBER!, carrier: 'ecourier' });
    expect(answer).toMatchObject({ carrier: 'ecourier', source: 'ecourier' });
    expect(answer.attempts[0]).toMatchObject({ source: 'ecourier', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is read in Dhaka time.
    expect(answer.result.events.every((event) => event.description && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+06:00$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.some((event) => event.location)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.ECOURIER_TRACKING_NUMBER)('recognizes the parcel', async () => {
    await expect(direct().recognize!(process.env.ECOURIER_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.ECOURIER_UNKNOWN_NUMBER)('reads an unknown ID as not found', async () => {
    await expect(direct().track({ number: process.env.ECOURIER_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.ECOURIER_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 45_000);
});
