import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Dohrn Transfer live retrieval', () => {
  it.skipIf(!process.env.DOHRN_TRANSFER_TRACKING_NUMBER)('retrieves dated history for the requested PRO with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.DOHRN_TRANSFER_TRACKING_NUMBER!, carrier: 'dohrn-transfer' });
    expect(answer).toMatchObject({ carrier: 'dohrn-transfer', source: 'dohrn-transfer', attempts: [{ source: 'dohrn-transfer', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its wall clock, without an offset.
    expect(answer.result.events.every(event => event.local_time && event.description && !event.time)).toBe(true);
    expect(answer.result.events.some(event => event.stage && event.location)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.DOHRN_TRANSFER_UNKNOWN_NUMBER)('reads the trace’s answer for an unknown PRO as not found, never as history', async () => {
    await expect(direct().track({ number: process.env.DOHRN_TRANSFER_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
