import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const NUMBER = process.env.TECHLINK_TRACKING_NUMBER;
const UNKNOWN = process.env.TECHLINK_UNKNOWN_NUMBER;
const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Techlink live retrieval', () => {
  it.skipIf(!NUMBER)('retrieves the scans of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER!, carrier: 'techlink' });
    expect(answer).toMatchObject({ carrier: 'techlink', source: 'techlink' });
    expect(answer.attempts[0]).toMatchObject({ source: 'techlink', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && event.provider_code && (event.time || event.local_time))).toBe(true);
  }, 60_000);

  it.skipIf(!UNKNOWN)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: UNKNOWN! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
