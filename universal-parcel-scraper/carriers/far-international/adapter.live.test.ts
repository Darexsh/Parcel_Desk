import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('FAR International live retrieval', () => {
  it.skipIf(!process.env.FAR_INTERNATIONAL_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.FAR_INTERNATIONAL_TRACKING_NUMBER!, carrier: 'far-international' });
    expect(answer).toMatchObject({ carrier: 'far-international', source: 'far-international' });
    expect(answer.attempts[0]).toMatchObject({ source: 'far-international', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // A scan has an instant at the offset the tracker states, or its wall clock.
    expect(answer.result.events.every((event) => event.description && (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(String(event.time))
      || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.FAR_INTERNATIONAL_UNKNOWN_NUMBER)('reads a number the tracker has nothing for as no history', async () => {
    await expect(direct().track({ number: process.env.FAR_INTERNATIONAL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'indeterminate', name: 'NoHistoryError' });
  }, 30_000);
});
