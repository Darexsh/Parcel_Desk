import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('FedEx Poland live retrieval', () => {
  it.skipIf(!process.env.FEDEX_PL_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.FEDEX_PL_TRACKING_NUMBER!, carrier: 'fedex-pl' });
    expect(answer).toMatchObject({ carrier: 'fedex-pl', source: 'fedex-pl' });
    expect(answer.attempts[0]).toMatchObject({ source: 'fedex-pl', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan carries the offset the service gives it, and a code.
    expect(answer.result.events.every((event) => event.description && event.provider_code
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[12]:00$/.test(String(event.time)))).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.FEDEX_PL_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.FEDEX_PL_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.FEDEX_PL_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.FEDEX_PL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
