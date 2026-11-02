import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Delovye Linii live retrieval', () => {
  it.skipIf(!process.env.DELLIN_TRACKING_NUMBER)('retrieves the milestones of the requested order with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.DELLIN_TRACKING_NUMBER!, carrier: 'dellin' });
    expect(answer).toMatchObject({ carrier: 'dellin', source: 'dellin' });
    expect(answer.attempts[0]).toMatchObject({ source: 'dellin', kind: 'ok' });
    expect(answer.result.current_stage).toBeTruthy();
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every milestone is a calendar day, without a clock or an offset.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.DELLIN_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.DELLIN_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
