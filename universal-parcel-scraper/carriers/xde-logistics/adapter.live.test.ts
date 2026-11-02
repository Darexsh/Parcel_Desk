import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('XDE Logistics live retrieval', () => {
  it.skipIf(!process.env.XDE_LOGISTICS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.XDE_LOGISTICS_TRACKING_NUMBER!, carrier: 'xde-logistics' });
    expect(answer).toMatchObject({ carrier: 'xde-logistics', source: 'xde-logistics' });
    expect(answer.attempts[0]).toMatchObject({ source: 'xde-logistics', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is dated on Manila's clock, to the second.
    expect(answer.result.events.every((event) => event.description
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.XDE_LOGISTICS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.XDE_LOGISTICS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
