import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('ACS Courier live retrieval', () => {
  it.skipIf(!process.env.ACS_COURIER_TRACKING_NUMBER)('retrieves wall-clock history for the requested parcel with providers disabled', async () => {
    const number = process.env.ACS_COURIER_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'acs-courier' });
    expect(answer).toMatchObject({ carrier: 'acs-courier', source: 'acs-courier', attempts: [{ source: 'acs-courier', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.time === undefined
      && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/.test(String(event.local_time)))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.ACS_COURIER_UNKNOWN_NUMBER)('reads the reply for an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.ACS_COURIER_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.ACS_COURIER_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
