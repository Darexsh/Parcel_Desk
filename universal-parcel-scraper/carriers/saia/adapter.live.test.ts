import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Saia live retrieval', () => {
  it.skipIf(!process.env.SAIA_TRACKING_NUMBER)('retrieves the history of the requested PRO with providers disabled', async () => {
    const number = process.env.SAIA_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'saia' });
    expect(answer).toMatchObject({ carrier: 'saia', source: 'saia', attempts: [{ source: 'saia', kind: 'ok' }] });
    expect(answer.result.current_stage).toBeDefined();
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every clock is the terminal's own, without an offset.
    expect(answer.result.last_update).toBeNull();
    expect(answer.result.events.every(event => event.time === undefined && event.description && event.provider_code)).toBe(true);
    if (/^\d{11}$/.test(number)) await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.SAIA_UNKNOWN_NUMBER)('reads the service’s answer for an unknown PRO as not found', async () => {
    await expect(direct().track({ number: process.env.SAIA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.SAIA_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
