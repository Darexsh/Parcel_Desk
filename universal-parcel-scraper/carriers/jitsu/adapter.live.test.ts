import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Jitsu live retrieval', () => {
  it.skipIf(!process.env.JITSU_TRACKING_NUMBER)('retrieves the history of the requested code with providers disabled', async () => {
    const number = process.env.JITSU_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'jitsu' });
    expect(answer).toMatchObject({ carrier: 'jitsu', source: 'jitsu', attempts: [{ source: 'jitsu', kind: 'ok' }] });
    expect(answer.result.current_stage).toBeDefined();
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every clock carries an offset.
    expect(answer.result.events.every(event => event.time && event.local_time === undefined && event.description && event.provider_code)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.JITSU_UNKNOWN_NUMBER)('reads the service’s answer for an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.JITSU_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.JITSU_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
