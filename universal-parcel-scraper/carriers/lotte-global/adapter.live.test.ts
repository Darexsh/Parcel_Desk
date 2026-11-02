import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Lotte Global Logistics live retrieval', () => {
  it.skipIf(!process.env.LOTTE_GLOBAL_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.LOTTE_GLOBAL_TRACKING_NUMBER!, carrier: 'lotte-global' });
    expect(answer).toMatchObject({ carrier: 'lotte-global', source: 'lotte-global' });
    expect(answer.attempts[0]).toMatchObject({ source: 'lotte-global', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has its step and wording, a Seoul day or wall clock, and an instant only where the clock has a time.
    for (const event of answer.result.events) {
      expect(event.provider_code && event.description).toBeTruthy();
      expect(String(event.local_time)).toMatch(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:00)?$/);
      if (event.time) expect(Date.parse(event.time)).toBeLessThanOrEqual(Date.now());
    }
    // The courier's name and phone stay out.
    expect(JSON.stringify(answer.result.events)).not.toMatch(/배송담당|010-?\d{4}/);
  });

  it.skipIf(!process.env.LOTTE_GLOBAL_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.LOTTE_GLOBAL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
