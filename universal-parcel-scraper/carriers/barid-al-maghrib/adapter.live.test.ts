import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PRINTED = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}(?::\d{2})?$/;

describe('Barid Al-Maghrib live retrieval', () => {
  it.skipIf(!process.env.BARID_AL_MAGHRIB_TRACKING_NUMBER)('retrieves the requested item’s scans with providers disabled', async () => {
    const number = process.env.BARID_AL_MAGHRIB_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'barid-al-maghrib' });
    expect(answer).toMatchObject({ carrier: 'barid-al-maghrib', source: 'barid-al-maghrib', attempts: [{ source: 'barid-al-maghrib', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Each scan keeps its day and the clock as printed, never an instant.
    expect(answer.result.events.every((event) => event.description && !event.time && DAY.test(String(event.local_time))
      && (event.provider_time_text === undefined || PRINTED.test(String(event.provider_time_text))))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.BARID_AL_MAGHRIB_INBOUND_NUMBER)('retrieves the scans of mail from abroad', async () => {
    const result = await direct().track({ number: process.env.BARID_AL_MAGHRIB_INBOUND_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.destination_country).toBe('MA');
  }, 30_000);

  it.skipIf(!process.env.BARID_AL_MAGHRIB_UNKNOWN_NUMBER)('reads an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.BARID_AL_MAGHRIB_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.BARID_AL_MAGHRIB_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});
