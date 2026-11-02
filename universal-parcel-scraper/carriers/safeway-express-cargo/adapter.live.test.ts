import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Safe Way Express Cargo live retrieval', () => {
  it.skipIf(!process.env.SAFEWAY_EXPRESS_CARGO_TRACKING_NUMBER)('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SAFEWAY_EXPRESS_CARGO_TRACKING_NUMBER!, carrier: 'safeway-express-cargo' });
    expect(answer).toMatchObject({ carrier: 'safeway-express-cargo', source: 'safeway-express-cargo' });
    expect(answer.attempts[0]).toMatchObject({ source: 'safeway-express-cargo', kind: 'ok' });
    const { result } = answer;
    expect(result.summary_only).toBe(true);
    // The shipped day alone, and a delivery number only beside the partner that tracks it.
    expect(result.events.every((event) => event.description && /^\d{4}-\d{2}-\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(Boolean(result.delivery_carrier)).toBe(Boolean(result.delivery_tracking_number));
  });

  it.skipIf(!process.env.SAFEWAY_EXPRESS_CARGO_TRACKING_NUMBER)('recognizes the requested shipment', async () => {
    await expect(direct().recognize!(process.env.SAFEWAY_EXPRESS_CARGO_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.SAFEWAY_EXPRESS_CARGO_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.SAFEWAY_EXPRESS_CARGO_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
