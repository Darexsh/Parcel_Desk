import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Logisimple live retrieval', () => {
  it.skipIf(!process.env.LOGISIMPLE_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.LOGISIMPLE_TRACKING_NUMBER!, carrier: 'logisimple' });
    expect(answer).toMatchObject({ carrier: 'logisimple', source: 'logisimple' });
    expect(answer.attempts[0]).toMatchObject({ source: 'logisimple', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps the page's wall clock; an instant comes only with the zone it was read in.
    expect(answer.result.events.every((event) => event.description && (!event.time || event.time_zone)
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
    // The proof of delivery's recipient is never read.
    expect(JSON.stringify(answer.result)).not.toMatch(/Recebido/);
  }, 45_000);

  it.skipIf(!process.env.LOGISIMPLE_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.LOGISIMPLE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
