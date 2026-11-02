import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A status's clock: Ontario's wall clock, to the minute, without an offset.
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/;

describe('Domain Logistics live retrieval', () => {
  it.skipIf(!process.env.DOMAIN_LOGISTICS_TRACKING_NUMBER)('retrieves the statuses of the requested order with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.DOMAIN_LOGISTICS_TRACKING_NUMBER!, carrier: 'domain-logistics' });
    expect(answer).toMatchObject({ carrier: 'domain-logistics', source: 'domain-logistics' });
    expect(answer.attempts[0]).toMatchObject({ source: 'domain-logistics', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && WALL_CLOCK.test(String(event.local_time)) && !event.time)).toBe(true);
    expect(answer.result.current_stage).toBeTruthy();
    expect(answer.result.service_name).toBeTruthy();
  }, 45_000);

  it.skipIf(!process.env.DOMAIN_LOGISTICS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.DOMAIN_LOGISTICS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
