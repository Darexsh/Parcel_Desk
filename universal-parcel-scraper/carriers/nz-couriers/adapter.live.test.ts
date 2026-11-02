import { describe, expect, it } from 'vitest';
import { parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('New Zealand Couriers live retrieval', () => {
  it.skipIf(!process.env.NZ_COURIERS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.NZ_COURIERS_TRACKING_NUMBER!, carrier: 'nz-couriers' });
    expect(answer).toMatchObject({ carrier: 'nz-couriers', source: 'nz-couriers' });
    expect(answer.attempts[0]).toMatchObject({ source: 'nz-couriers', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is an instant in UTC with its type as the code.
    expect(answer.result.events.every((event) => event.description && event.provider_code && !event.local_time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(String(event.time)))).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.FREIGHTWAYS_TRACKING_URL)('retrieves a customer printed label from a Freightways network link with the sender’s account', async () => {
    const link = parseTrackingInput(process.env.FREIGHTWAYS_TRACKING_URL!);
    expect(link).toMatchObject({ source: 'link', trackingUrl: expect.any(String) });
    const answer = await createTracker({ providers: [] }).track({ number: link.trackingNumber, carrier: link.carrier, trackingUrl: link.trackingUrl });
    expect(answer).toMatchObject({ carrier: link.carrier, source: link.carrier });
    expect(answer.attempts[0]).toMatchObject({ source: link.carrier, kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
  }, 30_000);

  it.skipIf(!process.env.NZ_COURIERS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.NZ_COURIERS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
