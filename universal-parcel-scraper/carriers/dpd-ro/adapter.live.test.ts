import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('DPD Romania live retrieval', () => {
  it.skipIf(!process.env.DPD_RO_TRACKING_NUMBER)('retrieves dated history for the requested waybill with providers disabled', async () => {
    const number = process.env.DPD_RO_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'dpd-ro' });
    expect(answer).toMatchObject({ carrier: 'dpd-ro', source: 'dpd-ro', attempts: [{ source: 'dpd-ro', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.time && event.provider_code)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.DPD_RO_UNKNOWN_NUMBER)('reads the not-found page for an unknown waybill as not found', async () => {
    await expect(direct().track({ number: process.env.DPD_RO_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.DPD_RO_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
