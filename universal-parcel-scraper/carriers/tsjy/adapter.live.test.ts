import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('TSJY live retrieval', () => {
  it.skipIf(!process.env.TSJY_TRACKING_NUMBER)('retrieves the history of the requested order with providers disabled', async () => {
    const number = process.env.TSJY_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'tsjy' });
    expect(answer).toMatchObject({ carrier: 'tsjy', source: 'tsjy' });
    // The line's lookup can follow the hand-off.
    expect(answer.attempts[0]).toMatchObject({ source: 'tsjy', kind: 'ok' });
    expect(answer.result.current_stage).toBeDefined();
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => (event.time || event.local_time) && event.description)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.TSJY_UNKNOWN_NUMBER)('reads the search’s empty answer for an unknown order as not found', async () => {
    await expect(direct().track({ number: process.env.TSJY_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.TSJY_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
