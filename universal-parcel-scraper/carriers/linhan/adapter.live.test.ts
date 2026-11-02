import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

describe('LinHan International live retrieval', () => {
  it.skipIf(!process.env.LINHAN_TRACKING_NUMBER)('retrieves the history of the requested waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.LINHAN_TRACKING_NUMBER!, carrier: 'linhan' });
    expect(answer).toMatchObject({ carrier: 'linhan', source: 'linhan' });
    expect(answer.attempts[0]).toMatchObject({ source: 'linhan', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // LinHan's own steps in China are on Beijing time; the rows abroad keep their wall clocks.
    expect(answer.result.events.every((event) => event.description
      && (event.time ? event.time.endsWith('+08:00') : WALL_CLOCK.test(String(event.local_time))))).toBe(true);
    expect(answer.result.last_update ?? null).toBe(answer.result.events[0]!.time ?? null);
  }, 45_000);

  it.skipIf(!process.env.LINHAN_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.LINHAN_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
