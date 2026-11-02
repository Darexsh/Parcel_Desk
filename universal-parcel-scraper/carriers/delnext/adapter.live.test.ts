import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const NUMBER = process.env.DELNEXT_TRACKING_NUMBER;
const UNKNOWN = process.env.DELNEXT_UNKNOWN_NUMBER;
const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/;

describe('Delnext live retrieval', () => {
  it.skipIf(!NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [], trawlUrl: process.env.FLARESOLVERR_URL }).track({ number: NUMBER!, carrier: 'delnext' });
    expect(answer).toMatchObject({ carrier: 'delnext', source: 'delnext' });
    expect(answer.attempts[0]).toMatchObject({ source: 'delnext', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps the page's wall clock, without an offset.
    expect(answer.result.events.every(event => event.description && !event.time && WALL_CLOCK.test(String(event.local_time)))).toBe(true);
    await expect(direct().recognize!(NUMBER!)).resolves.toMatchObject({ known: true });
  }, 75_000);

  it.skipIf(!UNKNOWN)('reads an unknown code as not found', async () => {
    await expect(direct().track({ number: UNKNOWN! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(UNKNOWN!)).resolves.toEqual({ known: false });
  }, 30_000);
});
