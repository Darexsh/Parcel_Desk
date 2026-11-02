import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('2GO Express live retrieval', () => {
  it.skipIf(!process.env.TWOGO_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.TWOGO_TRACKING_NUMBER!, carrier: '2go' });
    expect(answer).toMatchObject({ carrier: '2go', source: '2go' });
    expect(answer.attempts[0]).toMatchObject({ source: '2go', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // The tracker gives wall clocks without a zone, and each scan a sentence the map reads.
    expect(answer.result.events.every((event) => event.description && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.events.some((event) => event.stage_source === 'carrier_map')).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.TWOGO_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.TWOGO_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
