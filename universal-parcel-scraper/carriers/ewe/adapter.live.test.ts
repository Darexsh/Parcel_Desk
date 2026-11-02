import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('EWE live retrieval', () => {
  it.skipIf(!process.env.EWE_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.EWE_TRACKING_NUMBER!, carrier: 'ewe' });
    expect(answer).toMatchObject({ carrier: 'ewe', source: 'ewe' });
    expect(answer.attempts[0]).toMatchObject({ source: 'ewe', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has wording and either an instant with its offset or a wall clock without one.
    expect(answer.result.events.every((event) => event.description
      && (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2}|Z)$/.test(String(event.time))
        || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.EWE_EMETRO_NUMBER)('retrieves an eMetro consignment through the tracking page’s lookup', async () => {
    const result = await direct().track({ number: process.env.EWE_EMETRO_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    // The trace tracker does not know eMetro consignments: the scans keep their wall clocks.
    expect(result.events!.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.EWE_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.EWE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
