import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Meso-global live retrieval', () => {
  it.skipIf(!process.env.MESO_GLOBAL_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.MESO_GLOBAL_TRACKING_NUMBER!, carrier: 'meso-global' });
    expect(answer).toMatchObject({ carrier: 'meso-global', source: 'meso-global' });
    expect(answer.attempts[0]).toMatchObject({ source: 'meso-global', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Rows read on the tracker's Beijing clock, none still ahead of the lookup.
    expect(answer.result.events.every((event) => event.description && event.time && Date.parse(event.time) <= Date.now())).toBe(true);
  });

  it.skipIf(!process.env.MESO_GLOBAL_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.MESO_GLOBAL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
