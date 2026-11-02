import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('DHL Freight live retrieval', () => {
  it.skipIf(!process.env.DHL_FREIGHT_TRACKING_NUMBER)('retrieves the history of the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [], trawlUrl: process.env.FLARESOLVERR_URL }).track({ number: process.env.DHL_FREIGHT_TRACKING_NUMBER!, carrier: 'dhl-freight' });
    expect(answer).toMatchObject({ carrier: 'dhl-freight', source: 'dhl-freight' });
    expect(answer.attempts[0]).toMatchObject({ source: 'dhl-freight', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every row keeps its terminal's wall clock or only its day, without an offset.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:00)?$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.events.some((event) => event.location)).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.DHL_FREIGHT_TRACKING_NUMBER)('recognizes the requested consignment', async () => {
    await expect(direct().recognize!(process.env.DHL_FREIGHT_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.DHL_FREIGHT_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.DHL_FREIGHT_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
