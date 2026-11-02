import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('DealerSend live retrieval', () => {
  it.skipIf(!process.env.DEALERSEND_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.DEALERSEND_TRACKING_NUMBER!, carrier: 'dealersend' });
    expect(answer).toMatchObject({ carrier: 'dealersend', source: 'dealersend' });
    expect(answer.attempts[0]).toMatchObject({ source: 'dealersend', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every row keeps its wall clock and its status; an instant Node deduces says how its zone was chosen.
    expect(answer.result.events.every((event) => event.description && event.provider_code && event.local_time
      && (!event.time || event.time_zone_basis))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.DEALERSEND_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.DEALERSEND_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.DEALERSEND_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.DEALERSEND_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
