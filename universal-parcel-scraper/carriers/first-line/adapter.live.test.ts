import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('FIRST LINE live retrieval', () => {
  it.skipIf(!process.env.FIRST_LINE_TRACKING_NUMBER)('retrieves the history of the requested waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.FIRST_LINE_TRACKING_NUMBER!, carrier: 'first-line' });
    expect(answer).toMatchObject({ carrier: 'first-line', source: 'first-line' });
    expect(answer.attempts[0]).toMatchObject({ source: 'first-line', kind: 'ok' });
    expect(answer.result.current_stage).toBeDefined();
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.local_time && event.description)).toBe(true);
  });

  it.skipIf(!process.env.FIRST_LINE_UNKNOWN_NUMBER)('reads the lookup’s answer for an unknown number as the tracker not knowing it', async () => {
    await expect(direct().track({ number: process.env.FIRST_LINE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  });
});
