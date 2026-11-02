import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('BEX Express live retrieval', () => {
  it.skipIf(!process.env.BEX_EXPRESS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.BEX_EXPRESS_TRACKING_NUMBER!, carrier: 'bex-express' });
    expect(answer).toMatchObject({ carrier: 'bex-express', source: 'bex-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'bex-express', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has its wording, its codes and a clock with the offset the reply states.
    expect(answer.result.events.every((event) => event.description && /^-?\d+(?::\d+)?$/.test(String(event.provider_code))
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.BEX_EXPRESS_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.BEX_EXPRESS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true, lastActivityAt: expect.any(String) });
  });

  it.skipIf(!process.env.BEX_EXPRESS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.BEX_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.BEX_EXPRESS_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
