import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Maersk eCommerce live retrieval', () => {
  it.skipIf(!process.env.MAERSK_ECOMMERCE_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.MAERSK_ECOMMERCE_TRACKING_NUMBER!, carrier: 'maersk-ecommerce' });
    expect(answer).toMatchObject({ carrier: 'maersk-ecommerce', source: 'maersk-ecommerce' });
    expect(answer.attempts[0]).toMatchObject({ source: 'maersk-ecommerce', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has a code, wording and either an instant or a wall clock.
    expect(answer.result.events.every((event) => event.description && /^\d{5}$/.test(String(event.provider_code))
      && (event.time || event.local_time))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.MAERSK_ECOMMERCE_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.MAERSK_ECOMMERCE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
