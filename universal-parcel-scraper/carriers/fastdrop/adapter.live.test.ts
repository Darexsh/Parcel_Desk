import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

// MotionTools answers a few quick lookups from one address with HTTP 429, so
// each test makes a single request.
describe('Fastdrop live retrieval', () => {
  it.skipIf(!process.env.FASTDROP_TRACKING_NUMBER)('retrieves the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.FASTDROP_TRACKING_NUMBER!, carrier: 'fastdrop' });
    expect(answer).toMatchObject({ carrier: 'fastdrop', source: 'fastdrop' });
    expect(answer.attempts[0]).toMatchObject({ source: 'fastdrop', kind: 'ok' });
    expect(answer.result.current_stage).toBeTruthy();
    // Every resolved stop keeps its clock with the offset the reply gives it.
    expect(answer.result.events.every((event) => event.description && (event.time || event.local_time))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.FASTDROP_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().recognize!(process.env.FASTDROP_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
