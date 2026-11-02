import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('MeiHoo Pegasus live retrieval', () => {
  it.skipIf(!process.env.MEIHOO_PEGASUS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.MEIHOO_PEGASUS_TRACKING_NUMBER!, carrier: 'meihoo-pegasus' });
    expect(answer).toMatchObject({ carrier: 'meihoo-pegasus', source: 'meihoo-pegasus' });
    expect(answer.attempts[0]).toMatchObject({ source: 'meihoo-pegasus', kind: 'ok' });
    expect(answer.result.current_stage).toBeDefined();
    const { events } = answer.result;
    expect(events.length).toBeGreaterThan(0);
    // Every row on the platform's Beijing clock, none still ahead of the lookup, and no postcode left in a row.
    expect(events.every((event) => event.description && event.time?.endsWith('+08:00') && Date.parse(event.time) <= Date.now())).toBe(true);
    expect(events.some((event) => /\b\d{4,6}\b/.test(`${event.description} ${event.location ?? ''}`))).toBe(false);
  });

  it.skipIf(!process.env.MEIHOO_PEGASUS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.MEIHOO_PEGASUS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
