import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Boxtal live retrieval', () => {
  it.skipIf(!process.env.BOXTAL_TRACKING_NUMBER)('retrieves the history of the requested booking with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.BOXTAL_TRACKING_NUMBER!, carrier: 'boxtal' });
    expect(answer).toMatchObject({ carrier: 'boxtal', source: 'boxtal' });
    expect(answer.attempts[0]).toMatchObject({ source: 'boxtal', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is a wall clock with no offset.
    expect(answer.result.events.every((event) => event.description && event.provider_code
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.BOXTAL_TRACKING_NUMBER)('recognizes the requested booking', async () => {
    await expect(direct().recognize!(process.env.BOXTAL_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.BOXTAL_UNKNOWN_NUMBER)('reads an unknown reference as not found', async () => {
    await expect(direct().track({ number: process.env.BOXTAL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
