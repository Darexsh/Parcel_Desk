import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Drop2Shop live retrieval', () => {
  it.skipIf(!process.env.DROP2SHOP_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.DROP2SHOP_TRACKING_NUMBER!, carrier: 'drop2shop' });
    expect(answer).toMatchObject({ carrier: 'drop2shop', source: 'drop2shop' });
    expect(answer.attempts[0]).toMatchObject({ source: 'drop2shop', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is dated and carries its code.
    expect(answer.result.events.every((event) => event.description && event.provider_code
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.DROP2SHOP_TRACKING_NUMBER)('names DPD Ireland and its consignment number for a parcel handed to DPD', async () => {
    const result = await direct().track({ number: process.env.DROP2SHOP_TRACKING_NUMBER! });
    expect(result).toMatchObject({ delivery_carrier: 'dpd-ie', delivery_tracking_number: expect.stringMatching(/^\d{9,10}$/) });
  }, 30_000);

  it.skipIf(!process.env.DROP2SHOP_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.DROP2SHOP_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.DROP2SHOP_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.DROP2SHOP_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
