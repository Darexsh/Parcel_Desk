import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Central Transport live retrieval', () => {
  it.skipIf(!process.env.CENTRAL_TRANSPORT_TRACKING_NUMBER)('retrieves the requested PRO number with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.CENTRAL_TRANSPORT_TRACKING_NUMBER!, carrier: 'central-transport' });
    expect(answer).toMatchObject({ carrier: 'central-transport', source: 'central-transport' });
    expect(answer.attempts[0]).toMatchObject({ source: 'central-transport', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its terminal's wall clock, without an offset.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.CENTRAL_TRANSPORT_UNKNOWN_NUMBER)('reads an unknown PRO number as inconclusive', async () => {
    await expect(direct().track({ number: process.env.CENTRAL_TRANSPORT_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'indeterminate' });
  });
});
