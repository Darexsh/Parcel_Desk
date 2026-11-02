import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('AyMakan live retrieval', () => {
  it.skipIf(!process.env.AYMAKAN_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.AYMAKAN_TRACKING_NUMBER!, carrier: 'aymakan' });
    expect(answer).toMatchObject({ carrier: 'aymakan', source: 'aymakan' });
    expect(answer.attempts[0]).toMatchObject({ source: 'aymakan', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is dated to the day, without a clock or an offset.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.current_stage).toBeTruthy();
  }, 75_000);

  it.skipIf(!process.env.AYMAKAN_TRACKING_NUMBER)('recognizes the requested shipment', async () => {
    await expect(direct().recognize!(process.env.AYMAKAN_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.AYMAKAN_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.AYMAKAN_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
