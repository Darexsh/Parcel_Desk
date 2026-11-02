import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

// Celeritas's site answers bursts with HTTP 429 and a challenge: run these alone, a few at a time.
describe('Celeritas live retrieval', () => {
  it.skipIf(!process.env.CELERITAS_TRACKING_NUMBER)('retrieves dated history for the requested reference with providers disabled', async () => {
    const number = process.env.CELERITAS_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [], trawlUrl: process.env.FLARESOLVERR_URL }).track({ number, carrier: 'celeritas' });
    expect(answer).toMatchObject({ carrier: 'celeritas', source: 'celeritas', attempts: [{ source: 'celeritas', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.local_time && event.description && event.location === undefined)).toBe(true);
    expect(answer.result.pickup_point).toBeUndefined();
    expect(answer.result.sender_name).toBeUndefined();
  }, 75_000);

  it.skipIf(!process.env.CELERITAS_UNKNOWN_NUMBER)('reads the tracker’s notice for an unknown reference as not found', async () => {
    await expect(direct().track({ number: process.env.CELERITAS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
