import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Anousith live retrieval', () => {
  it.skipIf(!process.env.ANOUSITH_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.ANOUSITH_TRACKING_NUMBER!, carrier: 'anousith' });
    expect(answer).toMatchObject({ carrier: 'anousith', source: 'anousith' });
    expect(answer.attempts[0]).toMatchObject({ source: 'anousith', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every event is a UTC instant with its wording and a stage from the carrier's map.
    expect(answer.result.events.every((event) => event.description && !event.local_time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(event.time)) && event.stage_source === 'carrier_map')).toBe(true);
    expect(answer.result.events.some((event) => event.provider_code)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.ANOUSITH_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.ANOUSITH_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.ANOUSITH_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.ANOUSITH_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
