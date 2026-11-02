import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('EURODIS live retrieval', () => {
  it.skipIf(!process.env.EURODIS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.EURODIS_TRACKING_NUMBER!, carrier: 'eurodis' });
    expect(answer).toMatchObject({ carrier: 'eurodis', source: 'eurodis' });
    expect(answer.attempts[0]).toMatchObject({ source: 'eurodis', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // A scan is dated in the zone of the country it names, else keeps its wall clock.
    expect(answer.result.events.every((event) => event.description && (event.time
      ? /[+-]\d{2}:\d{2}$/.test(String(event.time)) : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time))))).toBe(true);
  }, 60_000);

  it.skipIf(!process.env.EURODIS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.EURODIS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
