import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Mayi Yinfu live retrieval', () => {
  it.skipIf(!process.env.MAYIYINFU_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.MAYIYINFU_TRACKING_NUMBER!, carrier: 'mayiyinfu' });
    expect(answer).toMatchObject({ carrier: 'mayiyinfu', source: 'mayiyinfu' });
    expect(answer.attempts[0]).toMatchObject({ source: 'mayiyinfu', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // None still ahead on the tracker's own clock. DHL's rows with a country and the rows in China
    // are on Beijing time, and the newest row's instant, when it has one, is the last update.
    const now = DateTime.now().setZone('Asia/Shanghai').toFormat("yyyy-MM-dd'T'HH:mm:ss");
    expect(answer.result.events.every((event) => event.description
      && (event.time ? Date.parse(event.time) <= Date.now() : event.local_time! <= now))).toBe(true);
    expect(answer.result.last_update).toBe(answer.result.events[0]!.time ?? null);
    // A hand-over to the airport is never a delivery.
    const airport = answer.result.events.filter((event) => event.description!.startsWith('货物已交机场'));
    expect(airport.every((event) => event.stage === 'in_transit')).toBe(true);
  });

  it.skipIf(!process.env.MAYIYINFU_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.MAYIYINFU_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
