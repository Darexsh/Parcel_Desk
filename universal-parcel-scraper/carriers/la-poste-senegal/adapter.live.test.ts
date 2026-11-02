import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

describe('La Poste du Sénégal live retrieval', () => {
  it.skipIf(!process.env.LA_POSTE_SENEGAL_TRACKING_NUMBER)('retrieves dated scans for the requested item with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.LA_POSTE_SENEGAL_TRACKING_NUMBER!, carrier: 'la-poste-senegal' });
    expect(answer).toMatchObject({ carrier: 'la-poste-senegal', source: 'la-poste-senegal' });
    expect(answer.attempts[0]).toMatchObject({ source: 'la-poste-senegal', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its office's wall clock, without an offset, and its IPS event number.
    expect(answer.result.events.every(event => event.description && !event.time && WALL_CLOCK.test(String(event.local_time))
      && /^\d{1,4}$/.test(String(event.provider_code)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.LA_POSTE_SENEGAL_UNKNOWN_NUMBER)('reads a code without a match as not found', async () => {
    await expect(direct().track({ number: process.env.LA_POSTE_SENEGAL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
