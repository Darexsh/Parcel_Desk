import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('DHLink live retrieval', () => {
  it.skipIf(!process.env.DHLINK_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const number = process.env.DHLINK_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'dhlink' });
    expect(answer).toMatchObject({ carrier: 'dhlink', source: 'dhlink' });
    // The partner's lookup can follow the hand-off.
    expect(answer.attempts[0]).toMatchObject({ source: 'dhlink', kind: 'ok' });
    expect(answer.result.current_stage).toBeDefined();
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => (event.time || event.local_time) && event.description)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  // A number outside the FC and SWX layouts, for which DHLink's empty answer settles nothing.
  it.skipIf(!process.env.DHLINK_UNKNOWN_NUMBER)('reads the lookup’s answer for an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.DHLINK_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.DHLINK_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
