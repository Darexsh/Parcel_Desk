import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('ABF Freight live retrieval', () => {
  it.skipIf(!process.env.ABF_FREIGHT_TRACKING_NUMBER)('retrieves the status of the requested shipment with providers disabled', async () => {
    const number = process.env.ABF_FREIGHT_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'abf-freight' });
    expect(answer).toMatchObject({ carrier: 'abf-freight', source: 'abf-freight' });
    expect(answer.attempts[0]).toMatchObject({ source: 'abf-freight', kind: 'ok' });
    expect(answer.result.current_stage).toBeDefined();
    expect(answer.result.last_status_text).toBeTruthy();
    expect(answer.result.events.every(event => (event.time || event.local_time) && event.description)).toBe(true);
  });

  it.skipIf(!process.env.ABF_FREIGHT_UNKNOWN_NUMBER)('reads the service’s empty answer for an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.ABF_FREIGHT_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.ABF_FREIGHT_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
