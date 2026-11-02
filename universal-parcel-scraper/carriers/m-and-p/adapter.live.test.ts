import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('M&P live retrieval', () => {
  it.skipIf(!process.env.M_AND_P_TRACKING_NUMBER)('retrieves the history of the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [], trawlUrl: process.env.FLARESOLVERR_URL }).track({ number: process.env.M_AND_P_TRACKING_NUMBER!, carrier: 'm-and-p' });
    expect(answer).toMatchObject({ carrier: 'm-and-p', source: 'm-and-p' });
    expect(answer.attempts[0]).toMatchObject({ source: 'm-and-p', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is read in Karachi time and keeps M&P's status label.
    expect(answer.result.events.every((event) => event.description && event.provider_code
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+05:00$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.every((event) => event.stage_source === 'carrier_map')).toBe(true);
  }, 60_000);

  it.skipIf(!process.env.M_AND_P_TRACKING_NUMBER)('recognizes the requested consignment', async () => {
    await expect(direct().recognize!(process.env.M_AND_P_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.M_AND_P_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.M_AND_P_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
