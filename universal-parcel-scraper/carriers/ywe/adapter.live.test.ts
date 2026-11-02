import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('YWE live retrieval', () => {
  it.skipIf(!process.env.YWE_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.YWE_TRACKING_NUMBER!, carrier: 'ywe' });
    expect(answer).toMatchObject({ carrier: 'ywe', source: 'ywe' });
    expect(answer.attempts[0]).toMatchObject({ source: 'ywe', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.YWE_UNKNOWN_NUMBER)('reads a number the tracker has nothing for as no history', async () => {
    await expect(direct().track({ number: process.env.YWE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'indeterminate', name: 'NoHistoryError' });
  }, 30_000);
});
