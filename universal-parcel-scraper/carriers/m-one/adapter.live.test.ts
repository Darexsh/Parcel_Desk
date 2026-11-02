import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('M-ONE live retrieval', () => {
  it.skipIf(!process.env.M_ONE_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.M_ONE_TRACKING_NUMBER!, carrier: 'm-one' });
    expect(answer).toMatchObject({ carrier: 'm-one', source: 'm-one' });
    expect(answer.attempts[0]).toMatchObject({ source: 'm-one', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps M-ONE's wall clock, without an offset, and its code.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)) && /^ST\d+$/.test(String(event.provider_code)))).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.M_ONE_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.M_ONE_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.M_ONE_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    const started = Date.now();
    await expect(direct().track({ number: process.env.M_ONE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    // The reply's body never ends; the answer must not wait for it.
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);
});
