import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('UKP Worldwide live retrieval', () => {
  it.skipIf(!process.env.UKP_WORLDWIDE_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.UKP_WORLDWIDE_TRACKING_NUMBER!, carrier: 'ukp-worldwide' });
    expect(answer).toMatchObject({ carrier: 'ukp-worldwide', source: 'ukp-worldwide' });
    expect(answer.attempts[0]).toMatchObject({ source: 'ukp-worldwide', kind: 'ok' });
    const { events } = answer.result;
    expect(events.length).toBeGreaterThan(0);
    // Wall clocks without an offset, none after the lookup.
    expect(events.every((event) => event.description && event.local_time && !(event.time && Date.parse(event.time) > Date.now()))).toBe(true);
  });

  it.skipIf(!process.env.UKP_WORLDWIDE_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.UKP_WORLDWIDE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
