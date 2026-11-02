import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Quantium Solutions live retrieval', () => {
  it.skipIf(!process.env.QUANTIUM_SOLUTIONS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] })
      .track({ number: process.env.QUANTIUM_SOLUTIONS_TRACKING_NUMBER!, carrier: 'quantium-solutions' });
    expect(answer).toMatchObject({ carrier: 'quantium-solutions', source: 'quantium-solutions' });
    expect(answer.attempts[0]).toMatchObject({ source: 'quantium-solutions', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is a wall clock to the second, with no zone.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.QUANTIUM_SOLUTIONS_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.QUANTIUM_SOLUTIONS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.QUANTIUM_SOLUTIONS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.QUANTIUM_SOLUTIONS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.QUANTIUM_SOLUTIONS_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 45_000);
});
