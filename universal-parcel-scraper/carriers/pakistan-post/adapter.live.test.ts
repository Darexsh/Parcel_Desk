import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/;

describe('Pakistan Post live retrieval', () => {
  it.skipIf(!process.env.PAKISTAN_POST_TRACKING_NUMBER)('retrieves dated scans for the requested item with providers disabled', async () => {
    const number = process.env.PAKISTAN_POST_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'pakistan-post' });
    expect(answer).toMatchObject({ carrier: 'pakistan-post', source: 'pakistan-post' });
    // An item sent abroad can go on to the destination's post.
    expect(answer.attempts[0]).toMatchObject({ source: 'pakistan-post', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.description && WALL_CLOCK.test(String(event.local_time)))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.PAKISTAN_POST_DOMESTIC_NUMBER)('retrieves the scans of a domestic article', async () => {
    const result = await direct().track({ number: process.env.PAKISTAN_POST_DOMESTIC_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => WALL_CLOCK.test(String(event.local_time)))).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.PAKISTAN_POST_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.PAKISTAN_POST_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.PAKISTAN_POST_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});
