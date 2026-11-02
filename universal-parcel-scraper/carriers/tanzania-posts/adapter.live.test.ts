import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A scan on Dar es Salaam's clock, or a wall clock, to the second.
const CLOCK = (event: { time?: unknown; local_time?: unknown }) => typeof event.time === 'string'
  ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+03:00$/.test(event.time) : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time));

describe('Tanzania Posts Corporation live retrieval', () => {
  it.skipIf(!process.env.TANZANIA_POSTS_TRACKING_NUMBER)('retrieves the requested item’s scans with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.TANZANIA_POSTS_TRACKING_NUMBER!, carrier: 'tanzania-posts' });
    expect(answer).toMatchObject({ carrier: 'tanzania-posts', source: 'tanzania-posts' });
    expect(answer.attempts[0]).toMatchObject({ source: 'tanzania-posts', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && CLOCK(event))).toBe(true);
  }, 60_000);

  it.skipIf(!process.env.TANZANIA_POSTS_UNKNOWN_NUMBER)('reads a code the tracker does not hold as not found', async () => {
    await expect(direct().track({ number: process.env.TANZANIA_POSTS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
