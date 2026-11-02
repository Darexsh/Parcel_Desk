import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Consegnia live retrieval', () => {
  it.skipIf(!process.env.CONSEGNIA_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.CONSEGNIA_TRACKING_NUMBER!, carrier: 'consegnia' });
    expect(answer).toMatchObject({ carrier: 'consegnia', source: 'consegnia' });
    expect(answer.attempts[0]).toMatchObject({ source: 'consegnia', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every status has its wording and a wall clock to the minute with no zone.
    expect(answer.result.events.every((event) => event.description && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time))))
      .toBe(true);
  }, 45_000);

  it.skipIf(!process.env.CONSEGNIA_TRACKING_NUMBER)('recognizes the requested shipment', async () => {
    await expect(direct().recognize!(process.env.CONSEGNIA_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.CONSEGNIA_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.CONSEGNIA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
