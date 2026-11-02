import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('A1 POST live retrieval', () => {
  it.skipIf(!process.env.A1_POST_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.A1_POST_TRACKING_NUMBER!, carrier: 'a1-post' });
    expect(answer).toMatchObject({ carrier: 'a1-post', source: 'a1-post' });
    expect(answer.attempts[0]).toMatchObject({ source: 'a1-post', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // A1 POST's own rows are Sofia wall clocks to the minute, read as instants.
    expect(answer.result.events.some((event) => event.stage
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+0[23]:00$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.every((event) => event.description)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.A1_POST_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.A1_POST_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
