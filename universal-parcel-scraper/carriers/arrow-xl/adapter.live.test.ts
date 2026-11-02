import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const postcode = process.env.ARROW_XL_POSTCODE;
const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('ArrowXL live retrieval', () => {
  it.skipIf(!process.env.ARROW_XL_TRACKING_NUMBER || !postcode)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.ARROW_XL_TRACKING_NUMBER!, carrier: 'arrow-xl', postcode });
    expect(answer).toMatchObject({ carrier: 'arrow-xl', source: 'arrow-xl' });
    expect(answer.attempts[0]).toMatchObject({ source: 'arrow-xl', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every row keeps the depot's wall clock, without an offset.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.ARROW_XL_UNKNOWN_NUMBER || !postcode)('reads an unknown reference as inconclusive, as a wrong postcode is', async () => {
    await expect(direct().track({ number: process.env.ARROW_XL_UNKNOWN_NUMBER!, postcode }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  }, 30_000);
});
