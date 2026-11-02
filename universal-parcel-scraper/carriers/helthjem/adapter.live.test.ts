import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Helthjem live retrieval', () => {
  it.skipIf(!process.env.HELTHJEM_TRACKING_NUMBER)('retrieves the requested parcel with providers disabled', async () => {
    const number = process.env.HELTHJEM_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'helthjem' });
    expect(answer).toMatchObject({ carrier: 'helthjem', source: 'helthjem', attempts: [{ source: 'helthjem', kind: 'ok' }] });
    expect(answer.result.current_stage).toBeTruthy();
    expect(answer.result.events.every(event => event.time && event.provider_code)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.HELTHJEM_UNKNOWN_NUMBER)('reads the null parcel for an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.HELTHJEM_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.HELTHJEM_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
