import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const SOFIA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[23]:00$/;

describe('Next Level live retrieval', () => {
  it.skipIf(!process.env.NEXT_LEVEL_DELIVERY_TRACKING_NUMBER)('retrieves the history of the requested waybill', async () => {
    const result = await direct().track({ number: process.env.NEXT_LEVEL_DELIVERY_TRACKING_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.description && (SOFIA.test(String(event.time)) || event.local_time))).toBe(true);
    expect(result.last_status_text).toBeTruthy();
    expect(result.current_stage).toBeTruthy();
  }, 30_000);

  it.skipIf(!process.env.NEXT_LEVEL_DELIVERY_TRACKING_NUMBER)('answers first with providers disabled', async () => {
    const answer = await createTracker({ providers: [] })
      .track({ number: process.env.NEXT_LEVEL_DELIVERY_TRACKING_NUMBER!, carrier: 'next-level-delivery' });
    expect(answer).toMatchObject({ carrier: 'next-level-delivery', source: 'next-level-delivery' });
    expect(answer.attempts[0]).toMatchObject({ source: 'next-level-delivery', kind: 'ok' });
  }, 45_000);

  it.skipIf(!process.env.NEXT_LEVEL_DELIVERY_UNKNOWN_NUMBER)('reads a waybill the tracker does not have as not found', async () => {
    await expect(direct().track({ number: process.env.NEXT_LEVEL_DELIVERY_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
