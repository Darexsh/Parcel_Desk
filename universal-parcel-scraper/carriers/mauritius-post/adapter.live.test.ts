import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Mauritius Post live retrieval', () => {
  it.skipIf(!process.env.MAURITIUS_POST_TRACKING_NUMBER)('retrieves the history of the requested item with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.MAURITIUS_POST_TRACKING_NUMBER!, carrier: 'mauritius-post' });
    expect(answer).toMatchObject({ carrier: 'mauritius-post', source: 'mauritius-post' });
    expect(answer.attempts[0]).toMatchObject({ source: 'mauritius-post', kind: 'ok' });
    expect(answer.result.current_stage).toBeTruthy();
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps the page's wall clock, without an offset.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.MAURITIUS_POST_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.MAURITIUS_POST_UNKNOWN_NUMBER! }, { budgetMs: 60_000 })).rejects.toMatchObject({ kind: 'not_found' });
  }, 75_000);
});
