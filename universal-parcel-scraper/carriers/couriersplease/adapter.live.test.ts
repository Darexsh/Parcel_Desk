import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('CouriersPlease live retrieval', () => {
  it.skipIf(!process.env.COURIERSPLEASE_TRACKING_NUMBER)('retrieves the history of the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.COURIERSPLEASE_TRACKING_NUMBER!, carrier: 'couriersplease' });
    expect(answer).toMatchObject({ carrier: 'couriersplease', source: 'couriersplease' });
    expect(answer.attempts[0]).toMatchObject({ source: 'couriersplease', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // The tracker gives wall clocks only; they stay local.
    expect(answer.result.events.every((event) => event.description && event.time === undefined
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.events.some((event) => /^(?:ACT|NSW|NT|QLD|SA|TAS|VIC|WA)$/.test(String(event.location)))).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.COURIERSPLEASE_TRACKING_NUMBER)('recognizes the requested consignment', async () => {
    await expect(direct().recognize!(process.env.COURIERSPLEASE_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.COURIERSPLEASE_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.COURIERSPLEASE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
