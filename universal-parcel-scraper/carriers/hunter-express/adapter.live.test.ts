import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Hunter Express live retrieval', () => {
  it.skipIf(!process.env.HUNTER_EXPRESS_TRACKING_NUMBER)('retrieves the history of the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.HUNTER_EXPRESS_TRACKING_NUMBER!, carrier: 'hunter-express' });
    expect(answer).toMatchObject({ carrier: 'hunter-express', source: 'hunter-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'hunter-express', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Scan rows carry instants from their ticks, and timed rows the zone the page names.
    expect(answer.result.events.every((event) => event.description && typeof event.time === 'string'
      && /(?:Z|[+-]\d{2}:\d{2})$/.test(event.time))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.HUNTER_EXPRESS_UNKNOWN_NUMBER)('reads a number the tracker has no consignment for as inconclusive', async () => {
    await expect(direct().track({ number: process.env.HUNTER_EXPRESS_UNKNOWN_NUMBER! }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  }, 45_000);
});
