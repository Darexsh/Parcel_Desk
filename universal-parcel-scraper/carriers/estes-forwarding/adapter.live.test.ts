import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Estes Forwarding Worldwide live retrieval', () => {
  it.skipIf(!process.env.ESTES_FORWARDING_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] })
      .track({ number: process.env.ESTES_FORWARDING_TRACKING_NUMBER!, carrier: 'estes-forwarding' });
    expect(answer).toMatchObject({ carrier: 'estes-forwarding', source: 'estes-forwarding' });
    expect(answer.attempts[0]).toMatchObject({ source: 'estes-forwarding', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every event is an instant in GMT, to the minute, with its code.
    expect(answer.result.events.every((event) => event.description && !event.local_time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.every((event) => /^[A-Z0-9]{1,8}$/.test(String(event.provider_code)))).toBe(true);
    expect(answer.result.events.some((event) => event.provider_code === 'APP' || event.provider_code === 'ETD')).toBe(false);
  }, 45_000);

  it.skipIf(!process.env.ESTES_FORWARDING_TRACKING_NUMBER)('recognizes the requested shipment', async () => {
    await expect(direct().recognize!(process.env.ESTES_FORWARDING_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.ESTES_FORWARDING_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.ESTES_FORWARDING_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
