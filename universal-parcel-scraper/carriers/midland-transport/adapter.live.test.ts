import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Midland Transport live retrieval', () => {
  it.skipIf(!process.env.MIDLAND_TRANSPORT_TRACKING_NUMBER)('reads the requested number’s history with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.MIDLAND_TRANSPORT_TRACKING_NUMBER!, carrier: 'midland-transport' });
    expect(answer).toMatchObject({ carrier: 'midland-transport', source: 'midland-transport' });
    expect(answer.attempts[0]).toMatchObject({ source: 'midland-transport', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has its wall clock without an offset and a wording; scans after the creation name the platform's Activity.
    for (const event of answer.result.events) {
      expect(event).toMatchObject({ local_time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/),
        provider_code: expect.any(String), description: expect.any(String) });
    }
  }, 45_000);

  it.skipIf(!process.env.MIDLAND_TRANSPORT_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.MIDLAND_TRANSPORT_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
