import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Northline live retrieval', () => {
  it.skipIf(!process.env.NORTHLINE_TRACKING_NUMBER)('retrieves the history of the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.NORTHLINE_TRACKING_NUMBER!, carrier: 'northline' });
    expect(answer).toMatchObject({ carrier: 'northline', source: 'northline' });
    expect(answer.attempts[0]).toMatchObject({ source: 'northline', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every milestone has a value and wording, and an offset from its branch's zone or its wall clock.
    expect(answer.result.events.every((event) => event.description && event.provider_code
      && (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(String(event.time))
        || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.NORTHLINE_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.NORTHLINE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
