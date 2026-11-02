import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('American West live retrieval', () => {
  it.skipIf(!process.env.AMERICAN_WEST_EXPRESS_TRACKING_NUMBER)('retrieves the milestones of the requested pro number with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.AMERICAN_WEST_EXPRESS_TRACKING_NUMBER!, carrier: 'american-west-express' });
    expect(answer).toMatchObject({ carrier: 'american-west-express', source: 'american-west-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'american-west-express', kind: 'ok' });
    expect(answer.result).toMatchObject({ last_update: null });
    expect(answer.result.current_stage).toBeTruthy();
    // Every milestone is a day the page shows, never a clock with an invented offset.
    expect(answer.result.events.every((event) => event.description && event.provider_code && event.time === undefined
      && /^\d{4}-\d{2}-\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.receiver_name ?? null).toBeNull();
    expect(answer.result.sender_name ?? null).toBeNull();
  }, 45_000);

  it.skipIf(!process.env.AMERICAN_WEST_EXPRESS_UNKNOWN_NUMBER)('reads a pro number the tracker finds nothing under as inconclusive', async () => {
    await expect(direct().track({ number: process.env.AMERICAN_WEST_EXPRESS_UNKNOWN_NUMBER! }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  }, 45_000);
});
