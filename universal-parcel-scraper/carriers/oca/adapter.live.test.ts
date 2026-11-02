import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('OCA live retrieval', () => {
  it.skipIf(!process.env.OCA_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.OCA_TRACKING_NUMBER!, carrier: 'oca' });
    expect(answer).toMatchObject({ carrier: 'oca', source: 'oca' });
    expect(answer.attempts[0]).toMatchObject({ source: 'oca', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan carries Argentina's time and a branch, and its state without the branch.
    expect(answer.result.events.every((event) => event.description && !/Suc:/.test(event.description)
      && event.location && /-03:00$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.OCA_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.OCA_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.OCA_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.OCA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
