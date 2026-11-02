import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('TForce Freight live retrieval', () => {
  it.skipIf(!process.env.TFORCE_FREIGHT_TRACKING_NUMBER)('retrieves the history of the requested PRO with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.TFORCE_FREIGHT_TRACKING_NUMBER!, carrier: 'tforce-freight' });
    expect(answer).toMatchObject({ carrier: 'tforce-freight', source: 'tforce-freight' });
    expect(answer.attempts[0]).toMatchObject({ source: 'tforce-freight', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its service center's wall clock, without an offset, and its city.
    expect(answer.result.events.every((event) => event.description && event.location && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.events.every((event) => event.stage)).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.TFORCE_FREIGHT_TRACKING_NUMBER)('recognizes the requested PRO', async () => {
    await expect(direct().recognize!(process.env.TFORCE_FREIGHT_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.TFORCE_FREIGHT_UNKNOWN_NUMBER)('reads an unknown PRO as not found', async () => {
    await expect(direct().track({ number: process.env.TFORCE_FREIGHT_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
