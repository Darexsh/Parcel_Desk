import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Lightning Express live retrieval', () => {
  it.skipIf(!process.env.LIGHTNING_EXPRESS_TRACKING_NUMBER)('retrieves the milestones of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.LIGHTNING_EXPRESS_TRACKING_NUMBER!, carrier: 'lightning-express' });
    expect(answer).toMatchObject({ carrier: 'lightning-express', source: 'lightning-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'lightning-express', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps the depot's wall clock to the second, without an offset, and its status code.
    expect(answer.result.events.every((event) => event.description && event.provider_code && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.LIGHTNING_EXPRESS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.LIGHTNING_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
