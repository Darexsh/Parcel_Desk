import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Integral Pack live retrieval', () => {
  it.skipIf(!process.env.INTEGRAL_PACK_TRACKING_NUMBER)('retrieves the history of the requested guide with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.INTEGRAL_PACK_TRACKING_NUMBER!, carrier: 'integral-pack' });
    expect(answer).toMatchObject({ carrier: 'integral-pack', source: 'integral-pack' });
    expect(answer.attempts[0]).toMatchObject({ source: 'integral-pack', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every event keeps its wall clock to the second, without an offset.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.INTEGRAL_PACK_TRACKING_NUMBER)('recognizes the requested guide', async () => {
    await expect(direct().recognize!(process.env.INTEGRAL_PACK_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.INTEGRAL_PACK_UNKNOWN_NUMBER)('reads an unknown guide as not found', async () => {
    await expect(direct().track({ number: process.env.INTEGRAL_PACK_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
