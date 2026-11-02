import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('MRL Global live retrieval', () => {
  it.skipIf(!process.env.MRL_GLOBAL_TRACKING_NUMBER)('reads the requested consignment’s history with providers disabled', async () => {
    const answer = await createTracker({ providers: [], trawlUrl: process.env.FLARESOLVERR_URL }).track({ number: process.env.MRL_GLOBAL_TRACKING_NUMBER!, carrier: 'mrl-global' });
    expect(answer).toMatchObject({ carrier: 'mrl-global', source: 'mrl-global' });
    expect(answer.attempts[0]).toMatchObject({ source: 'mrl-global', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its wall clock to the minute, without an offset, and its label without who signed.
    for (const event of answer.result.events) {
      expect(event).toMatchObject({ local_time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/), description: expect.any(String) });
      expect(event.time).toBeUndefined();
    }
    expect(answer.result.events.some((event) => event.stage)).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.MRL_GLOBAL_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.MRL_GLOBAL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
