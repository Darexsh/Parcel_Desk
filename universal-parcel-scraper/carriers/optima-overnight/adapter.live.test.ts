import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Optima Overnight live retrieval', () => {
  it.skipIf(!process.env.OPTIMA_OVERNIGHT_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.OPTIMA_OVERNIGHT_TRACKING_NUMBER!, carrier: 'optima-overnight' });
    expect(answer).toMatchObject({ carrier: 'optima-overnight', source: 'optima-overnight' });
    expect(answer.attempts[0]).toMatchObject({ source: 'optima-overnight', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every status has its wording and a wall clock with no zone.
    expect(answer.result.events.every((event) => event.description && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))))
      .toBe(true);
  }, 45_000);

  it.skipIf(!process.env.OPTIMA_OVERNIGHT_TRACKING_NUMBER)('recognizes the requested shipment', async () => {
    await expect(direct().recognize!(process.env.OPTIMA_OVERNIGHT_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.OPTIMA_OVERNIGHT_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.OPTIMA_OVERNIGHT_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
