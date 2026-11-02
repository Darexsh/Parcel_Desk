import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Speedaf live retrieval', () => {
  it.skipIf(!process.env.SPEEDAF_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SPEEDAF_TRACKING_NUMBER!, carrier: 'speedaf' });
    expect(answer).toMatchObject({ carrier: 'speedaf', source: 'speedaf' });
    expect(answer.attempts[0]).toMatchObject({ source: 'speedaf', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan read at its offset, none ahead of the read.
    expect(answer.result.events.every((event) => event.description && event.time && Date.parse(event.time) <= Date.now())).toBe(true);
    expect(answer.result.events.every((event) => event.provider_code)).toBe(true);
  });

  it.skipIf(!process.env.SPEEDAF_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.SPEEDAF_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.SPEEDAF_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.SPEEDAF_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
