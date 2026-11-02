import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('GO4 live retrieval', () => {
  it.skipIf(!process.env.GO4_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.GO4_TRACKING_NUMBER!, carrier: 'go4' });
    expect(answer).toMatchObject({ carrier: 'go4', source: 'go4' });
    expect(answer.attempts[0]).toMatchObject({ source: 'go4', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every milestone is dated, with the offset the reply gives or Slovak time's.
    expect(answer.result.events.every((event) => event.description && /(?:Z|[+-]\d{2}:\d{2})$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.GO4_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.GO4_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.GO4_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
