import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Starlinks Global live retrieval', () => {
  it.skipIf(!process.env.STARLINKS_GLOBAL_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.STARLINKS_GLOBAL_TRACKING_NUMBER!, carrier: 'starlinks-global' });
    expect(answer).toMatchObject({ carrier: 'starlinks-global', source: 'starlinks-global' });
    expect(answer.attempts[0]).toMatchObject({ source: 'starlinks-global', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every event keeps the page's wall clock to the second; an instant comes only with the zone it was read in.
    expect(answer.result.events.every((event) => event.description && (!event.time || event.time_zone)
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.STARLINKS_GLOBAL_TRACKING_NUMBER)('recognizes the requested shipment', async () => {
    await expect(direct().recognize!(process.env.STARLINKS_GLOBAL_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.STARLINKS_GLOBAL_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.STARLINKS_GLOBAL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
