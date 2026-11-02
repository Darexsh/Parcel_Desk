import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Jeebly live retrieval', () => {
  it.skipIf(!process.env.JEEBLY_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.JEEBLY_TRACKING_NUMBER!, carrier: 'jeebly' });
    expect(answer).toMatchObject({ carrier: 'jeebly', source: 'jeebly' });
    expect(answer.attempts[0]).toMatchObject({ source: 'jeebly', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps the page's wall clock, without an offset, and its status name.
    expect(answer.result.events.every((event) => event.description && !event.time && event.provider_code
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.JEEBLY_TRACKING_NUMBER)('recognizes the requested shipment', async () => {
    await expect(direct().recognize!(process.env.JEEBLY_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.JEEBLY_UNKNOWN_NUMBER)('reads an unknown number as not found after asking every service', async () => {
    await expect(direct().track({ number: process.env.JEEBLY_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
