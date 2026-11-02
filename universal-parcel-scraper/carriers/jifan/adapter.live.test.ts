import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Jifan live retrieval', () => {
  it.skipIf(!process.env.JIFAN_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.JIFAN_TRACKING_NUMBER!, carrier: 'jifan' });
    expect(answer).toMatchObject({ carrier: 'jifan', source: 'jifan' });
    expect(answer.attempts[0]).toMatchObject({ source: 'jifan', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every row is a wall clock on Beijing time.
    expect(answer.result.events.every((event) => event.description && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.JIFAN_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.JIFAN_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
