import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('HAL Express live retrieval', () => {
  it.skipIf(!process.env.HOUNG_AH_LOUN_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.HOUNG_AH_LOUN_TRACKING_NUMBER!, carrier: 'houng-ah-loun' });
    expect(answer).toMatchObject({ carrier: 'houng-ah-loun', source: 'houng-ah-loun' });
    expect(answer.attempts[0]).toMatchObject({ source: 'houng-ah-loun', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its wall clock to the second, with its code and no staff phone number.
    expect(answer.result.events.every((event) => event.description && event.provider_code && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)) && !/ເບີໂທ|\d{8}/.test(event.description))).toBe(true);
    expect(answer.result.events.some((event) => event.stage_source === 'carrier_map')).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.HOUNG_AH_LOUN_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.HOUNG_AH_LOUN_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.HOUNG_AH_LOUN_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.HOUNG_AH_LOUN_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
