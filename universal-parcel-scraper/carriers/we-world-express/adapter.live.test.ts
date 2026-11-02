import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('We World Express live retrieval', () => {
  it.skipIf(!process.env.WE_WORLD_EXPRESS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.WE_WORLD_EXPRESS_TRACKING_NUMBER!, carrier: 'we-world-express' });
    expect(answer).toMatchObject({ carrier: 'we-world-express', source: 'we-world-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'we-world-express', kind: 'ok' });
    const { events } = answer.result;
    expect(events.length).toBeGreaterThan(0);
    // Every scan worded and none after the lookup.
    expect(events.every((event) => event.description && (!event.time || Date.parse(event.time) <= Date.now()))).toBe(true);
  });

  it.skipIf(!process.env.WE_WORLD_EXPRESS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.WE_WORLD_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
