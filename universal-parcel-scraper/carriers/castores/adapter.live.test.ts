import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Castores live retrieval', () => {
  it.skipIf(!process.env.CASTORES_TRACKING_NUMBER)('retrieves dated history for the requested talón with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.CASTORES_TRACKING_NUMBER!, carrier: 'castores' });
    expect(answer).toMatchObject({ carrier: 'castores', source: 'castores', attempts: [{ source: 'castores', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every row keeps its branch's wall clock, without an offset, and a stage the map gives it.
    expect(answer.result.events.every((event) => event.description && !event.time && event.stage_source === 'carrier_map'
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.CASTORES_UNKNOWN_NUMBER)('reads the notice for an unknown talón as not found', async () => {
    await expect(direct().track({ number: process.env.CASTORES_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
