import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Mylerz live retrieval', () => {
  it.skipIf(!process.env.MYLERZ_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.MYLERZ_TRACKING_NUMBER!, carrier: 'mylerz' });
    expect(answer).toMatchObject({ carrier: 'mylerz', source: 'mylerz' });
    expect(answer.attempts[0]).toMatchObject({ source: 'mylerz', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps the reply's wall clock to the second, without an offset, and its consumer status.
    expect(answer.result.events.every((event) => event.description && !event.time && event.provider_code
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.MYLERZ_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.MYLERZ_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.MYLERZ_UNKNOWN_NUMBER)('reads an unknown barcode as not found in every country', async () => {
    await expect(direct().track({ number: process.env.MYLERZ_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
