import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('ZTO International live retrieval', () => {
  it.skipIf(!process.env.ZTO_INTERNATIONAL_TRACKING_NUMBER)('retrieves the history of the requested waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.ZTO_INTERNATIONAL_TRACKING_NUMBER!, carrier: 'zto-international' });
    expect(answer).toMatchObject({ carrier: 'zto-international', source: 'zto-international' });
    expect(answer.attempts[0]).toMatchObject({ source: 'zto-international', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its wall clock; the lookup dates it on a deduced zone.
    expect(answer.result.events.every((event) => event.description
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))
      && (!event.time || event.time_zone_basis))).toBe(true);
    expect(answer.result.last_update_local).toBe(answer.result.events[0]!.local_time);
    expect(answer.result.events.every((event) => event.provider_code)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.ZTO_INTERNATIONAL_TRACKING_NUMBER)('recognizes the requested waybill', async () => {
    await expect(direct().recognize!(process.env.ZTO_INTERNATIONAL_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.ZTO_INTERNATIONAL_UNKNOWN_NUMBER)('leaves an unknown number inconclusive', async () => {
    await expect(direct().track({ number: process.env.ZTO_INTERNATIONAL_UNKNOWN_NUMBER! }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  });
});
