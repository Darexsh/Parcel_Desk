import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Total Express live retrieval', () => {
  it.skipIf(!process.env.TOTAL_EXPRESS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.TOTAL_EXPRESS_TRACKING_NUMBER!, carrier: 'total-express' });
    expect(answer).toMatchObject({ carrier: 'total-express', source: 'total-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'total-express', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its wall clock to the second, without an offset, and its status id.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)) && /^\d+$/.test(String(event.provider_code)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.TOTAL_EXPRESS_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.TOTAL_EXPRESS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.TOTAL_EXPRESS_UNKNOWN_NUMBER)('reads an unknown AWB as not found', async () => {
    await expect(direct().track({ number: process.env.TOTAL_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
