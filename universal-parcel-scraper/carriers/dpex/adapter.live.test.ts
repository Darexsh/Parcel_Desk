import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('DPEX Worldwide live retrieval', () => {
  it.skipIf(!process.env.DPEX_TRACKING_NUMBER)('retrieves the history of the requested air waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.DPEX_TRACKING_NUMBER!, carrier: 'dpex' });
    expect(answer).toMatchObject({ carrier: 'dpex', source: 'dpex' });
    expect(answer.attempts[0]).toMatchObject({ source: 'dpex', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has wording, its event number and a clock, dated where its country keeps one zone.
    expect(answer.result.events.every((event) => event.description && event.provider_code && (event.time || event.local_time))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.DPEX_TRACKING_NUMBER)('recognizes the requested air waybill', async () => {
    await expect(direct().recognize!(process.env.DPEX_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.DPEX_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.DPEX_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
