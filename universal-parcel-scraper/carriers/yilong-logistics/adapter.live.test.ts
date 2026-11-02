import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Yilong Logistics live retrieval', () => {
  it.skipIf(!process.env.YILONG_LOGISTICS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.YILONG_LOGISTICS_TRACKING_NUMBER!, carrier: 'yilong-logistics' });
    expect(answer).toMatchObject({ carrier: 'yilong-logistics', source: 'yilong-logistics' });
    expect(answer.attempts[0]).toMatchObject({ source: 'yilong-logistics', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Rows read on the tracker's Beijing clock, none still ahead of the lookup.
    expect(answer.result.events.every((event) => event.description && event.time && Date.parse(event.time) <= Date.now())).toBe(true);
  });

  it.skipIf(!process.env.YILONG_LOGISTICS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.YILONG_LOGISTICS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
