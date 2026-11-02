import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('DPD Austria live retrieval', () => {
  it.skipIf(!process.env.DPD_AT_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.DPD_AT_TRACKING_NUMBER!, carrier: 'dpd-at' });
    expect(answer).toMatchObject({ carrier: 'dpd-at', source: 'dpd-at' });
    expect(answer.attempts[0]).toMatchObject({ source: 'dpd-at', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && event.provider_code)).toBe(true);
    // Austrian scans are read in Vienna's time; a clock elsewhere may stay local.
    expect(answer.result.events.filter((event) => String(event.location ?? '').endsWith(', AT'))
      .every((event) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+0[12]:00$/.test(String(event.time)))).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.DPD_AT_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.DPD_AT_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.DPD_AT_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.DPD_AT_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
