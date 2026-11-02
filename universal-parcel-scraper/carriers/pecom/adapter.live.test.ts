import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('PEC live retrieval', () => {
  it.skipIf(!process.env.PECOM_TRACKING_NUMBER)('retrieves the history of the requested cargo with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.PECOM_TRACKING_NUMBER!, carrier: 'pecom' });
    expect(answer).toMatchObject({ carrier: 'pecom', source: 'pecom' });
    expect(answer.attempts[0]).toMatchObject({ source: 'pecom', kind: 'ok' });
    expect(answer.result.current_stage).toBeTruthy();
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every status keeps its wall clock, without an offset.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.PECOM_UNKNOWN_NUMBER)('reads an unknown cargo code as not found', async () => {
    await expect(direct().track({ number: process.env.PECOM_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
