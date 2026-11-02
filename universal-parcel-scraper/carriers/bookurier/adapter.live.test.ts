import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Bookurier live retrieval', () => {
  it.skipIf(!process.env.BOOKURIER_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.BOOKURIER_TRACKING_NUMBER!, carrier: 'bookurier' });
    expect(answer).toMatchObject({ carrier: 'bookurier', source: 'bookurier' });
    expect(answer.attempts[0]).toMatchObject({ source: 'bookurier', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is dated in Romania.
    expect(answer.result.events.every((event) => event.description && event.provider_code
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[23]:00$/.test(String(event.time)))).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.BOOKURIER_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.BOOKURIER_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
