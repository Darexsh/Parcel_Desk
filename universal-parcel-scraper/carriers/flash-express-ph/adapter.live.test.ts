import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Flash Express Philippines live retrieval', () => {
  it.skipIf(!process.env.FLASH_EXPRESS_PH_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] })
      .track({ number: process.env.FLASH_EXPRESS_PH_TRACKING_NUMBER!, carrier: 'flash-express-ph' });
    expect(answer).toMatchObject({ carrier: 'flash-express-ph', source: 'flash-express-ph' });
    expect(answer.attempts[0]).toMatchObject({ source: 'flash-express-ph', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan on Manila's clock, none ahead of the read.
    expect(answer.result.events.every((event) => event.description && event.time?.endsWith('+08:00') && Date.parse(event.time) <= Date.now()))
      .toBe(true);
    expect(answer.result.events.some((event) => event.provider_code)).toBe(true);
  });

  it.skipIf(!process.env.FLASH_EXPRESS_PH_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.FLASH_EXPRESS_PH_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.FLASH_EXPRESS_PH_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.FLASH_EXPRESS_PH_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
