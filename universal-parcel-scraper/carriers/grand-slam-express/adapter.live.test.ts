import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Grand Slam Express live retrieval', () => {
  it.skipIf(!process.env.GRAND_SLAM_EXPRESS_TRACKING_NUMBER)('retrieves the history of the requested AWB number with providers disabled', async () => {
    const answer = await createTracker({ providers: [] })
      .track({ number: process.env.GRAND_SLAM_EXPRESS_TRACKING_NUMBER!, carrier: 'grand-slam-express' });
    expect(answer).toMatchObject({ carrier: 'grand-slam-express', source: 'grand-slam-express',
      attempts: [{ source: 'grand-slam-express', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has its wording and a wall clock or a day, never an offset.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.GRAND_SLAM_EXPRESS_UNKNOWN_NUMBER)('reads the lookup’s message for an unknown AWB number as not found', async () => {
    await expect(direct().track({ number: process.env.GRAND_SLAM_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
