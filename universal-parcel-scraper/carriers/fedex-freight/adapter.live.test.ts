import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('FedEx Freight live retrieval', () => {
  it.skipIf(!process.env.FEDEX_FREIGHT_TRACKING_NUMBER)('retrieves the history of the requested PRO number with providers disabled', async () => {
    const number = process.env.FEDEX_FREIGHT_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'fedex-freight' });
    expect(answer).toMatchObject({ carrier: 'fedex-freight', source: 'fedex-freight', attempts: [{ source: 'fedex-freight', kind: 'ok' }] });
    expect(answer.result.current_stage).toBeDefined();
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has a clock, its wording and its code.
    expect(answer.result.events.every(event => (event.time || event.local_time) && event.description && event.provider_code)).toBe(true);
  });

  it.skipIf(!process.env.FEDEX_FREIGHT_UNKNOWN_NUMBER)('never reads an unknown PRO number as a shipment', async () => {
    await expect(direct().track({ number: process.env.FEDEX_FREIGHT_UNKNOWN_NUMBER! }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:not_found|indeterminate)$/) });
  });
});
