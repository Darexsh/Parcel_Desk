import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Last One Mile Co-op live retrieval', () => {
  it.skipIf(!process.env.LAST_ONE_MILE_COOP_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] })
      .track({ number: process.env.LAST_ONE_MILE_COOP_TRACKING_NUMBER!, carrier: 'last-one-mile-coop' });
    expect(answer).toMatchObject({ carrier: 'last-one-mile-coop', source: 'last-one-mile-coop' });
    expect(answer.attempts[0]).toMatchObject({ source: 'last-one-mile-coop', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every row is a second in Japan's zone.
    expect(answer.result.events.every((event) => event.description
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.every((event) => event.stage)).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.LAST_ONE_MILE_COOP_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.LAST_ONE_MILE_COOP_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.LAST_ONE_MILE_COOP_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.LAST_ONE_MILE_COOP_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
