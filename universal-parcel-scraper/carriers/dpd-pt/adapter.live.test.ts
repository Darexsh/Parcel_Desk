import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const NUMBER = process.env.DPD_PT_TRACKING_NUMBER;
const UNKNOWN = process.env.DPD_PT_UNKNOWN_NUMBER;
const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/;

describe('DPD Portugal live retrieval', () => {
  it.skipIf(!NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [], trawlUrl: process.env.FLARESOLVERR_URL }).track({ number: NUMBER!, carrier: 'dpd-pt' });
    expect(answer).toMatchObject({ carrier: 'dpd-pt', source: 'dpd-pt' });
    expect(answer.attempts[0]).toMatchObject({ source: 'dpd-pt', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps the page's wall clock and its code; an instant is one the lookup deduced.
    expect(answer.result.events.every(event => event.description && event.provider_code
      && WALL_CLOCK.test(String(event.local_time)) && (!event.time || event.time_zone_basis))).toBe(true);
    await expect(direct().recognize!(NUMBER!)).resolves.toMatchObject({ known: true });
  }, 60_000);

  it.skipIf(!UNKNOWN)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: UNKNOWN! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(UNKNOWN!)).resolves.toEqual({ known: false });
  }, 30_000);
});
