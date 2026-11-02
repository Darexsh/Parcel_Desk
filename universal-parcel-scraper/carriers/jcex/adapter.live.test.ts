import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('JCEX live retrieval', () => {
  it.skipIf(!process.env.JCEX_TRACKING_NUMBER)('retrieves the history of the requested waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.JCEX_TRACKING_NUMBER!, carrier: 'jcex' });
    expect(answer).toMatchObject({ carrier: 'jcex', source: 'jcex' });
    expect(answer.attempts[0]).toMatchObject({ source: 'jcex', kind: 'ok' });
    expect(answer.result.current_stage).toBeDefined();
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => (event.time || event.local_time) && event.description)).toBe(true);
  });

  it.skipIf(!process.env.JCEX_UNKNOWN_NUMBER)('reads the lookup’s answer for an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.JCEX_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
