import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('ProShips live retrieval', () => {
  it.skipIf(!process.env.PROSHIPS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.PROSHIPS_TRACKING_NUMBER!, carrier: 'proships' });
    expect(answer).toMatchObject({ carrier: 'proships', source: 'proships' });
    expect(answer.attempts[0]).toMatchObject({ source: 'proships', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its wall clock to the minute, without an offset.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.PROSHIPS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.PROSHIPS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
