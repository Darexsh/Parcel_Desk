import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('GIG Logistics live retrieval', () => {
  it.skipIf(!process.env.GIG_LOGISTICS_TRACKING_NUMBER)('retrieves the history of the requested waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.GIG_LOGISTICS_TRACKING_NUMBER!, carrier: 'gig-logistics' });
    expect(answer).toMatchObject({ carrier: 'gig-logistics', source: 'gig-logistics' });
    expect(answer.attempts[0]).toMatchObject({ source: 'gig-logistics', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has a code and keeps its wall clock, which the lookup dates on a deduced zone.
    expect(answer.result.events.every((event) => event.description && event.provider_code
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)) && event.time_zone)).toBe(true);
    expect(answer.result.last_update_local).toBe(answer.result.events[0]!.local_time);
  }, 45_000);

  it.skipIf(!process.env.GIG_LOGISTICS_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    await expect(direct().track({ number: process.env.GIG_LOGISTICS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
