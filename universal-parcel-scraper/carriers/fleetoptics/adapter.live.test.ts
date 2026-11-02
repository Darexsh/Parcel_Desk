import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
const WALL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

describe('FleetOptics live retrieval', () => {
  it.skipIf(!process.env.FLEETOPTICS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [], trawlUrl: process.env.FLARESOLVERR_URL }).track({ number: process.env.FLEETOPTICS_TRACKING_NUMBER!, carrier: 'fleetoptics' });
    expect(answer).toMatchObject({ carrier: 'fleetoptics', source: 'fleetoptics' });
    expect(answer.attempts[0]).toMatchObject({ source: 'fleetoptics', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // An Eastern clock is an instant; another zone's stays the wall clock the page shows.
    expect(answer.result.events.every((event) => event.description
      && (event.time ? INSTANT.test(String(event.time)) && !event.local_time : WALL.test(String(event.local_time))))).toBe(true);
    expect(answer.result.events.some((event) => event.stage)).toBe(true);
  }, 60_000);

  it.skipIf(!process.env.FLEETOPTICS_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.FLEETOPTICS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.FLEETOPTICS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.FLEETOPTICS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.FLEETOPTICS_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
