import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('CBL Logística live retrieval', () => {
  it.skipIf(!process.env.CBL_LOGISTICA_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.CBL_LOGISTICA_TRACKING_NUMBER!, carrier: 'cbl-logistica' });
    expect(answer).toMatchObject({ carrier: 'cbl-logistica', source: 'cbl-logistica' });
    expect(answer.attempts[0]).toMatchObject({ source: 'cbl-logistica', kind: 'ok' });
    expect(answer.result.current_stage).toBeTruthy();
    // Every scan keeps its wall clock, without an offset.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(JSON.stringify(answer.result)).not.toMatch(/https?:|@|DNI/);
  }, 75_000);

  it.skipIf(!process.env.CBL_LOGISTICA_TRACKING_NUMBER)('recognizes the requested shipment', async () => {
    await expect(direct().recognize!(process.env.CBL_LOGISTICA_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.CBL_LOGISTICA_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.CBL_LOGISTICA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
