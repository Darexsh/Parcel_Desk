import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const NUMBER = process.env.DX_TRACKING_NUMBER;
const POSTCODE = process.env.DX_POSTCODE;
const UNKNOWN = process.env.DX_UNKNOWN_NUMBER;
const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/;

describe('DX Freight live retrieval', () => {
  it.skipIf(!NUMBER || !POSTCODE)('retrieves the history of the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER!, carrier: 'dx', postcode: POSTCODE! });
    expect(answer).toMatchObject({ carrier: 'dx', source: 'dx' });
    expect(answer.attempts[0]).toMatchObject({ source: 'dx', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps the depot's wall clock without an offset.
    expect(answer.result.events.every(event => event.description && !event.time && WALL_CLOCK.test(String(event.local_time)))).toBe(true);
  }, 60_000);

  it.skipIf(!UNKNOWN || !POSTCODE)('reads an unknown number as inconclusive, as a wrong postcode is', async () => {
    await expect(direct().track({ number: UNKNOWN!, postcode: POSTCODE! })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  }, 30_000);
});
