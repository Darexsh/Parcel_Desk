import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('bestfulfill live retrieval', () => {
  it.skipIf(!process.env.BESTFULFILL_TRACKING_NUMBER)('reads the requested parcel\'s scans with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.BESTFULFILL_TRACKING_NUMBER!, carrier: 'bestfulfill' });
    expect(answer).toMatchObject({ carrier: 'bestfulfill', source: 'bestfulfill' });
    expect(answer.attempts[0]).toMatchObject({ source: 'bestfulfill', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    for (const event of answer.result.events) expect(event.time).toMatch(/(?:Z|[+-]\d{2}:\d{2})$/);
  }, 45_000);

  it.skipIf(!process.env.BESTFULFILL_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.BESTFULFILL_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.BESTFULFILL_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.BESTFULFILL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
