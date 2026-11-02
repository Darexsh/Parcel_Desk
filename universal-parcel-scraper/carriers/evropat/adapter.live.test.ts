import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const SOFIA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[23]:00$/;

describe('Evropat live retrieval', () => {
  it.skipIf(!process.env.EVROPAT_TRACKING_NUMBER)('retrieves the history of the requested waybill on Sofia time', async () => {
    const result = await direct().track({ number: process.env.EVROPAT_TRACKING_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.description && (SOFIA.test(String(event.time)) || event.local_time))).toBe(true);
    expect(result.last_status_text).toBeTruthy();
    expect(result.current_stage).toBeTruthy();
  }, 30_000);

  it.skipIf(!process.env.EVROPAT_TRACKING_NUMBER)('answers first with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.EVROPAT_TRACKING_NUMBER!, carrier: 'evropat' });
    expect(answer).toMatchObject({ carrier: 'evropat', source: 'evropat' });
    expect(answer.attempts[0]).toMatchObject({ source: 'evropat', kind: 'ok' });
  }, 45_000);

  it.skipIf(!process.env.EVROPAT_UNKNOWN_NUMBER)('reads a waybill the lookup does not have as not found', async () => {
    await expect(direct().track({ number: process.env.EVROPAT_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
