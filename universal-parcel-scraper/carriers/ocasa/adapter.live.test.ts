import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('OCASA live retrieval', () => {
  it.skipIf(!process.env.OCASA_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [], trawlUrl: process.env.FLARESOLVERR_URL }).track({ number: process.env.OCASA_TRACKING_NUMBER!, carrier: 'ocasa' });
    expect(answer).toMatchObject({ carrier: 'ocasa', source: 'ocasa', attempts: [{ source: 'ocasa', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every event keeps its wall clock, without an offset, and no place.
    expect(answer.result.events.every((event) => event.description && !event.time && event.location === undefined
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.receiver_name).toBeUndefined();
    expect(answer.result.sender_name).toBeUndefined();
  }, 30_000);

  it.skipIf(!process.env.OCASA_TRACKING_NUMBER)('recognizes the requested shipment', async () => {
    await expect(direct().recognize!(process.env.OCASA_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.OCASA_UNKNOWN_NUMBER)('reads the tracker’s notice for an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.OCASA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.OCASA_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
