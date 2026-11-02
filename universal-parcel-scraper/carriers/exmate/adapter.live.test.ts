import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Exmate live retrieval', () => {
  it.skipIf(!process.env.EXMATE_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.EXMATE_TRACKING_NUMBER!, carrier: 'exmate' });
    expect(answer).toMatchObject({ carrier: 'exmate', source: 'exmate' });
    expect(answer.attempts[0]).toMatchObject({ source: 'exmate', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Scans in Korea and Japan read in their shared offset, each with Exmate's own status.
    expect(answer.result.events.every((event) => event.description && event.provider_code
      && /T\d{2}:\d{2}:00\+09:00$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.some((event) => event.provider_code === '등록')).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.EXMATE_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.EXMATE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
