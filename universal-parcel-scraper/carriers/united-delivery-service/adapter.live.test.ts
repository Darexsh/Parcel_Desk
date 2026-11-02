import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('United Delivery Service live retrieval', () => {
  it.skipIf(!process.env.UNITED_DELIVERY_SERVICE_TRACKING_NUMBER)('retrieves the status of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] })
      .track({ number: process.env.UNITED_DELIVERY_SERVICE_TRACKING_NUMBER!, carrier: 'united-delivery-service' });
    expect(answer).toMatchObject({ carrier: 'united-delivery-service', source: 'united-delivery-service',
      attempts: [{ source: 'united-delivery-service', kind: 'ok' }], result: { summary_only: true } });
    expect(answer.result.last_status_text).toBeTruthy();
    // The current step's scan, when it has one, is an instant in Chicago's offset or a wall clock.
    expect(answer.result.events.length).toBeLessThanOrEqual(1);
    expect(answer.result.events.every((event) => event.description
      && (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-0[56]:00$/.test(String(event.time)) || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))))).toBe(true);
    expect(answer.result.receiver_name).toBeUndefined();
    expect(answer.result.sender_name).toBeUndefined();
  }, 30_000);

  it.skipIf(!process.env.UNITED_DELIVERY_SERVICE_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.UNITED_DELIVERY_SERVICE_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.UNITED_DELIVERY_SERVICE_UNKNOWN_NUMBER)('reads the tracker’s notice for an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.UNITED_DELIVERY_SERVICE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.UNITED_DELIVERY_SERVICE_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
