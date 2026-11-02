import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Tealca live retrieval', () => {
  it.skipIf(!process.env.TEALCA_TRACKING_NUMBER)('retrieves the history of the requested guía with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.TEALCA_TRACKING_NUMBER!, carrier: 'tealca' });
    expect(answer).toMatchObject({ carrier: 'tealca', source: 'tealca' });
    expect(answer.attempts[0]).toMatchObject({ source: 'tealca', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps Tealca's wall clock, without an offset, and its wording.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.events.every((event) => event.stage_source === 'carrier_map')).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.TEALCA_UNKNOWN_NUMBER)('reads an unknown guía as not found', async () => {
    await expect(direct().track({ number: process.env.TEALCA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
