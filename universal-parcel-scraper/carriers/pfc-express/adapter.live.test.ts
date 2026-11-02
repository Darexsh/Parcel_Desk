import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('PFC Express live retrieval', () => {
  it.skipIf(!process.env.PFC_EXPRESS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.PFC_EXPRESS_TRACKING_NUMBER!, carrier: 'pfc-express' });
    expect(answer).toMatchObject({ carrier: 'pfc-express', source: 'pfc-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'pfc-express', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Scans are wall clocks to the second, without a zone.
    expect(answer.result.events.every((event) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))
      && event.time === undefined && event.description)).toBe(true);
    expect(answer.result.service_name).toBeTruthy();
  }, 45_000);

  it.skipIf(!process.env.PFC_EXPRESS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.PFC_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.PFC_EXPRESS_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});
