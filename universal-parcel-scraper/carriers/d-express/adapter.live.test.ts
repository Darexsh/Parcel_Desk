import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('D Express live retrieval', () => {
  it.skipIf(!process.env.D_EXPRESS_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.D_EXPRESS_TRACKING_NUMBER!, carrier: 'd-express' });
    expect(answer).toMatchObject({ carrier: 'd-express', source: 'd-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'd-express', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan's Belgrade wall clock carries its offset.
    expect(answer.result.events.every((event) => event.description
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[12]:00$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.D_EXPRESS_TRACKING_NUMBER)('recognizes the shipment with the same lookup', async () => {
    await expect(direct().recognize!(process.env.D_EXPRESS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.D_EXPRESS_UNKNOWN_NUMBER)('reads an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.D_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.D_EXPRESS_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 45_000);
});
