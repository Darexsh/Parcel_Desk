import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;
const WALL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

describe('APC Postal Logistics live retrieval', () => {
  it.skipIf(!process.env.APC_POSTAL_LOGISTICS_TRACKING_NUMBER)('retrieves the history of the requested parcel, APC’s scans as instants', async () => {
    const result = await direct().track({ number: process.env.APC_POSTAL_LOGISTICS_TRACKING_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.description && event.provider_code
      && (INSTANT.test(String(event.time)) || WALL.test(String(event.local_time))))).toBe(true);
    expect(result.events!.filter((event) => ['DR', '50', '911', '912'].includes(event.provider_code!))
      .every((event) => INSTANT.test(String(event.time)))).toBe(true);
    expect(result.last_status_text).toBeTruthy();
    expect(result.current_stage).toBeTruthy();
  }, 30_000);

  it.skipIf(!process.env.APC_POSTAL_LOGISTICS_TRACKING_NUMBER)('answers through the facade with providers disabled', async () => {
    const answer = await createTracker({ providers: [] })
      .track({ number: process.env.APC_POSTAL_LOGISTICS_TRACKING_NUMBER!, carrier: 'apc-postal-logistics' });
    expect(answer).toMatchObject({ carrier: 'apc-postal-logistics', source: 'apc-postal-logistics' });
    expect(answer.attempts[0]).toMatchObject({ source: 'apc-postal-logistics', kind: 'ok' });
  }, 45_000);

  it.skipIf(!process.env.APC_POSTAL_LOGISTICS_UNKNOWN_NUMBER)('reads a number the lookup has nothing for as inconclusive, not as missing', async () => {
    await expect(direct().track({ number: process.env.APC_POSTAL_LOGISTICS_UNKNOWN_NUMBER! }))
      .rejects.toMatchObject({ kind: 'indeterminate', status: 500 });
  }, 30_000);
});
