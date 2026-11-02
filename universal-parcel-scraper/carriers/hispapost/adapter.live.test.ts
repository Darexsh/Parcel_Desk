import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Hispapost live retrieval', () => {
  it.skipIf(!process.env.HISPAPOST_TRACKING_NUMBER)('reads the current status of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.HISPAPOST_TRACKING_NUMBER!, carrier: 'hispapost' });
    expect(answer).toMatchObject({ carrier: 'hispapost', source: 'hispapost', result: { summary_only: true } });
    expect(answer.attempts[0]).toMatchObject({ source: 'hispapost', kind: 'ok' });
    expect(answer.result.events).toHaveLength(1);
    // The status's clock reads as Madrid time.
    expect(answer.result.events[0]).toMatchObject({ description: expect.any(String), time: expect.stringMatching(/\+0[12]:00$/) });
  }, 45_000);

  it.skipIf(!process.env.HISPAPOST_UNKNOWN_NUMBER)('reads an unknown barcode as not found', async () => {
    await expect(direct().track({ number: process.env.HISPAPOST_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
