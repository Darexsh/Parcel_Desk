import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Timely Titan live retrieval', () => {
  it.skipIf(!process.env.TIMELY_TITAN_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.TIMELY_TITAN_TRACKING_NUMBER!, carrier: 'timely-titan' });
    expect(answer).toMatchObject({ carrier: 'timely-titan', source: 'timely-titan' });
    expect(answer.attempts[0]).toMatchObject({ source: 'timely-titan', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every status keeps the page's wall clock to the second; an instant comes only with the zone it was read in.
    expect(answer.result.events.every((event) => event.description && (!event.time || event.time_zone)
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.TIMELY_TITAN_TRACKING_NUMBER)('recognizes the requested shipment', async () => {
    await expect(direct().recognize!(process.env.TIMELY_TITAN_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.TIMELY_TITAN_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.TIMELY_TITAN_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
