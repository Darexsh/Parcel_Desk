import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('BJS Home Delivery live retrieval', () => {
  it.skipIf(!process.env.BJS_HOME_DELIVERY_TRACKING_NUMBER)('retrieves the status of the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.BJS_HOME_DELIVERY_TRACKING_NUMBER!, carrier: 'bjs-home-delivery' });
    expect(answer).toMatchObject({ carrier: 'bjs-home-delivery', source: 'bjs-home-delivery' });
    expect(answer.attempts[0]).toMatchObject({ source: 'bjs-home-delivery', kind: 'ok' });
    expect(answer.result).toMatchObject({ summary_only: true, last_update: null, expected_delivery: null });
    expect(answer.result.last_status_text).toBeTruthy();
    // The status's day stays a UK calendar day, without a time or an offset.
    expect(answer.result.events.length).toBeLessThanOrEqual(1);
    expect(answer.result.events.every((event) => !event.time && /^\d{4}-\d{2}-\d{2}$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.BJS_HOME_DELIVERY_TRACKING_NUMBER)('recognizes the requested consignment', async () => {
    await expect(direct().recognize!(process.env.BJS_HOME_DELIVERY_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.BJS_HOME_DELIVERY_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.BJS_HOME_DELIVERY_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.BJS_HOME_DELIVERY_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
