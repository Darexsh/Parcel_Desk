import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Hitch live retrieval', () => {
  it.skipIf(!process.env.HITCH_TRACKING_NUMBER)('retrieves the timeline of the requested booking with providers disabled', async () => {
    const answer = await createTracker({ providers: [], trawlUrl: process.env.FLARESOLVERR_URL }).track({ number: process.env.HITCH_TRACKING_NUMBER!, carrier: 'hitch' });
    expect(answer).toMatchObject({ carrier: 'hitch', source: 'hitch' });
    expect(answer.attempts[0]).toMatchObject({ source: 'hitch', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every step has its name and a wall clock to the minute with no zone.
    expect(answer.result.events.every((event) => event.description && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time))))
      .toBe(true);
  }, 75_000);

  it.skipIf(!process.env.HITCH_TRACKING_NUMBER)('recognizes the requested booking', async () => {
    await expect(direct().recognize!(process.env.HITCH_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.HITCH_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.HITCH_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
