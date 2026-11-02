import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('OSM Worldwide live retrieval', () => {
  it.skipIf(!process.env.OSM_WORLDWIDE_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const number = process.env.OSM_WORLDWIDE_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'osm-worldwide' });
    expect(answer).toMatchObject({ carrier: 'osm-worldwide', source: 'osm-worldwide' });
    expect(answer.attempts[0]).toMatchObject({ source: 'osm-worldwide', kind: 'ok' });
    expect(answer.result.current_stage).toBeDefined();
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Wall clocks only: OSM Worldwide gives its scans no offset.
    expect(answer.result.events.every(event => event.local_time && event.time === undefined && event.description)).toBe(true);
  });

  it.skipIf(!process.env.OSM_WORLDWIDE_UNKNOWN_NUMBER)('reads the service’s not-found for an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.OSM_WORLDWIDE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.OSM_WORLDWIDE_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
