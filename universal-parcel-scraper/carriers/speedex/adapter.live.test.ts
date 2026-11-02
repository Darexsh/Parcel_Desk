import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Speedex live retrieval', () => {
  it.skipIf(!process.env.SPEEDEX_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [], trawlUrl: process.env.FLARESOLVERR_URL }).track({ number: process.env.SPEEDEX_TRACKING_NUMBER!, carrier: 'speedex' });
    expect(answer).toMatchObject({ carrier: 'speedex', source: 'speedex' });
    expect(answer.attempts[0]).toMatchObject({ source: 'speedex', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its branch's wall clock, without an offset.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.events.some((event) => event.stage)).toBe(true);
  }, 60_000);

  it.skipIf(!process.env.SPEEDEX_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.SPEEDEX_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.SPEEDEX_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.SPEEDEX_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
