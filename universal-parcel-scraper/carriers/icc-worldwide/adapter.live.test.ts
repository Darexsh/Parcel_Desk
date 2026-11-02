import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('ICC Worldwide live retrieval', () => {
  it.skipIf(!process.env.ICC_WORLDWIDE_TRACKING_NUMBER)('retrieves dated history for the requested air waybill with providers disabled', async () => {
    const number = process.env.ICC_WORLDWIDE_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'icc-worldwide' });
    expect(answer).toMatchObject({ carrier: 'icc-worldwide', source: 'icc-worldwide', attempts: [{ source: 'icc-worldwide', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => (event.local_time || event.time) && event.description)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.ICC_WORLDWIDE_UNKNOWN_NUMBER)('reads the summary’s notice for an unknown air waybill as not found', async () => {
    await expect(direct().track({ number: process.env.ICC_WORLDWIDE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.ICC_WORLDWIDE_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 45_000);
});
