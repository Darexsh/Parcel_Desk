import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('KEX Express Hong Kong live retrieval', () => {
  it.skipIf(!process.env.KEX_EXPRESS_HK_TRACKING_NUMBER)('retrieves the history of the requested number with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.KEX_EXPRESS_HK_TRACKING_NUMBER!, carrier: 'kex-express-hk' });
    expect(answer).toMatchObject({ carrier: 'kex-express-hk', source: 'kex-express-hk' });
    expect(answer.attempts[0]).toMatchObject({ source: 'kex-express-hk', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Calendar days only: the page gives a day and a half-day, no clock.
    expect(answer.result.events.every((event) => event.time === undefined && /^\d{4}-\d{2}-\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.events.every((event) => event.stage_source === 'carrier_map')).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.KEX_EXPRESS_HK_TRACKING_NUMBER)('recognizes the number', async () => {
    await expect(direct().recognize!(process.env.KEX_EXPRESS_HK_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.KEX_EXPRESS_HK_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.KEX_EXPRESS_HK_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
