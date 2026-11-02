import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Zajil live retrieval', () => {
  it.skipIf(!process.env.ZAJIL_TRACKING_NUMBER)('retrieves the current status of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.ZAJIL_TRACKING_NUMBER!, carrier: 'zajil' });
    expect(answer).toMatchObject({ carrier: 'zajil', source: 'zajil' });
    expect(answer.attempts[0]).toMatchObject({ source: 'zajil', kind: 'ok' });
    expect(answer.result.current_stage).toBeTruthy();
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every status keeps its wall clock, its update and its wording.
    expect(answer.result.events.every((event) => event.description && event.provider_code && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.ZAJIL_UNKNOWN_NUMBER)('reads an unknown number as not found or inconclusive, never as a shipment', async () => {
    await expect(direct().track({ number: process.env.ZAJIL_UNKNOWN_NUMBER! })).rejects.toMatchObject({
      kind: expect.stringMatching(/^(?:not_found|indeterminate)$/),
    });
  });
});
