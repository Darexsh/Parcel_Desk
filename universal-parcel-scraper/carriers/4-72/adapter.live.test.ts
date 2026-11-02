import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

describe('4-72 live retrieval', () => {
  it.skipIf(!process.env.FOUR_SEVENTY_TWO_TRACKING_NUMBER)('retrieves dated scans for the requested guía with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.FOUR_SEVENTY_TWO_TRACKING_NUMBER!, carrier: '4-72' });
    expect(answer).toMatchObject({ carrier: '4-72', source: '4-72' });
    expect(answer.attempts[0]).toMatchObject({ source: '4-72', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its operating centre's wall clock, without an offset.
    expect(answer.result.events.every(event => event.description && !event.time && WALL_CLOCK.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.FOUR_SEVENTY_TWO_UNKNOWN_NUMBER)('reads a guía the search does not know as not found', async () => {
    await expect(direct().track({ number: process.env.FOUR_SEVENTY_TWO_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
