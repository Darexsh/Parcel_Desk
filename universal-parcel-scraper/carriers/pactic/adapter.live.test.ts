import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Pactic live retrieval', () => {
  it.skipIf(!process.env.PACTIC_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.PACTIC_TRACKING_NUMBER!, carrier: 'pactic' });
    expect(answer).toMatchObject({ carrier: 'pactic', source: 'pactic' });
    expect(answer.attempts[0]).toMatchObject({ source: 'pactic', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every status has a code, the page's title and a wall clock.
    expect(answer.result.events.every((event) => event.description && event.provider_code && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))))
      .toBe(true);
  }, 45_000);

  it.skipIf(!process.env.PACTIC_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.PACTIC_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.PACTIC_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    await expect(direct().track({ number: process.env.PACTIC_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
