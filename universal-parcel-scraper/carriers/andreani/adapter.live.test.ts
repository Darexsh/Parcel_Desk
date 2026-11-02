import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Andreani live retrieval', () => {
  it.skipIf(!process.env.ANDREANI_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.ANDREANI_TRACKING_NUMBER!, carrier: 'andreani' });
    expect(answer).toMatchObject({ carrier: 'andreani', source: 'andreani' });
    expect(answer.attempts[0]).toMatchObject({ source: 'andreani', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan carries Argentina's time and a stage from the carrier's map.
    expect(answer.result.events.every((event) => event.description && /-03:00$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.every((event) => event.stage_source === 'carrier_map')).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.ANDREANI_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.ANDREANI_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.ANDREANI_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.ANDREANI_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
