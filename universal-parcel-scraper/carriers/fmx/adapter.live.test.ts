import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('FMX live retrieval', () => {
  it.skipIf(!process.env.FMX_TRACKING_NUMBER)('retrieves the history of the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.FMX_TRACKING_NUMBER!, carrier: 'fmx' });
    expect(answer).toMatchObject({ carrier: 'fmx', source: 'fmx' });
    expect(answer.attempts[0]).toMatchObject({ source: 'fmx', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has its wording and a wall clock to the second with no zone.
    expect(answer.result.events.every((event) => event.description
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.FMX_TRACKING_NUMBER)('recognizes the requested consignment', async () => {
    await expect(direct().recognize!(process.env.FMX_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.FMX_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.FMX_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
