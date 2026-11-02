import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Sailpost live retrieval', () => {
  it.skipIf(!process.env.SAILPOST_TRACKING_NUMBER)('retrieves the history of the requested item with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SAILPOST_TRACKING_NUMBER!, carrier: 'sailpost' });
    expect(answer).toMatchObject({ carrier: 'sailpost', source: 'sailpost' });
    expect(answer.attempts[0]).toMatchObject({ source: 'sailpost', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // A scan has Rome's instant with its offset, or the day alone when the service dates it by day.
    expect(answer.result.events.every((event) => event.description && event.provider_code
      && (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[12]:00$/.test(String(event.time)) || /^\d{4}-\d{2}-\d{2}$/.test(String(event.local_time))))).toBe(true);
    expect(answer.result.events.some((event) => event.time)).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.SAILPOST_UNKNOWN_NUMBER)('reads an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.SAILPOST_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
