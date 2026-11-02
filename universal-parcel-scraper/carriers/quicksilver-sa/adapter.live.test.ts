import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Quicksilver live retrieval', () => {
  it.skipIf(!process.env.QUICKSILVER_SA_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.QUICKSILVER_SA_TRACKING_NUMBER!, carrier: 'quicksilver-sa' });
    expect(answer).toMatchObject({ carrier: 'quicksilver-sa', source: 'quicksilver-sa' });
    expect(answer.attempts[0]).toMatchObject({ source: 'quicksilver-sa', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every status keeps the service's wall clock to the second, without an offset, and its name.
    expect(answer.result.events.every((event) => event.description && event.provider_code && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.QUICKSILVER_SA_UNKNOWN_NUMBER)('reads a number the service does not know as not found', async () => {
    await expect(direct().track({ number: process.env.QUICKSILVER_SA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
