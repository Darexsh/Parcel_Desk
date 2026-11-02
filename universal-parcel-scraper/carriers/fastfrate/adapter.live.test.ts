import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Fastfrate live retrieval', () => {
  it.skipIf(!process.env.FASTFRATE_TRACKING_NUMBER)('retrieves dated history for the requested probill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.FASTFRATE_TRACKING_NUMBER!, carrier: 'fastfrate' });
    expect(answer).toMatchObject({ carrier: 'fastfrate', source: 'fastfrate', attempts: [{ source: 'fastfrate', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its wall clock, without an offset.
    expect(answer.result.events.every(event => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.events.some(event => event.stage && event.location)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.FASTFRATE_UNKNOWN_NUMBER)('reads an unknown probill as not found', async () => {
    await expect(direct().track({ number: process.env.FASTFRATE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
