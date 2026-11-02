import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

describe('Straightship live retrieval', () => {
  it.skipIf(!process.env.STRAIGHTSHIP_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.STRAIGHTSHIP_TRACKING_NUMBER!, carrier: 'straightship' });
    expect(answer).toMatchObject({ carrier: 'straightship', source: 'straightship' });
    expect(answer.attempts[0]).toMatchObject({ source: 'straightship', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // The page states its clocks are UTC, and no scan comes after the lookup.
    expect(answer.result.events.every((event) => event.description && UTC.test(String(event.time)) && !event.local_time
      && Date.parse(String(event.time)) <= Date.now())).toBe(true);
    expect(answer.result.events.some((event) => event.stage)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.STRAIGHTSHIP_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.STRAIGHTSHIP_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.STRAIGHTSHIP_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.STRAIGHTSHIP_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.STRAIGHTSHIP_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
