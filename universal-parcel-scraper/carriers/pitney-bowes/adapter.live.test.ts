import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Pitney Bowes live retrieval', () => {
  it.skipIf(!process.env.PITNEY_BOWES_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.PITNEY_BOWES_TRACKING_NUMBER!, carrier: 'pitney-bowes' });
    expect(answer).toMatchObject({ carrier: 'pitney-bowes', source: 'pitney-bowes' });
    expect(answer.attempts[0]).toMatchObject({ source: 'pitney-bowes', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its wall clock, without an offset.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.service_name).toBeTruthy();
  }, 45_000);

  it.skipIf(!process.env.PITNEY_BOWES_UNKNOWN_NUMBER)('reads an unknown number as inconclusive, as the page does', async () => {
    await expect(direct().track({ number: process.env.PITNEY_BOWES_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'indeterminate' });
  });
});
