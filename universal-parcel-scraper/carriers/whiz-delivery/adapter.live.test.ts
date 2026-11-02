import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Whiz Delivery live retrieval', () => {
  it.skipIf(!process.env.WHIZ_DELIVERY_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.WHIZ_DELIVERY_TRACKING_NUMBER!, carrier: 'whiz-delivery' });
    expect(answer).toMatchObject({ carrier: 'whiz-delivery', source: 'whiz-delivery' });
    expect(answer.attempts[0]).toMatchObject({ source: 'whiz-delivery', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every event has a status id, Whiz's wording and a UTC instant.
    expect(answer.result.events.every((event) => event.description && event.provider_code && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(event.time))))
      .toBe(true);
  }, 45_000);

  it.skipIf(!process.env.WHIZ_DELIVERY_TRACKING_NUMBER)('recognizes the requested shipment', async () => {
    await expect(direct().recognize!(process.env.WHIZ_DELIVERY_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.WHIZ_DELIVERY_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.WHIZ_DELIVERY_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
