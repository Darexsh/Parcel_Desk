import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('FedEx International Connect live retrieval', () => {
  it.skipIf(!process.env.FEDEX_INTERNATIONAL_CONNECT_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.FEDEX_INTERNATIONAL_CONNECT_TRACKING_NUMBER!, carrier: 'fedex-international-connect' });
    expect(answer).toMatchObject({ carrier: 'fedex-international-connect', source: 'fedex-international-connect' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && event.local_time)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.FEDEX_INTERNATIONAL_CONNECT_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.FEDEX_INTERNATIONAL_CONNECT_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
