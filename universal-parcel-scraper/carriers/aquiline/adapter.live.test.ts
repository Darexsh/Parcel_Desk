import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Aquiline live retrieval', () => {
  it.skipIf(!process.env.AQUILINE_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.AQUILINE_TRACKING_NUMBER!, carrier: 'aquiline' });
    expect(answer).toMatchObject({ carrier: 'aquiline', source: 'aquiline' });
    expect(answer.attempts[0]).toMatchObject({ source: 'aquiline', kind: 'ok' });
    const { events } = answer.result;
    expect(events.length).toBeGreaterThan(0);
    // Amazon's clocks in UTC, none after the lookup, and the shipper's handover by its day.
    expect(events.every((event) => event.description && (event.time ? Date.parse(event.time) <= Date.now() : event.local_time?.length === 10))).toBe(true);
  });

  it.skipIf(!process.env.AQUILINE_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.AQUILINE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
