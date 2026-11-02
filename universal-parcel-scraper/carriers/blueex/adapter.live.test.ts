import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('BlueEX live retrieval', () => {
  it.skipIf(!process.env.BLUEEX_TRACKING_NUMBER)('retrieves the history of the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.BLUEEX_TRACKING_NUMBER!, carrier: 'blueex' });
    expect(answer).toMatchObject({ carrier: 'blueex', source: 'blueex' });
    expect(answer.attempts[0]).toMatchObject({ source: 'blueex', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is read in Karachi time.
    expect(answer.result.events.every((event) => event.description && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+05:00$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.every((event) => event.stage_source === 'carrier_map')).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.BLUEEX_TRACKING_NUMBER)('recognizes the consignment', async () => {
    await expect(direct().recognize!(process.env.BLUEEX_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.BLUEEX_UNKNOWN_NUMBER)('reads a number the tracker holds no scans for as inconclusive', async () => {
    await expect(direct().track({ number: process.env.BLUEEX_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'indeterminate', name: 'NoHistoryError' });
    await expect(direct().recognize!(process.env.BLUEEX_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'indeterminate' });
  }, 45_000);
});
