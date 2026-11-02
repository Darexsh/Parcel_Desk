import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Valmo live retrieval', () => {
  it.skipIf(!process.env.VALMO_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.VALMO_TRACKING_NUMBER!, carrier: 'valmo' });
    expect(answer).toMatchObject({ carrier: 'valmo', source: 'valmo' });
    expect(answer.attempts[0]).toMatchObject({ source: 'valmo', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is an instant shown in India, with a code.
    expect(answer.result.events.every((event) => event.description && event.provider_code
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.VALMO_UNKNOWN_NUMBER)('reads an unknown tracking ID as not found', async () => {
    await expect(direct().track({ number: process.env.VALMO_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
