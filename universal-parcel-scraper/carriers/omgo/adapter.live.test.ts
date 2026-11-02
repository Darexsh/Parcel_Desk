import { describe, expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

describe('OMGO live retrieval', () => {
  it.skipIf(!process.env.OMGO_TRACKING_NUMBER)('retrieves direct matching dated history with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.OMGO_TRACKING_NUMBER! });
    expect(answer.carrier).toBe('omgo');
    expect(answer.source).toBe('omgo');
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.some(event => event.time || event.local_time)).toBe(true);
    expect(answer.attempts).toMatchObject([{ source: 'omgo', kind: 'ok' }]);
    const direct = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    await expect(direct.recognize!(process.env.OMGO_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.OMGO_UNKNOWN_NUMBER)('retains the generic unknown response as inconclusive', async () => {
    const direct = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    await expect(direct.track({ number: process.env.OMGO_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'indeterminate' });
  });
});
