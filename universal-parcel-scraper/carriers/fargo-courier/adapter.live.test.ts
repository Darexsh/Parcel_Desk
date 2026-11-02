import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Fargo Courier live retrieval', () => {
  it.skipIf(!process.env.FARGO_COURIER_TRACKING_NUMBER)('retrieves the history of the requested waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.FARGO_COURIER_TRACKING_NUMBER!, carrier: 'fargo-courier' });
    expect(answer).toMatchObject({ carrier: 'fargo-courier', source: 'fargo-courier' });
    expect(answer.attempts[0]).toMatchObject({ source: 'fargo-courier', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is at a branch, on Nairobi's clock to the minute, with its code.
    expect(answer.result.events.every((event) => event.description && event.provider_code && /^[A-Z]{2,4}$/.test(String(event.location))
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+03:00$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.some((event) => event.stage_source === 'carrier_map')).toBe(true);
  }, 45_000);

  // The tracker answers a waybill it does not have with its error page, as it answers its own failures.
  it.skipIf(!process.env.FARGO_COURIER_UNKNOWN_NUMBER)('reads an unknown waybill as inconclusive', async () => {
    await expect(direct().track({ number: process.env.FARGO_COURIER_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'indeterminate' });
  }, 30_000);
});
