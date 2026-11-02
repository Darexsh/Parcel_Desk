import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('ZR Express live retrieval', () => {
  it.skipIf(!process.env.ZR_EXPRESS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.ZR_EXPRESS_TRACKING_NUMBER!, carrier: 'zr-express' });
    expect(answer).toMatchObject({ carrier: 'zr-express', source: 'zr-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'zr-express', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every step keeps its UTC instant, its wording and its state code.
    expect(answer.result.events.every((event) => event.description && event.provider_code
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.ZR_EXPRESS_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.ZR_EXPRESS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.ZR_EXPRESS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.ZR_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.ZR_EXPRESS_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
