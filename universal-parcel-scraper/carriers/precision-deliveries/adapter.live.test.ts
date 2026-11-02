import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Precision Deliveries live retrieval', () => {
  it.skipIf(!process.env.PRECISION_DELIVERIES_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] })
      .track({ number: process.env.PRECISION_DELIVERIES_TRACKING_NUMBER!, carrier: 'precision-deliveries' });
    expect(answer).toMatchObject({ carrier: 'precision-deliveries', source: 'precision-deliveries' });
    expect(answer.attempts[0]).toMatchObject({ source: 'precision-deliveries', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has a code and its wording; a physical scan carries its offset, the manifest row the page's wall clock.
    expect(answer.result.events.every((event) => event.description && event.provider_code)).toBe(true);
    expect(answer.result.events.every((event) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-0[2-8]:[03]0$/.test(String(event.time))
      || (event.time === undefined && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))))).toBe(true);
    expect(answer.result.events.some((event) => event.time)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.PRECISION_DELIVERIES_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.PRECISION_DELIVERIES_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.PRECISION_DELIVERIES_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.PRECISION_DELIVERIES_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.PRECISION_DELIVERIES_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 45_000);
});
