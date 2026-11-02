import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
describe('Citilogistics live retrieval', () => {
  it.skipIf(!process.env.CITILOGISTICS_TRACKING_NUMBER)('reads dated history through a fresh guest session', async () => {
    const result = await direct().track({ number: process.env.CITILOGISTICS_TRACKING_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.time && event.local_time && event.time_zone_basis === 'carrier')).toBe(true);
  });
  it.skipIf(!process.env.CITILOGISTICS_UNKNOWN_NUMBER)('leaves the combined invalid-or-unavailable notice inconclusive', async () => {
    await expect(direct().track({ number: process.env.CITILOGISTICS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'indeterminate' });
  });
});
