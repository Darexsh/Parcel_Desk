import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Shouwu International live retrieval', () => {
  it.skipIf(!process.env.SHOUWU_TRACKING_NUMBER)('retrieves the history of the requested waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SHOUWU_TRACKING_NUMBER!, carrier: 'shouwu' });
    expect(answer).toMatchObject({ carrier: 'shouwu', source: 'shouwu' });
    expect(answer.attempts[0]).toMatchObject({ source: 'shouwu', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has wording and the wall clock its epoch shows in Beijing, dated on a zone.
    expect(answer.result.events.every((event) => event.description && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))
      && /(?:Z|[+-]\d{2}:\d{2})$/.test(String(event.time)) && event.time_zone)).toBe(true);
    expect(answer.result.last_update).toBe(answer.result.events[0]!.time);
  }, 45_000);

  it.skipIf(!process.env.SHOUWU_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    await expect(direct().track({ number: process.env.SHOUWU_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
