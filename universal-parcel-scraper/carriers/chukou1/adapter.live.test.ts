import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const NUMBER = process.env.CHUKOU1_TRACKING_NUMBER;
const UNKNOWN = process.env.CHUKOU1_UNKNOWN_NUMBER;
const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Chukou1 live retrieval', () => {
  it.skipIf(!NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER!, carrier: 'chukou1' });
    expect(answer).toMatchObject({ carrier: 'chukou1', source: 'chukou1' });
    expect(answer.attempts[0]).toMatchObject({ source: 'chukou1', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its place's wall clock, to the minute, without an offset.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
    // Chukou1's own scans put their place apart from the wording the map stages.
    expect(answer.result.events.some((event) => event.location && event.stage_source === 'carrier_map')).toBe(true);
    await expect(direct().recognize!(NUMBER!)).resolves.toMatchObject({ known: true });
  }, 60_000);

  it.skipIf(!UNKNOWN)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: UNKNOWN! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(UNKNOWN!)).resolves.toEqual({ known: false });
  }, 30_000);
});
