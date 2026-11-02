import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Seino live retrieval', () => {
  it.skipIf(!process.env.SEINO_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SEINO_TRACKING_NUMBER!, carrier: 'seino' });
    expect(answer).toMatchObject({ carrier: 'seino', source: 'seino' });
    expect(answer.attempts[0]).toMatchObject({ source: 'seino', kind: 'ok' });
    expect(answer.result.provider_code).toMatch(/^\d{2}$/);
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every milestone is placed on Japan's clock.
    expect(answer.result.events.every((event) => event.description
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+09:00$/.test(String(event.time)))).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.SEINO_TRACKING_NUMBER)('recognizes the requested shipment', async () => {
    await expect(direct().recognize!(process.env.SEINO_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.SEINO_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.SEINO_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
