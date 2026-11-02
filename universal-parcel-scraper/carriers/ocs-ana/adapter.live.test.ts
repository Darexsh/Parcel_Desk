import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('OCS live retrieval', () => {
  it.skipIf(!process.env.OCS_ANA_TRACKING_NUMBER)('retrieves the history of the requested waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.OCS_ANA_TRACKING_NUMBER!, carrier: 'ocs-ana' });
    expect(answer).toMatchObject({ carrier: 'ocs-ana', source: 'ocs-ana' });
    expect(answer.attempts[0]).toMatchObject({ source: 'ocs-ana', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its wall clock: a history spans the origin country and Japan, so an instant is one deduced for its zone.
    expect(answer.result.events.every((event) => event.description && (!event.time || event.time_zone_basis)
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.events.some((event) => event.stage)).toBe(true);
    expect(answer.result.events.some((event) => event.location)).toBe(true);
    // While a Japanese delivery company holds the waybill, the lookup names it and its number.
    if (answer.result.delivery_carrier) {
      expect(answer.result).toMatchObject({ delivery_carrier: expect.stringMatching(/^(?:sagawa|yamato)$/),
        delivery_tracking_number: expect.stringMatching(/^\d{10,12}$/) });
    }
  }, 45_000);

  it.skipIf(!process.env.OCS_ANA_TRACKING_NUMBER)('recognizes the requested waybill', async () => {
    await expect(direct().recognize!(process.env.OCS_ANA_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.OCS_ANA_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    await expect(direct().track({ number: process.env.OCS_ANA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
