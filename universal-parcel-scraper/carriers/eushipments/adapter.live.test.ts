import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('euShipments live retrieval', () => {
  it.skipIf(!process.env.EUSHIPMENTS_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.EUSHIPMENTS_TRACKING_NUMBER!, carrier: 'eushipments' });
    expect(answer).toMatchObject({ carrier: 'eushipments', source: 'eushipments' });
    expect(answer.attempts[0]).toMatchObject({ source: 'eushipments', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every status keeps the page's wall clock to the minute; an instant comes only with the zone it was read in.
    expect(answer.result.events.every((event) => event.description && (!event.time || event.time_zone)
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.EUSHIPMENTS_TRACKING_NUMBER)('recognizes the requested shipment', async () => {
    await expect(direct().recognize!(process.env.EUSHIPMENTS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.EUSHIPMENTS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.EUSHIPMENTS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
