import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Stone3PL live retrieval', () => {
  it.skipIf(!process.env.STONE3PL_TRACKING_NUMBER)('retrieves the requested parcel without universal providers', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.STONE3PL_TRACKING_NUMBER!, carrier: 'stone3pl' });
    expect(answer).toMatchObject({ carrier: 'stone3pl', source: 'stone3pl' });
    expect(answer.attempts[0]).toMatchObject({ source: 'stone3pl', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // The feed states no offset; any instant here is one the tracker deduced.
    expect(answer.result.events.every(event => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))
      && (!event.time || event.time_zone_basis) && event.description)).toBe(true);
    await expect(direct().recognize!(process.env.STONE3PL_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.STONE3PL_UNKNOWN_NUMBER)('distinguishes the portal\'s no-information result', async () => {
    await expect(direct().track({ number: process.env.STONE3PL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.STONE3PL_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});
