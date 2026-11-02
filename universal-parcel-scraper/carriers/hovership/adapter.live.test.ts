import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Hovership live retrieval', () => {
  it.skipIf(!process.env.HOVERSHIP_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.HOVERSHIP_TRACKING_NUMBER!, carrier: 'hovership' });
    expect(answer).toMatchObject({ carrier: 'hovership', source: 'hovership' });
    expect(answer.attempts[0]).toMatchObject({ source: 'hovership', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan names its zone, so each is an instant in that zone's offset.
    expect(answer.result.events.every((event) => event.description && event.provider_code && !event.local_time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:Z|[+-]\d{2}:\d{2})$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.every((event) => event.stage)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.HOVERSHIP_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.HOVERSHIP_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.HOVERSHIP_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.HOVERSHIP_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
