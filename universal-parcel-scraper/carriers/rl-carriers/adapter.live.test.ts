import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('R+L Carriers live retrieval', () => {
  it.skipIf(!process.env.RL_CARRIERS_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const number = process.env.RL_CARRIERS_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'rl-carriers' });
    expect(answer).toMatchObject({ carrier: 'rl-carriers', source: 'rl-carriers' });
    expect(answer.attempts[0]).toMatchObject({ source: 'rl-carriers', kind: 'ok' });
    expect(answer.result.current_stage).toBeDefined();
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Wall clocks only: R+L gives its rows no offset.
    expect(answer.result.events.every(event => event.local_time && event.time === undefined && event.description)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.RL_CARRIERS_UNKNOWN_NUMBER)('reads the tracer’s notice for an unknown PRO as not found', async () => {
    await expect(direct().track({ number: process.env.RL_CARRIERS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.RL_CARRIERS_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
