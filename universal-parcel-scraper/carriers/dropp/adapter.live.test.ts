import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Dropp live retrieval', () => {
  it.skipIf(!process.env.DROPP_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.DROPP_TRACKING_NUMBER!, carrier: 'dropp' });
    expect(answer).toMatchObject({ carrier: 'dropp', source: 'dropp' });
    expect(answer.attempts[0]).toMatchObject({ source: 'dropp', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every step keeps its wall clock to the minute, without an offset, and its code.
    expect(answer.result.events.every((event) => event.description && event.provider_code && event.stage && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.DROPP_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.DROPP_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.DROPP_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.DROPP_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
