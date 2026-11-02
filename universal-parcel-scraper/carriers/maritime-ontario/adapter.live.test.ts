import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Maritime-Ontario live retrieval', () => {
  it.skipIf(!process.env.MARITIME_ONTARIO_TRACKING_NUMBER)('reads the requested freight bill’s status history with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.MARITIME_ONTARIO_TRACKING_NUMBER!, carrier: 'maritime-ontario' });
    expect(answer).toMatchObject({ carrier: 'maritime-ontario', source: 'maritime-ontario' });
    expect(answer.attempts[0]).toMatchObject({ source: 'maritime-ontario', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every status has its code, its description and its wall clock without an offset.
    for (const event of answer.result.events) {
      expect(event).toMatchObject({ local_time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/),
        provider_code: expect.stringMatching(/^[A-Z0-9-]+$/), description: expect.any(String) });
      expect(event.time).toBeUndefined();
    }
  }, 45_000);

  it.skipIf(!process.env.MARITIME_ONTARIO_UNKNOWN_NUMBER)('reads an unknown freight bill as not found', async () => {
    await expect(direct().track({ number: process.env.MARITIME_ONTARIO_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
