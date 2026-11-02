import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('SGH Global Japan live retrieval', () => {
  it.skipIf(!process.env.SAGAWA_GLOBAL_TRACKING_NUMBER)('retrieves the history of the requested air waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SAGAWA_GLOBAL_TRACKING_NUMBER!, carrier: 'sagawa-global' });
    expect(answer).toMatchObject({ carrier: 'sagawa-global', source: 'sagawa-global' });
    expect(answer.attempts[0]).toMatchObject({ source: 'sagawa-global', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its station's wall clock, without an offset.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
    // Once Sagawa Express has the parcel, the page names its waybill.
    if (answer.result.delivery_carrier) {
      expect(answer.result).toMatchObject({ delivery_carrier: 'sagawa', delivery_tracking_number: expect.stringMatching(/^\d{10,12}$/) });
    }
  }, 75_000);

  it.skipIf(!process.env.SAGAWA_GLOBAL_TRACKING_NUMBER)('recognizes the requested air waybill', async () => {
    await expect(direct().recognize!(process.env.SAGAWA_GLOBAL_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.SAGAWA_GLOBAL_UNKNOWN_NUMBER)('reads an unknown air waybill as not found', async () => {
    await expect(direct().track({ number: process.env.SAGAWA_GLOBAL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
