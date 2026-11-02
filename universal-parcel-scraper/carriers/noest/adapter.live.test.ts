import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('NOEST live retrieval', () => {
  it.skipIf(!process.env.NOEST_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.NOEST_TRACKING_NUMBER!, carrier: 'noest' });
    expect(answer).toMatchObject({ carrier: 'noest', source: 'noest' });
    expect(answer.attempts[0]).toMatchObject({ source: 'noest', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every event keeps its wording and Algeria's offset.
    expect(answer.result.events.every((event) => event.description && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+01:00$/.test(String(event.time))))
      .toBe(true);
  }, 45_000);

  it.skipIf(!process.env.NOEST_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.NOEST_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.NOEST_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.NOEST_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
