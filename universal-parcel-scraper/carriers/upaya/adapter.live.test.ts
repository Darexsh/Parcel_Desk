import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Upaya live retrieval', () => {
  it.skipIf(!process.env.UPAYA_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.UPAYA_TRACKING_NUMBER!, carrier: 'upaya' });
    expect(answer).toMatchObject({ carrier: 'upaya', source: 'upaya' });
    expect(answer.attempts[0]).toMatchObject({ source: 'upaya', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is an instant on Nepal's clock.
    expect(answer.result.events.every((event) => event.description
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?\+05:45$/.test(String(event.time)) && !event.local_time)).toBe(true);
    expect(answer.result.last_update).toBe(answer.result.events[0]!.time);
  }, 45_000);

  it.skipIf(!process.env.UPAYA_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.UPAYA_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.UPAYA_UNKNOWN_NUMBER)('reads an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.UPAYA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
