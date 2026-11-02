import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Komon Express live retrieval', () => {
  it.skipIf(!process.env.KOMON_EXPRESS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.KOMON_EXPRESS_TRACKING_NUMBER!, carrier: 'komon-express' });
    expect(answer).toMatchObject({ carrier: 'komon-express', source: 'komon-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'komon-express', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Komon's scans keep their wall clocks, and none repeats its place.
    expect(answer.result.events.every((event) => event.description && !/->/.test(event.description)
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.KOMON_EXPRESS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.KOMON_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
