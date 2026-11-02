import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('4Sides live retrieval', () => {
  it.skipIf(!process.env.FOURSIDES_TRACKING_NUMBER)('retrieves the requested waybill’s history with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.FOURSIDES_TRACKING_NUMBER!, carrier: '4sides' });
    expect(answer).toMatchObject({ carrier: '4sides', source: '4sides' });
    expect(answer.attempts[0]).toMatchObject({ source: '4sides', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // The tracker dates its events to the day, in no zone.
    expect(answer.result.events.every((event) => event.description && event.time === undefined
      && /^\d{4}-\d{2}-\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.last_update_local).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }, 45_000);

  it.skipIf(!process.env.FOURSIDES_TRACKING_NUMBER)('recognizes the requested waybill', async () => {
    await expect(direct().recognize!(process.env.FOURSIDES_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.FOURSIDES_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    await expect(direct().track({ number: process.env.FOURSIDES_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.FOURSIDES_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
