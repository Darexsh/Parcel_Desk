import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Kyungdong Express live retrieval', () => {
  it.skipIf(!process.env.KYOUNGDONG_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.KYOUNGDONG_TRACKING_NUMBER!, carrier: 'kyoungdong' });
    expect(answer).toMatchObject({ carrier: 'kyoungdong', source: 'kyoungdong' });
    expect(answer.attempts[0]).toMatchObject({ source: 'kyoungdong', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is read in Korean time and kept as an instant.
    expect(answer.result.events.every((event) => event.description && !event.local_time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.every((event) => event.provider_code && event.stage)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.KYOUNGDONG_UNKNOWN_NUMBER)('reads an unknown number as inconclusive', async () => {
    await expect(direct().track({ number: process.env.KYOUNGDONG_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  }, 45_000);
});
